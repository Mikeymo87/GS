# 🎯 Gun Show Deal Finder

A fast, mobile-first **PWA** for the gun show floor. Snap a photo or type an item,
and it prices it across reputable retailers + used/auction marketplaces, scores the
booth's asking price (**great / good / ok / bad**), and uses **Claude Sonnet 4.6**
with live web search to tell you the product details, whether a **used** copy is the
smarter buy, and **exactly how much to counter — and why**.

> For research only. Verify prices and follow all federal, state, and local laws before buying.

---

## What it does

1. **Scan or type** — take a photo (Claude vision IDs the make/model/caliber and even reads price tags) or type the name.
2. **Enter their asking price** + condition.
3. **Compare** — pulls current prices from many reputable stores, drops outliers, and forms a **fair average ("good") price**.
4. **Deal score** — rates the table price vs. the fair average:
   - **Great** ≥15% below fair · **Good** 5–15% below · **OK** ±5% · **Bad** >5% above
5. **Counter-offer playbook** — target price, walk-away price, a script to say, and the reasoning.
6. **Used vs. new** — advice on whether a used GunBroker/GunsAmerica copy is the better value.
7. **History** — recent scans saved on your device so you can compare tables.

### Works for anything that shoots or bolts onto something
Complete firearms, AR-platform parts (uppers, lowers, **barrels**, BCGs, handguards,
triggers), **1911 / 2011 & Glock** parts, magazines, optics, lights, holsters, and
**ammunition** (priced per box *and* per round). It detects the category and searches
the right stores.

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

### Use it on your phone (same Wi-Fi)
1. Find your computer's LAN IP (e.g. `192.168.1.20`).
2. On your phone visit `http://192.168.1.20:3000`.
3. **Add to Home Screen** → it installs as a full-screen app with camera access.

> Camera capture requires a **secure context**. `localhost` is fine; over LAN, phones
> may restrict the camera on plain `http`. To get the camera on your phone, host it
> behind HTTPS — e.g. a tunnel like `cloudflared tunnel --url http://localhost:3000`
> or `ngrok http 3000` — then open the HTTPS URL and Add to Home Screen.

### API key
- **Server:** set `ANTHROPIC_API_KEY` in `.env`.
- **In-app:** tap ⚙️, paste your key — stored only on that device (`localStorage`) and
  sent per-request, overriding the server key. Great for personal use on your own phone.

---

## Deploy to the cloud (use it on your phone, anywhere)

A hosted `https://` URL means the camera works and you can use it on cell data at the
show — no laptop. You don't need to set any secret on the host: just paste your API key
in the app's ⚙️ Settings on your phone.

### Render (free)
1. Push this repo to GitHub (done).
2. Go to **render.com → New → Blueprint**, connect the repo. It reads `render.yaml`
   and deploys branch `claude/gun-show-deal-finder-b0xHM` automatically.
   *(Or New → Web Service: Build `npm install`, Start `npm start`, Health `/api/health`.)*
3. Open the `https://…onrender.com` URL on your phone → **Add to Home Screen**.
4. Tap ⚙️ → paste your Anthropic key → Save. Done.

> Render's **free** tier sleeps after inactivity, so the *first* open may take ~30–50s
> to wake. Open the app a minute before you need it, or use a paid/always-on tier.

### Railway / Fly.io (stays warm)
A `Dockerfile` is included. Point Railway or Fly at the repo and deploy — same result,
no cold starts. Set `ANTHROPIC_API_KEY` as a host env var if you prefer a server key.

---

## How it's built

```
server.js              Express API: /api/identify (vision), /api/analyze (search+score), /api/health
public/
  index.html           Mobile UI shell
  styles.css           Dark, touch-friendly, deal-meter theme
  app.js               Camera/resize, calls, rendering, history, settings, PWA registration
  manifest.webmanifest Installable PWA
  sw.js                App-shell cache (API never cached)
  icon*.svg            App icons
```

- **Model:** `claude-sonnet-4-6` with the Anthropic **web search** tool. If web search
  isn't enabled on your key, it gracefully falls back to model estimates and flags it in the UI.
- Photos are resized client-side (≤1280px JPEG) before upload to stay fast on cell data.
- No database — history lives in the browser.

### Config (env)
| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Server key (optional if using in-app key) |
| `PORT` | `3000` | |
| `MODEL` | `claude-sonnet-4-6` | |
| `WEB_SEARCH_TOOL` | `web_search_20250305` | Anthropic web search tool version |
| `MAX_SEARCHES` | `6` | Max web searches per analysis |
