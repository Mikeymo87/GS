# Billing backend — validation runbook

Run this on your deploy (or locally with the real env set) to verify the credit layer end-to-end
before we build the client. Two parts: a **pure-SQL self-test** of the ledger, then a **live HTTP +
webhook check** of the server↔Supabase↔RevenueCat path.

> The SQL layer (`schema.sql` + `seed_smoke.sql`) has already been validated against Postgres 16 — the
> self-test passes every assertion. What only your deploy can prove is the network wiring: the
> server reaching Supabase PostgREST, a real Anthropic call debiting a credit, and a real webhook.

## 0. Prereqs
- Applied `db/schema.sql` in Supabase (safe to re-run).
- Server env set: `BILLING_ENABLED=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`,
  `ANTHROPIC_API_KEY`, `REVENUECAT_WEBHOOK_SECRET`, and `RC_PRODUCT_MAP` matching your store products.
- At least one signed-up user (sign up once in the app).

```bash
export BASE=https://your-deploy.example.com          # or http://localhost:3000
export SUPABASE_URL=https://<ref>.supabase.co
export ANON=<supabase anon key>
export RC_SECRET=<your REVENUECAT_WEBHOOK_SECRET>
curl -s $BASE/api/health        # expect: ...,"billing":true
```

## 1. SQL self-test (no real data changed — it rolls back)
Supabase SQL editor → paste `db/seed_smoke.sql` → Run. Expect it to end with:
```
NOTICE:  ✅ ALL ASSERTIONS PASSED (rolling back — no real data changed)
```
This proves: free-grant-once, monthly-first spend, insufficient→402, idempotent top-up & renewal,
cross-bucket draining, expiration preserving top-ups.

## 2. Get a user access token (JWT)
```bash
export JWT=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | jq -r .access_token)
echo "${JWT:0:24}…"        # sanity: should be a JWT, not 'null'
```

## 3. Read balance (first call also grants the 3 free credits)
```bash
curl -s $BASE/api/credits -H "Authorization: Bearer $JWT"
# expect: {"enabled":true,"balance":3,"costs":{...},"freeCredits":3}
```

## 4. A real lookup debits 1 credit (this makes a billed Anthropic call)
```bash
curl -s -X POST $BASE/api/analyze -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' -d '{"name":"Glock 19 Gen 5"}' | jq '.credits, (.sources|length)'
# expect: {"balance":2,"charged":1}  and some sources
curl -s $BASE/api/credits -H "Authorization: Bearer $JWT" | jq .balance   # -> 2
```
In Supabase: `select kind,amount,action,balance_after from credit_ledger order by id desc limit 3;`
should show the `debit / fast / -1` row.

## 5. Out of credits → HTTP 402
Spend down (repeat step 4) until balance is 0, then:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/api/analyze \
  -H "Authorization: Bearer $JWT" -H 'content-type: application/json' -d '{"name":"x"}'
# expect: 402
curl -s -X POST $BASE/api/analyze -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' -d '{"name":"x"}' | jq
# expect: {"error":"insufficient_credits","balance":0,"cost":1}
```
Also confirm **no token → 401**:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/api/analyze -d '{"name":"x"}'   # 401
```

## 6. Webhook refills credits (RevenueCat path)
Find your user UUID: Supabase → Authentication → Users (or `select id from auth.users where email='you@example.com';`).
```bash
export UID=<your-user-uuid>
# 6a. dashboard "Send test event" equivalent:
curl -s -X POST $BASE/api/webhooks/revenuecat -H "Authorization: Bearer $RC_SECRET" \
  -H 'content-type: application/json' -d '{"api_version":"1.0","event":{"type":"TEST","id":"t1"}}'
# expect: {"ok":true,"applied":false,"reason":"test_ok"}

# 6b. a renewal grants the tier's monthly allotment (product_id must exist in RC_PRODUCT_MAP):
curl -s -X POST $BASE/api/webhooks/revenuecat -H "Authorization: Bearer $RC_SECRET" \
  -H 'content-type: application/json' \
  -d "{\"event\":{\"type\":\"RENEWAL\",\"id\":\"rc_evt_1\",\"app_user_id\":\"$UID\",\"product_id\":\"enthusiast_monthly\"}}"
# expect: {"ok":true,"applied":true,"balance":40}

# 6c. replay the SAME event id -> idempotent no-op:
curl -s -X POST $BASE/api/webhooks/revenuecat -H "Authorization: Bearer $RC_SECRET" \
  -H 'content-type: application/json' \
  -d "{\"event\":{\"type\":\"RENEWAL\",\"id\":\"rc_evt_1\",\"app_user_id\":\"$UID\",\"product_id\":\"enthusiast_monthly\"}}"
# expect: {"ok":true,"applied":false,"balance":40}

# 6d. a top-up adds to the never-expire bucket:
curl -s -X POST $BASE/api/webhooks/revenuecat -H "Authorization: Bearer $RC_SECRET" \
  -H 'content-type: application/json' \
  -d "{\"event\":{\"type\":\"NON_RENEWING_PURCHASE\",\"id\":\"rc_top_1\",\"app_user_id\":\"$UID\",\"product_id\":\"topup_50\"}}"
# expect: {"ok":true,"applied":true,"balance":90}
```
Bad secret must 401: `curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/api/webhooks/revenuecat -H "Authorization: Bearer nope" -d '{}'` → `401`.

Finally, in RevenueCat: point a webhook at `$BASE/api/webhooks/revenuecat`, set the Authorization
value to `Bearer $RC_SECRET`, hit **Send Test Event**, then do a sandbox purchase and watch the
balance move (client must call `Purchases.logIn(<supabase user uuid>)` so `app_user_id` matches).

## Pass criteria
☐ SQL self-test prints ALL ASSERTIONS PASSED ☐ `/api/credits` returns a balance
☐ a lookup debits 1 and writes a ledger row ☐ zero balance → 402, no token → 401
☐ renewal grants monthly, replay is a no-op ☐ top-up adds to balance ☐ bad webhook secret → 401
