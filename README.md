# 🎯 Gun Show Deal Finder

A fast, mobile-first **PWA** for the gun show floor. Snap a photo, **scan a barcode**, or type an
item, and a **three-agent AI pipeline** goes to work, live, in front of you:

- **🔭 The Scout** — identifies the exact item and web-searches reputable retailers + used/auction
  marketplaces to build a verified price picture and a fair average ("good") price, with a
  **direct, tappable product link for every price** so you can verify it yourself.
- **🧠 The Gun Guru** — the most knowledgeable gun person alive: pulls reviews, Reddit/forum
  consensus, and known issues, rates the quality tier (**top-tier → solid → budget-ok → chinesium**),
  and bluntly tells you when something is cheap crap (with links to the threads).
- **🤝 The Deal Specialist** — a veteran negotiator that weighs **price *and* quality** to deliver
  the verdict (**great / good / ok / bad**), an out-the-door counter-offer plan, a script to say at
  the table, what to inspect, fakes to avoid, and whether used is the smarter buy.

You watch all three agents **reason and search in real time**, then get a clean, comparable result.
Toggle the Gun Guru off for a faster/cheaper two-agent run.

> For research only. Verify prices and follow all federal, state, and local laws before buying.

---

## What it does

1. **Scan, snap, or type** — 📷 photo, 🔖 **barcode/UPC scan**, or type the name. Vision IDs make/model/caliber and reads price tags & box labels.
2. **Enter their asking price** + condition.
3. **Watch it work** — a live activity feed streams each agent's thinking and every web search it runs.
4. **Deal score** with an animated gauge, rated vs. the fair average (on an out-the-door basis):
   - **Great** ≥15% below fair · **Good** 5–15% below · **OK** ±5% · **Bad** >5% above
5. **Quality check** — tier (top-tier → chinesium), pros/cons, known issues, and better alternatives, with **review/Reddit links**.
6. **Counter-offer playbook** — target price, walk-away price, a script, and the reasoning.
7. **Specialist's playbook** — cash-discount asks, OTD math, bundle ideas, inspection & fake-spotting tips.
8. **Verifiable price sources** — ranked cheapest-first, each with a store favicon and a **direct product link to verify**.
9. **Share** a result summary, **used vs. new** advice + red flags, and on-device **history**.
10. **💬 Chat** — tap the bubble to ask the expert. On the home screen it has all your recent searches as
    context; with a result open it focuses on that item (but can still search the web for anything).
    Answers render as clean formatted HTML, not raw markdown.
11. **Saves money** — the last **20 searches are cached** on your device; repeating an identical search
    (or tapping a ⚡ history row) loads instantly with **no API charge**. Clear the item name with ✕.

### Works for anything that shoots or bolts onto something
Complete firearms, AR-platform parts (uppers, lowers, **barrels**, BCGs, handguards, triggers),
**1911 / 2011 & Glock** parts, magazines, optics, lights, holsters, and **ammunition**
(priced per box *and* per round). It detects the category and searches the right stores.

### Sources it consults (by category)
- **Firearms (new + used/auction):** GunBroker, GunsAmerica, Guns.com, PSA, Bud's, GrabAGun, Kygunco, Classic Firearms, Impact Guns, Sportsman's Warehouse, Cabela's, Bass Pro, Sportsman's Guide
- **Parts & accessories:** Brownells, MidwayUSA, Primary Arms, Rainier Arms, Aero Precision, AIM Surplus, BattleHawk, Wing Tactical, Joe Bob Outfitters, Numrich, **Amazon**, **B&H Photo**
- **1911 / 2011 & Glock:** Brownells, Wilson Combat, Fusion Firearms, GlockStore, Lone Wolf, Primary Arms, MidwayUSA, Amazon
- **Optics / lights / accessories:** EuroOptic, OpticsPlanet, B&H Photo, Amazon, Primary Arms, Brownells
- **Ammunition:** **AmmoSeek**, Lucky Gunner, Target Sports USA, SGAmmo, Ammo.com, PSA, MidwayUSA, Brownells, Bud's

---

## Run it

```bash
npm install

# Option A: server-wide key
cp .env.example .env        # then put your ANTHROPIC_API_KEY in .env
npm start

# Option B: no .env — start, open the app, tap ⚙️ Settings, paste your key
npm start
```

Open **http://localhost:3000**.

### API key
- **Server:** set `ANTHROPIC_API_KEY` in `.env`.
- **In-app:** tap ⚙️, paste your key — stored only on that device (`localStorage`) and sent
  per-request, overriding the server key. Great for personal use on your own phone.

---

## Deploy to the cloud (use it on your phone, anywhere)

A hosted `https://` URL means the camera works and you can use it on cell data at the show.
You don't need to set any secret on the host: just paste your API key in the app's ⚙️ Settings.

### Render (free)
1. Push this repo to GitHub (done).
2. **render.com → New → Blueprint**, connect the repo. It reads `render.yaml` and deploys
   branch `claude/gun-show-deal-finder-b0xHM` automatically.
3. Open the `https://…onrender.com` URL on your phone → **Add to Home Screen**.
4. Tap ⚙️ → paste your Anthropic key → Save.

> Render's **free** tier sleeps after inactivity, so the *first* open may take ~30–50s to wake.

### Railway / Fly.io (stays warm)
A `Dockerfile` is included — point Railway or Fly at the repo and deploy. No cold starts.

---

## How it's built

```
server.js              Express API:
                         /api/identify        Claude vision photo/barcode → product name (reads UPC)
                         /api/analyze/stream  SSE 3-agent pipeline (Scout → Gun Guru → Specialist), streams reasoning + searches
                         /api/health
public/
  index.html           Mobile UI + live agent activity feed
  styles.css           Glass UI, animated score gauge, agent lanes
  app.js               Camera/resize, SSE streaming client, rendering, history, settings, PWA
  manifest.webmanifest Installable PWA
  sw.js                App-shell cache (API never cached)
  icon*.svg            App icons
render.yaml            One-click Render Blueprint
Dockerfile             Railway/Fly/any Docker host
```

- **Model:** `claude-sonnet-4-6` with extended **thinking** + the Anthropic **web search** tool.
  Three specialized agents run in sequence, each with its own structured SOP (`SCOUT_SOP`, `GURU_SOP`,
  `SPECIALIST_SOP` in `server.js`). The Gun Guru is optional (UI toggle). Falls back gracefully if a key
  lacks thinking/search.
- **Live barcode scanner**: real-time camera scan via `BarcodeDetector` (Android/desktop) with a ZXing
  fallback for iOS Safari; vision-reads the label if the camera is blocked.
- Reasoning, search queries, and result counts stream to the browser over **Server-Sent Events**,
  with an automatic fallback to a plain `/api/analyze` request when streaming is blocked (some mobile
  networks/proxies/Safari) — so the deal check always completes.
- **Out-the-door (OTD) calculator**: set your sales-tax % and FFL transfer fee once in ⚙️ Settings; every
  result shows the true table-cash price vs. cheapest-online + shipping + tax (+ FFL for firearms).
- Photos are resized client-side (≤1280px JPEG) before upload. No database — history lives in the browser.

### Cost per lookup (estimate)
Roughly **$0.40–0.75** for a full three-agent run with the Gun Guru on (three model calls + thinking +
web searches at ~$0.01 each). Turning the Gun Guru **off** drops it to ~**$0.20–0.45** (two agents).
Typing the name instead of using a photo is cheaper.
Lower `MAX_SEARCHES` / `THINK_BUDGET` to reduce cost.

### Config (env)
| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Server key (optional if using in-app key) |
| `PORT` | `3000` | |
| `MODEL` | `claude-sonnet-4-6` | |
| `WEB_SEARCH_TOOL` | `web_search_20250305` | Anthropic web search tool version |
| `MAX_SEARCHES` | `6` | Max web searches per agent run |
| `THINK_BUDGET` | `2500` | Extended-thinking token budget per agent |

---

## Ideas for later
Barcode/QR scan, voice input, multi-photo (both sides + serial), saved watchlist with price alerts,
local "show mode" that caches recent lookups, and a share/export of a result card.
