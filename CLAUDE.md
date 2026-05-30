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
- `GET /api/health` — `{ ok, model, hasServerKey }`.

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
