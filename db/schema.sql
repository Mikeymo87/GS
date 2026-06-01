-- Gun Show Deal Finder — credit-ledger schema (Part B)
-- Apply in the Supabase SQL editor (or `supabase db push`). Idempotent: safe to re-run.
--
-- Design (see MONETIZATION.md):
--   * Two credit buckets per user:
--       monthly_credits — included with the subscription, use-it-or-lose-it (reset each cycle)
--       topup_credits   — purchased packs + the 3 one-time free credits, NEVER expire
--   * Spend order: monthly first, then topup (perishable bucket drains before the permanent one).
--   * credit_ledger is the append-only audit log of every grant and debit.
-- The server talks to these via the RPC functions below using the service-role key.

-- ---------- tables ----------
create table if not exists public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  email            text,
  tier             text        not null default 'free',   -- free | enthusiast | pro
  monthly_credits  integer     not null default 0,
  topup_credits    integer     not null default 0,
  monthly_reset_at timestamptz,
  free_granted     boolean     not null default false,    -- the one-time 3 free credits
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint monthly_credits_nonneg check (monthly_credits >= 0),
  constraint topup_credits_nonneg   check (topup_credits   >= 0)
);

create table if not exists public.credit_ledger (
  id            bigint generated always as identity primary key,
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  kind          text        not null,            -- debit | monthly | topup | refund | free
  amount        integer     not null,            -- signed: grants > 0, debits < 0
  action        text,                            -- fast | deep | reviews | grant | ...
  ref           text,                            -- lookup id / purchase id / event id (idempotency)
  balance_after integer     not null,
  created_at    timestamptz not null default now()
);

create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);
-- Idempotency for webhook-driven grants: a given (user, kind, ref) lands at most once.
create unique index if not exists credit_ledger_grant_ref_idx
  on public.credit_ledger (user_id, kind, ref)
  where ref is not null and kind in ('monthly', 'topup');

-- ---------- RLS (service role bypasses these; they guard direct anon/auth access) ----------
alter table public.profiles      enable row level security;
alter table public.credit_ledger enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "own ledger read" on public.credit_ledger;
create policy "own ledger read" on public.credit_ledger
  for select using (auth.uid() = user_id);

-- ---------- functions (SECURITY DEFINER so the server can call via service role) ----------

-- Ensure a profile exists; grant the one-time free credits exactly once (into the topup bucket
-- so they never expire). Returns the current total balance.
create or replace function public.ensure_profile(p_user uuid, p_email text, p_free integer)
returns json language plpgsql security definer set search_path = public as $$
declare bal integer;
begin
  insert into public.profiles (id, email, topup_credits, free_granted)
  values (p_user, p_email, greatest(coalesce(p_free, 0), 0), true)
  on conflict (id) do update set email = coalesce(excluded.email, public.profiles.email),
                                 updated_at = now();
  -- If a row predates the free grant, top it up once.
  update public.profiles
     set topup_credits = topup_credits + greatest(coalesce(p_free, 0), 0),
         free_granted  = true,
         updated_at    = now()
   where id = p_user and free_granted = false;
  if greatest(coalesce(p_free, 0), 0) > 0 then
    insert into public.credit_ledger (user_id, kind, amount, action, ref, balance_after)
    select p_user, 'free', greatest(coalesce(p_free, 0), 0), 'grant', 'signup',
           monthly_credits + topup_credits
      from public.profiles where id = p_user
    on conflict do nothing;
  end if;
  select monthly_credits + topup_credits into bal from public.profiles where id = p_user;
  return json_build_object('ok', true, 'balance', bal);
end; $$;

-- Total balance for a user.
create or replace function public.credits_balance(p_user uuid)
returns integer language sql security definer set search_path = public as $$
  select coalesce(monthly_credits + topup_credits, 0) from public.profiles where id = p_user;
$$;

-- Atomically spend credits (monthly first, then topup). Returns {ok, balance, ...}.
-- ok=false with reason 'insufficient' when the balance can't cover the amount.
create or replace function public.spend_credits(p_user uuid, p_amount integer, p_action text, p_ref text)
returns json language plpgsql security definer set search_path = public as $$
declare m integer; t integer; from_m integer; from_t integer; new_bal integer;
begin
  if coalesce(p_amount, 0) <= 0 then
    return json_build_object('ok', true, 'balance', public.credits_balance(p_user), 'charged', 0);
  end if;
  select monthly_credits, topup_credits into m, t from public.profiles where id = p_user for update;
  if not found then
    return json_build_object('ok', false, 'reason', 'no_profile', 'balance', 0);
  end if;
  if (m + t) < p_amount then
    return json_build_object('ok', false, 'reason', 'insufficient', 'balance', m + t);
  end if;
  from_m := least(m, p_amount);
  from_t := p_amount - from_m;
  new_bal := (m + t) - p_amount;
  update public.profiles
     set monthly_credits = monthly_credits - from_m,
         topup_credits   = topup_credits   - from_t,
         updated_at      = now()
   where id = p_user;
  insert into public.credit_ledger (user_id, kind, amount, action, ref, balance_after)
  values (p_user, 'debit', -p_amount, p_action, p_ref, new_bal);
  return json_build_object('ok', true, 'balance', new_bal, 'charged', p_amount,
                           'from_monthly', from_m, 'from_topup', from_t);
end; $$;

-- Add credits to a bucket ('topup' for purchases/refunds, 'monthly' to top up the included bucket).
-- Idempotent on (user, kind, ref) for webhook safety. Returns {ok, balance, applied}.
create or replace function public.grant_credits(p_user uuid, p_amount integer, p_bucket text, p_action text, p_ref text)
returns json language plpgsql security definer set search_path = public as $$
declare new_bal integer; did boolean := true;
begin
  if p_ref is not null and exists (
    select 1 from public.credit_ledger
     where user_id = p_user and kind = p_bucket and ref = p_ref
  ) then
    return json_build_object('ok', true, 'balance', public.credits_balance(p_user), 'applied', false);
  end if;
  if p_bucket = 'monthly' then
    update public.profiles set monthly_credits = monthly_credits + greatest(coalesce(p_amount,0),0), updated_at = now() where id = p_user;
  else
    update public.profiles set topup_credits = topup_credits + greatest(coalesce(p_amount,0),0), updated_at = now() where id = p_user;
  end if;
  if not found then did := false; end if;
  select monthly_credits + topup_credits into new_bal from public.profiles where id = p_user;
  insert into public.credit_ledger (user_id, kind, amount, action, ref, balance_after)
  values (p_user, p_bucket, greatest(coalesce(p_amount,0),0), coalesce(p_action,'grant'), p_ref, coalesce(new_bal,0));
  return json_build_object('ok', did, 'balance', coalesce(new_bal,0), 'applied', did);
end; $$;

-- Reset the monthly bucket to a tier's allotment (use-it-or-lose-it). Called on subscription
-- renewal/purchase. Sets the bucket (does not add) and stamps the next reset. Idempotent on
-- (user, 'monthly', p_ref) so replayed webhook deliveries are harmless. Returns {ok, balance, applied}.
drop function if exists public.reset_monthly(uuid, integer, text);
create or replace function public.reset_monthly(p_user uuid, p_amount integer, p_tier text, p_ref text)
returns json language plpgsql security definer set search_path = public as $$
declare new_bal integer;
begin
  if p_ref is not null and exists (
    select 1 from public.credit_ledger
     where user_id = p_user and kind = 'monthly' and ref = p_ref
  ) then
    return json_build_object('ok', true, 'balance', public.credits_balance(p_user), 'applied', false);
  end if;
  update public.profiles
     set monthly_credits  = greatest(coalesce(p_amount, 0), 0),
         tier             = coalesce(p_tier, tier),
         monthly_reset_at = now() + interval '1 month',
         updated_at       = now()
   where id = p_user;
  if not found then
    return json_build_object('ok', false, 'reason', 'no_profile', 'balance', 0, 'applied', false);
  end if;
  select monthly_credits + topup_credits into new_bal from public.profiles where id = p_user;
  insert into public.credit_ledger (user_id, kind, amount, action, ref, balance_after)
  values (p_user, 'monthly', greatest(coalesce(p_amount,0),0), 'reset', p_ref, coalesce(new_bal,0));
  return json_build_object('ok', true, 'balance', coalesce(new_bal,0), 'applied', true);
end; $$;
