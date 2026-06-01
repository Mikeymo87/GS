# Monetization — locked spec

This is the agreed monetization model for the Gun Show Deal Finder app. It captures the
decisions so they survive context resets. Dollar figures are launch targets and may be tuned;
the **mechanics** (subscription + included credits + non-expiring top-ups, credit ledger,
RevenueCat-driven refills) are the locked design.

## Model: subscription + included credits + top-ups

Users pay a monthly subscription that includes a bucket of **credits**. Credits are spent per
lookup. When the monthly bucket runs out, users buy **top-up packs** (consumable, never expire).
A higher **Pro / Vendor** tier exists for heavy users (table-scanning vendors, GunBroker snipers)
so that heavy usage becomes our best revenue instead of a margin liability.

### Tiers

| | Free | Enthusiast | Pro / Vendor |
|---|---|---|---|
| Price | $0 | ~$9.99/mo | ~$24.99/mo |
| Included credits | 3 (one-time) | ~40 / mo | ~150 / mo |
| Deep dive | — | ✅ | ✅ |
| Top-ups | — | ✅ | ✅ |

### Credit costs

| Action | Credits |
|---|---|
| Fast lookup (`/api/analyze`, default) | 1 |
| Deep dive (`deep:true`, 3 agents) | 4 |
| On-demand reviews (`/api/reviews`) | 2 |
| Chat (`/api/chat`) | 0 (free) |
| Re-identify (`/api/identify`) | 0 (free) |
| Refine (`/api/refine`) | 0 (free) |

Chat / identify / refine are free because they run on `LIGHT_MODEL` (Haiku) and are cheap. The Sonnet
pricing/quality brain costs credits: Fast (1) and Deep (4). On-demand reviews runs the Gun Guru alone
(Sonnet + web search) so it costs 2. All costs live in one place (`CREDIT_COSTS` in `lib/billing.js`,
each overridable via `COST_FAST` / `COST_DEEP` / `COST_REVIEWS`) so they're easy to re-tune.

### Top-up packs (consumable IAP)

- ~50 credits / $9.99
- ~150 credits / $24.99
- Purchased credits **never expire**. Bought in seconds when balance hits zero mid-show.

## Rules

- **Margin rule:** price each credit so it nets ~2× its underlying API cost after the store's cut
  (Apple/Google ~15–30%). Re-derive credit costs if the Sonnet price or `MAX_SEARCHES` /
  `THINK_BUDGET` defaults change materially.
- **Expiry:** monthly included credits are use-it-or-lose-it (reset each billing cycle). Purchased
  top-up credits never expire — cleaner legally and better UX.
- **Spend order:** debit monthly included credits first, then purchased top-up credits (so the
  perishable bucket is used before the permanent one).
- **Abuse guard:** the 3 free credits bind to Apple ID / Play / device identity, not just email, to
  stop new-account farming.
- **Deep dive confirm:** because Deep costs 4, the client shows a "this Deep dive costs 4 credits"
  confirm before spending.

## Backend implications (Part B)

The previously-sketched single `usage` row becomes a **credit ledger**:

- `credits_balance` (or split `monthly_balance` + `topup_balance`) per user.
- A **transactions log**: grants (subscription refill, top-up purchase) and debits (per lookup),
  each with type, amount, balance-after, and source (lookup id / purchase id).
- **RevenueCat webhook** is the source of truth for entitlements: on renewal it refills the monthly
  bucket; on a top-up purchase it credits the top-up balance. Idempotent on the purchase/event id.
- Endpoints (`/api/analyze`, `/api/analyze/stream`) gate on balance: check → reserve/debit → run.
  On insufficient balance return **HTTP 402 `insufficient_credits`**.
- Client turns `402 insufficient_credits` into a **top-up sheet** (not a hard wall), pre-selecting a
  pack and showing current balance + the cost of the action they attempted.

## Build order (high level)

1. Supabase auth (identity + session).
2. Credit-ledger schema (balance + transactions) and debit/grant helpers.
3. Metering gates on `/api/analyze` + `/api/analyze/stream` (402 on empty).
4. RevenueCat integration + webhook (refills, top-ups, idempotency).
5. Capacitor wrap for iOS/Android; store IAP product setup.
6. App Review submission.

Web PWA can ship first with Stripe for subscriptions/top-ups; iOS/Android use store IAP via
RevenueCat. The ledger and 402 flow are shared across both.

## Implementation status

**Done (steps 1–3, backend):**
- `db/schema.sql` — `profiles` (two buckets: `monthly_credits`, `topup_credits`) + append-only
  `credit_ledger`, with RLS and the RPC functions: `ensure_profile`, `credits_balance`,
  `spend_credits` (monthly-first, then topup, atomic), `grant_credits` (idempotent on
  `(user, kind, ref)`), `reset_monthly` (subscription renewal).
- `lib/billing.js` — dependency-free: local HS256 verification of the Supabase access token
  (`node:crypto`), PostgREST RPC over `fetch` with the service-role key, and `openGate(req, action)`
  — the metering gate. Debits up front and returns a `refund()` the endpoint calls on failure.
- `server.js` — gates on `/api/analyze`, `/api/analyze/stream` (SSE error), and `/api/reviews`;
  refunds on error and on stream abort. New `GET /api/credits` (balance + pricing). `/api/health`
  reports `billing`. Successful responses carry `credits: { balance, charged }`.

**Done (step 4, RevenueCat webhook):**
- `POST /api/webhooks/revenuecat` — authenticated by the dashboard shared secret sent as
  `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>` (timing-safe compare; unset secret ⇒ every
  call 401s). Body is `{ api_version, event }`. Idempotent on `event.id`.
- Event mapping (`handleWebhookEvent` in `lib/billing.js`): `NON_RENEWING_PURCHASE` → top-up grant;
  `INITIAL_PURCHASE` / `RENEWAL` / `PRODUCT_CHANGE` / `UNCANCELLATION` / `SUBSCRIPTION_EXTENDED` →
  `reset_monthly` to the tier allotment; `EXPIRATION` → monthly 0 + tier `free` (purchased top-ups
  untouched); `CANCELLATION` / `BILLING_ISSUE` / `SUBSCRIPTION_PAUSED` → no-op (access persists to
  expiration); `TEST` → 200.
- `app_user_id` **must** be the Supabase user UUID — the client calls `Purchases.logIn(supabaseUserId)`.
  Non-UUID / unknown users are acked `200` (no retry); Supabase infra errors return `500` (retry).
- Product→grant map is configurable via `RC_PRODUCT_MAP` (JSON keyed by store `product_id`); the
  defaults are placeholders aligned with the tiers above — set them to your real store identifiers.

**AI-API safety:** in billing mode `clientFor` ignores any client-supplied `x-anthropic-key` and uses
only the server key, so the credit ledger is the sole gate — a request can't run on a foreign key
while we debit credits, and BYO-key can't bypass metering. (BYO-key still works when billing is off.)
The "free" endpoints (`/api/identify`, `/api/chat`, `/api/refine`) also require a signed-in user in
billing mode (gated via `openGate(req,"free")`, 0 credits) so the server key can't be used anonymously.

**Done (step 5, client — auth + credits UI):**
- `GET /api/config` — client-safe runtime config: `{ billing, supabaseUrl, supabaseAnonKey, costs,
  freeCredits, packs }`. The app calls it on load to pick BYO-key vs billing mode.
- `public/auth.js` — dependency-free Supabase email/password auth over the auth REST API: session
  persistence in `localStorage`, proactive token refresh, `Auth.accessToken()` / `signIn` / `signUp` /
  `signOut` / `refreshBalance` / `onChange`. Inert when billing is off.
- `public/app.js` — sends `Authorization: Bearer` in billing mode (instead of `x-anthropic-key`);
  credits chip in the header; sign-in / account / top-up sheets; `402 insufficient_credits` → top-up
  sheet, `401` → sign-in; balance updates from each response's `credits.balance`; requires sign-in
  before a run. `index.html` / `styles.css` add the modals + chip; `sw.js` cache bumped to v9.
- The top-up sheet renders `packs` but the **Buy button is a placeholder** — it needs the payment
  provider (Stripe on web / RevenueCat IAP in the app), which is the next step.

Extra env: `SUPABASE_ANON_KEY` (public; sent to the client), `RC_TOPUP_PACKS` (JSON, display only).

**Off by default.** Billing activates only when `BILLING_ENABLED` is truthy AND `SUPABASE_URL` +
`SUPABASE_SERVICE_KEY` + `SUPABASE_JWT_SECRET` are set. Otherwise every gate is a no-op and the
existing BYO-Anthropic-key flow is unchanged. When the ledger is unreachable the gate **fails
closed** (503) rather than giving away paid work.

Env (server-only): `BILLING_ENABLED`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`,
`FREE_CREDITS` (default 3), `COST_FAST` / `COST_DEEP` / `COST_REVIEWS`, `REVENUECAT_WEBHOOK_SECRET`,
`RC_PRODUCT_MAP` (JSON).

**Client contract:** when billing is on, the app sends the Supabase access token as
`Authorization: Bearer <jwt>`; on `402 insufficient_credits` (or SSE `{t:"error", error:"insufficient_credits"}`)
it shows the top-up sheet using the returned `balance` + `cost`.

**Not yet (later steps):** wiring the top-up/subscription **purchase** flow to a payment provider
(Stripe Checkout on web; RevenueCat IAP + `Purchases.logIn(supabaseUserId)` in the app — `buyPack()`
in `app.js` is the placeholder hook), then the Capacitor wrap + App Review.
