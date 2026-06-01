-- Credit-ledger smoke test — exercises every RPC and asserts the results.
--
-- SAFE: the whole thing runs in a transaction that ROLLS BACK at the end, so it does NOT change
-- any real balance or leave ledger rows behind. It works against your most-recent auth user
-- (no editing needed); create at least one user first (sign up once in the app).
--
-- Run in the Supabase SQL editor (paste the whole file) or:  psql "$DB_URL" -f db/seed_smoke.sql
-- Expect it to finish with:  NOTICE:  ✅ ALL ASSERTIONS PASSED   and then ROLLBACK.
-- Any failure raises an EXCEPTION (which also aborts/rolls back the transaction).

begin;

do $$
declare
  v_user uuid;
  v json;
  bal int;
begin
  select id into v_user from auth.users order by created_at desc limit 1;
  if v_user is null then
    raise exception 'No auth user found — sign up once in the app, then re-run.';
  end if;
  raise notice 'Testing against user %', v_user;

  -- Clean slate for this user (rolled back at the end).
  delete from public.credit_ledger where user_id = v_user;
  delete from public.profiles      where id = v_user;

  -- 1) ensure_profile grants the 3 free credits exactly once.
  v := public.ensure_profile(v_user, 'smoke@test.local', 3);
  if (v->>'balance')::int <> 3 then raise exception '1 ensure_profile: expected 3, got %', v; end if;
  v := public.ensure_profile(v_user, 'smoke@test.local', 3);  -- second call must NOT re-grant
  if (v->>'balance')::int <> 3 then raise exception '1 ensure_profile idempotent: expected 3, got %', v; end if;
  raise notice '  ✓ ensure_profile -> balance 3 (free granted once)';

  -- 2) spend debits, monthly-first (here only topup exists).
  v := public.spend_credits(v_user, 1, 'fast', null);
  if (v->>'ok')::boolean is not true or (v->>'balance')::int <> 2 then raise exception '2 spend1: %', v; end if;
  v := public.spend_credits(v_user, 2, 'fast', null);
  if (v->>'balance')::int <> 0 then raise exception '2 spend2: %', v; end if;
  raise notice '  ✓ spend_credits -> drained free credits to 0';

  -- 3) spend at zero -> insufficient (this is what surfaces as HTTP 402).
  v := public.spend_credits(v_user, 1, 'fast', null);
  if (v->>'ok')::boolean is not false or (v->>'reason') <> 'insufficient' then raise exception '3 insufficient: %', v; end if;
  raise notice '  ✓ spend at zero -> ok:false reason:insufficient (= HTTP 402)';

  -- 4) top-up grant is idempotent on (user, kind, ref).
  v := public.grant_credits(v_user, 50, 'topup', 'purchase', 'rc_topup_1');
  if (v->>'balance')::int <> 50 or (v->>'applied')::boolean is not true then raise exception '4 grant: %', v; end if;
  v := public.grant_credits(v_user, 50, 'topup', 'purchase', 'rc_topup_1');  -- replay
  if (v->>'balance')::int <> 50 or (v->>'applied')::boolean is not false then raise exception '4 grant replay not idempotent: %', v; end if;
  raise notice '  ✓ grant_credits topup +50, replay of same ref is a no-op (idempotent)';

  -- 5) monthly reset is idempotent on event id; balance = monthly + topup.
  v := public.reset_monthly(v_user, 40, 'enthusiast', 'rc_renew_1');
  if (v->>'balance')::int <> 90 or (v->>'applied')::boolean is not true then raise exception '5 reset: %', v; end if;
  v := public.reset_monthly(v_user, 40, 'enthusiast', 'rc_renew_1');  -- replay
  if (v->>'balance')::int <> 90 or (v->>'applied')::boolean is not false then raise exception '5 reset replay not idempotent: %', v; end if;
  raise notice '  ✓ reset_monthly -> 40 monthly (+50 topup = 90), replay idempotent';

  -- 6) spend crosses buckets: monthly drains BEFORE topup.
  v := public.spend_credits(v_user, 45, 'deep', null);
  if (v->>'from_monthly')::int <> 40 or (v->>'from_topup')::int <> 5 or (v->>'balance')::int <> 45 then
    raise exception '6 spend order wrong: %', v;
  end if;
  raise notice '  ✓ spend 45 -> 40 from monthly THEN 5 from topup, balance 45';

  -- 7) expiration zeroes monthly but PRESERVES purchased top-ups.
  v := public.reset_monthly(v_user, 0, 'free', 'rc_expire_1');
  if (v->>'balance')::int <> 45 then raise exception '7 expiration balance: %', v; end if;
  select topup_credits into bal from public.profiles where id = v_user;
  if bal <> 45 then raise exception '7 expiration must keep topups, got topup=%', bal; end if;
  raise notice '  ✓ expiration -> monthly 0, topups preserved (balance 45)';

  -- 8) balance helper agrees, and the ledger recorded every move.
  if public.credits_balance(v_user) <> 45 then raise exception '8 credits_balance mismatch'; end if;
  select count(*) into bal from public.credit_ledger where user_id = v_user;
  raise notice '  ✓ credits_balance agrees; % ledger rows written', bal;

  raise notice '✅ ALL ASSERTIONS PASSED (rolling back — no real data changed)';
end $$;

rollback;
