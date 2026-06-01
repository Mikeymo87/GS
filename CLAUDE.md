# Gun Show Deal Finder — working notes for Claude

Mobile PWA: scan/snap/type a firearm, part, optic, or ammo at a gun show → live prices from
reputable retailers → deal rating + counter-offer + out-the-door math. Optional 3-agent "Deep dive"
adds review/quality analysis. Plus a chat assistant.

## Run / test locally
```bash
npm install
ANTHROPIC_API_KEY=sk-... npm start      # http://localhost:3000
# or start without a key and paste one in the app's ⚙️ Settings (stored on device)
node --check server.js && node --check public/app.js   # quick syntax gate
```
No automated test suite. After changes, run the syntax gate, boot the server, and curl the
endpoints (see below). The remote sandbox CANNOT make billed model calls — the Anthropic proxy
needs the user's real key — so endpoints will return `missing_key` here; that's expected. Real
model behavior is validated by the user on their deploy.

## Speed model (important — this app was too slow before)
- **Fast mode is the DEFAULT**: ONE agent (`FAST_SOP`) identifies + prices + rates + counters in a
  single call. Target ~15–30s. This is what most lookups should use.
- **Deep mode** (`deep:true`, UI "Deep dive" toggle): 3 agents. Non-streaming `/api/analyze` runs
  Scout + Gun Guru **in parallel** then Specialist. Streaming runs them sequentially for the live view.
- Tunables (env): `MAX_SEARCHES` (default 4), `THINK_BUDGET` (default 1200). Lower = faster/cheaper.
- If it's still slow, first suspects: too many web searches, thinking budget, or deep mode left on.

## Cost model
- **Prompt caching**: `cachedSystem()` wraps every system prompt as a cached content block
  (`cache_control: ephemeral`), so the big static SOPs bill ~10% on repeat calls. Confirm via the
  `usage` log line — request #1 shows `cache_creation_input_tokens > 0`, repeats show `cache_read_input_tokens > 0`.
- **Model routing**: the pricing/quality brain (`FAST_SOP`, Scout/Guru/Specialist, `/api/reviews`)
  stays on Sonnet (`MODEL`). The cheap/mechanical calls — `/api/identify`, `/api/chat`, `/api/refine` —
  run on `LIGHT_MODEL` (Haiku, ~3–5× cheaper). Refine also drops extended thinking.
- Override with env: `LIGHT_MODEL=claude-sonnet-4-6` pins everything back to Sonnet (e.g. if Haiku
  rejects the web_search tool in chat — chat already degrades gracefully via its no-tools fallback).
- `createPhase`/`runPhase` accept `{ model, think, maxTokens }` to route per call site.

## Reading the logs (why this exists)
Server prints timestamped timing lines (set `LOG=0` to silence). Look for:
```
… POST /api/analyze  item="Glock 19" mode=fast
… ▶ fast start
… ✔ fast done in 18.3s
… POST /api/analyze done (fast) in 18.6s, 7 sources
```
`✗ … FAILED in …s` marks the phase that threw. On the user's host (Render/Railway), this is the
deploy log stream. "Couldn't reach the server" on the client almost always = a phase ran past a
proxy/browser idle timeout; the client auto-falls back from streaming to `/api/analyze`.

## Endpoints
- `POST /api/identify` — photo/UPC → product JSON (single quick vision call).
- `POST /api/analyze` — non-streaming pipeline. Reliable everywhere; the client uses it as the
  fallback when SSE is blocked. `{ name, image, upc, askingPrice, condition, deep, salesTaxPct, fflFee }`.
- `POST /api/analyze/stream` — SSE live view (reasoning + searches). Same body. Heartbeat every 10s.
- `POST /api/chat` — `{ message, history, item, recentSearches }` → `{ html }` (clean HTML, sanitized client-side).
- `POST /api/refine` — `{ name, condition, askingPrice, details, product, history }` → `{ changed, name, condition, askingPrice, details, changes[] }`. Cheap extraction (no web search) that pulls new item details out of the chat so the user can re-run the search refined. Client threads `details` through `analyze()` → `buildContext()` and into `cacheKey`.
- `GET /api/credits` — billing mode only: `{ enabled, balance, costs, freeCredits }` for the signed-in
  user (needs `Authorization: Bearer <supabase-jwt>`). Returns `{ enabled:false, costs }` when billing is off.
- `GET /api/health` — `{ ok, model, hasServerKey, billing }`.

## Billing layer (optional, OFF by default — see MONETIZATION.md)
`lib/billing.js` + `db/schema.sql` add a Supabase credit ledger. It's a no-op unless `BILLING_ENABLED`
is truthy AND `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + `SUPABASE_JWT_SECRET` are set — so local/BYO-key
runs are unaffected. When on: `openGate(req, action)` verifies the user's Supabase JWT (local HS256, no
SDK), debits credits (`fast`=1, `deep`=4, `reviews`=2; identify/chat/refine free), and gates
`/api/analyze`, `/api/analyze/stream`, `/api/reviews`. No token → 401; out of credits → **402
`insufficient_credits`** (SSE `{t:"error"}`); ledger unreachable → **503 fail-closed**. Debits happen up
front and are refunded on failure or stream abort. Success responses include `credits:{balance,charged}`.
In billing mode `clientFor` ignores the client `x-anthropic-key` and uses ONLY the server key, so the
ledger is the sole gate (BYO-key still works when billing is off). Apply `db/schema.sql` first.
`POST /api/webhooks/revenuecat` refills credits: auth via `REVENUECAT_WEBHOOK_SECRET` (Bearer,
timing-safe), body `{api_version,event}`, idempotent on `event.id`. `NON_RENEWING_PURCHASE`→top-up;
`INITIAL_PURCHASE`/`RENEWAL`/`PRODUCT_CHANGE`/`UNCANCELLATION`/`SUBSCRIPTION_EXTENDED`→`reset_monthly`;
`EXPIRATION`→free. `app_user_id` must be the Supabase UUID (client `Purchases.logIn(uuid)`); map
products via `RC_PRODUCT_MAP` (JSON). Unknown user→200 ack; ledger down→500 (RC retries).
Free endpoints (`/api/identify`,`/api/chat`,`/api/refine`) also require a signed-in user in billing
mode (`openGate(req,"free")`, 0 credits) so the server key can't be used anonymously.
Client: `GET /api/config` returns `{billing,supabaseUrl,supabaseAnonKey,costs,freeCredits,packs}`.
`public/auth.js` (loaded before app.js) does Supabase email/pw auth via REST + token refresh, exposes
`window.Auth`; inert when billing off. `app.js` sends `Authorization: Bearer` in billing mode, shows
credits chip + sign-in/account/top-up modals, maps 402→top-up & 401→sign-in. Purchase button is a
placeholder (`buyPack()`) pending Stripe/RevenueCat. Extra env: `SUPABASE_ANON_KEY`, `RC_TOPUP_PACKS`.

Smoke test:
```bash
curl -s localhost:3000/api/health
curl -s -X POST localhost:3000/api/analyze -H 'content-type: application/json' -d '{"name":"x"}'  # -> missing_key here
```

## Layout
- `server.js` — all endpoints + agent SOPs (`FAST_SOP`, `SCOUT_SOP`, `GURU_SOP`, `SPECIALIST_SOP`,
  `CHAT_SOP`) + `timed()`/`log()` timing helpers. Result JSON is extracted with a brace-matching parser.
- `public/app.js` — camera/barcode capture, SSE client with non-stream fallback, rendering, on-device
  cache (last 20 text searches), history, chat (HTML sanitized to a tag allowlist).
- `public/{index.html,styles.css,sw.js}` — UI, glassy theme, app-shell SW (bump `CACHE` on UI changes).
- `render.yaml` / `Dockerfile` — deploy.

## Conventions / gotchas
- API key: per-request `x-anthropic-key` header (from device) OR server `ANTHROPIC_API_KEY`.
- Bump `CACHE` in `public/sw.js` whenever shipping front-end changes, or installed PWAs serve stale assets.
- Photo searches are NOT cached client-side (image isn't stored); text searches are.
- Branch: `claude/gun-show-deal-finder-b0xHM`. Don't push elsewhere without asking. No PR unless asked.
- Keep model id out of committed artifacts; it lives in chat replies only.
