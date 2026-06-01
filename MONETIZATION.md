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
| Chat (`/api/chat`) | 0 (free) |
| Re-identify (`/api/identify`) | 0 (free) |
| Refine (`/api/refine`) | 0 (free) |

Chat / identify / refine are free because they run on `LIGHT_MODEL` (Haiku) and are cheap. Only the
Sonnet pricing/quality brain (Fast and Deep) costs credits.

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
