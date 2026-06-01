import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { openGate, billingEnabled, billingConfig, verifyToken, bearer, getBalance } from "./lib/billing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "25mb" })); // base64 photos can be large
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const LIGHT_MODEL = process.env.LIGHT_MODEL || "claude-haiku-4-5-20251001";
// Vision/identify accuracy matters more than the small per-call savings (it runs
// once per item), so default photo ID to the stronger model. Override with env.
const VISION_MODEL = process.env.VISION_MODEL || MODEL;
const WEB_SEARCH_TOOL = process.env.WEB_SEARCH_TOOL || "web_search_20250305";
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 4);
const THINK_BUDGET = Number(process.env.THINK_BUDGET || 1200);
const LOG = process.env.LOG !== "0"; // server timing logs on by default

// Wrap a plain system string into a cached content-block array so Anthropic
// caches the big static SOPs across requests (~90% off repeated input tokens).
// Harmless if the prefix is too small to cache — it just no-ops.
function cachedSystem(system) {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

// Lightweight timing logger so we can see where the seconds go (see CLAUDE.md).
function log(...a) { if (LOG) console.log(new Date().toISOString(), ...a); }
async function timed(label, fn) {
  const t0 = Date.now();
  log(`▶ ${label} start`);
  try {
    const r = await fn();
    log(`✔ ${label} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return r;
  } catch (e) {
    log(`✗ ${label} FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(e?.message || e));
    throw e;
  }
}

// Resolve the Anthropic API key. Priority:
//   1. Per-request key from the app's Settings (sent as a header, saved on the device)
//   2. ANTHROPIC_API_KEY from the server environment
function clientFor(req) {
  const headerKey = req.get("x-anthropic-key");
  const apiKey = (headerKey && headerKey.trim()) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

// ----- Reputable sources, grouped by category -----
const SOURCE_GROUPS = {
  "Firearms (new + used/auction)": [
    "GunBroker (gunbroker.com)", "GunsAmerica (gunsamerica.com)", "Guns.com (guns.com)",
    "Palmetto State Armory (palmettostatearmory.com)", "Bud's Gun Shop (budsgunshop.com)",
    "GrabAGun (grabagun.com)", "Kentucky Gun Co (kygunco.com)", "Classic Firearms (classicfirearms.com)",
    "Impact Guns (impactguns.com)", "Sportsman's Warehouse (sportsmans.com)", "Cabela's (cabelas.com)",
    "Bass Pro Shops (basspro.com)", "Sportsman's Guide (sportsmansguide.com)",
  ],
  "Parts & accessories (AR platform, barrels, uppers, builders' parts)": [
    "Brownells (brownells.com)", "MidwayUSA (midwayusa.com)", "Primary Arms (primaryarms.com)",
    "Rainier Arms (rainierarms.com)", "Aero Precision (aeroprecisionusa.com)", "Palmetto State Armory",
    "AIM Surplus (aimsurplus.com)", "BattleHawk Armory (battlehawkarmory.com)",
    "Wing Tactical (wingtactical.com)", "Joe Bob Outfitters (joeboboutfitters.com)",
    "Numrich Gun Parts (gunpartscorp.com)", "Amazon (amazon.com)", "B&H Photo (bhphotovideo.com)",
  ],
  "1911 / 2011 & Glock parts": [
    "Brownells", "Wilson Combat (wilsoncombat.com)", "Fusion Firearms (fusionfirearms.com)",
    "GlockStore (glockstore.com)", "Lone Wolf (lonewolfdist.com)", "Primary Arms", "MidwayUSA", "Amazon",
  ],
  "Optics, lights, holsters & accessories": [
    "EuroOptic (eurooptic.com)", "OpticsPlanet (opticsplanet.com)", "B&H Photo (bhphotovideo.com)",
    "Amazon (amazon.com)", "Primary Arms", "Brownells", "MidwayUSA",
  ],
  "Ammunition": [
    "AmmoSeek (ammoseek.com)", "Lucky Gunner (luckygunner.com)", "Target Sports USA (targetsportsusa.com)",
    "SGAmmo (sgammo.com)", "Ammo.com (ammo.com)", "Palmetto State Armory", "MidwayUSA",
    "Brownells", "Bud's Gun Shop", "Sportsman's Guide",
  ],
};
const SOURCE_REFERENCE = Object.entries(SOURCE_GROUPS)
  .map(([cat, list]) => `  • ${cat}: ${list.join(", ")}`)
  .join("\n");

// ===================== AGENT 1: THE SCOUT (SOP) =====================
const SCOUT_SOP = [
  "# ROLE",
  "You are THE SCOUT — a firearms sourcing & pricing analyst. Your ONLY job is to identify the exact",
  "item and find REAL, CURRENT market prices with VERIFIABLE links. You do NOT rate the deal or judge",
  "quality — other agents do that. Never invent prices or URLs.",
  "",
  "# STANDARD OPERATING PROCEDURE",
  "1. IDENTIFY: From the name, UPC/barcode (if given), and/or photo, determine the exact item, brand,",
  "   model/variant, caliber/spec, and CATEGORY (firearm | part | accessory | optic | magazine | ammo | other).",
  "   If a photo is given, confirm the precise configuration (generation, finish, barrel length, optic cut,",
  "   included extras, round count).",
  "2. UNIT: Decide the correct pricing unit. For ammo, lock the quantity to match the table item",
  "   (e.g. per box of 20/50, or per case of 1000) and compute price PER ROUND.",
  "3. SEARCH: Use web_search to pull current listings from the source groups relevant to the category:",
  SOURCE_REFERENCE,
  "4. COVERAGE: For FIREARMS, get BOTH new retailers AND used/auction (GunBroker, GunsAmerica, Guns.com).",
  "   For PARTS/OPTICS/ACCESSORIES, include Amazon & B&H where they carry it; match exact model/part number + fitment.",
  "   For AMMO, use AmmoSeek + ammo retailers and normalize to the same quantity.",
  "5. VERIFY LINKS: Every source 'url' MUST be a DIRECT link to that exact product's listing/detail page",
  "   (the page showing that price) — NOT a homepage, category, or search-results page — so the buyer can tap to verify.",
  "   Use the real URLs returned by web_search. If you cannot find a direct product URL for a price, drop that source.",
  "6. VALIDATE: Prefer recent, in-stock, US listings in USD. Drop outliers, expired, and out-of-stock placeholders.",
  "7. COMPUTE: fairPrice = average street price of the legitimate listings. Provide new low/high and used low/high",
  "   ranges and how many listings you used (sampleSize).",
  "8. NOTE: In market.note, record per-round/per-unit math and cost-to-compare factors (typical shipping, whether",
  "   an FFL transfer would be required for an online firearm purchase). Set market.typicalShipping to a number when known.",
  "",
  "# OUTPUT",
  "Respond with EXACTLY ONE JSON object (no prose before/after):",
  `{
  "product": { "name": string, "category": "firearm|part|accessory|optic|magazine|ammo|other", "summary": string, "specs": [string], "msrp": number|null },
  "market": { "currency": "USD", "newLow": number|null, "newHigh": number|null, "usedLow": number|null, "usedHigh": number|null, "fairPrice": number|null, "sampleSize": number, "typicalShipping": number|null, "note": string },
  "sources": [ { "store": string, "title": string, "price": number, "condition": "new"|"used", "url": "DIRECT product page URL", "inStock": boolean|null, "note": string } ]
}`,
  "Include 6-12 real sources when possible, cheapest first. Every source needs a real store, a price, and a working DIRECT product URL.",
].join("\n");

// ===================== AGENT 2: THE GUN GURU (SOP) =====================
const GURU_SOP = [
  "# ROLE",
  "You are THE GUN GURU — the most knowledgeable firearms person alive: competition shooter, armorer, and",
  "reviewer who has handled everything. You judge QUALITY and REPUTATION, not price. You love genuinely good",
  "gear and you bluntly call out cheap 'chinesium' junk for what it is. Be honest, specific, and useful.",
  "",
  "# STANDARD OPERATING PROCEDURE",
  "1. Confirm the exact item/brand/variant from the provided item and the Scout's findings.",
  "2. Use web_search to gather REAL-WORLD consensus and KEEP THE LINKS:",
  "   - Professional & YouTube reviews (and their overall take)",
  "   - Owner feedback on Reddit (r/guns, r/CAguns, r/ar15, r/Glocks, r/longrange, etc.) and forums (AR15.com, etc.)",
  "   - Known defects, recalls, QC track record, durability / round-count reports, warranty",
  "   - Manufacturer reputation and aftermarket/parts/holster support",
  "3. Decide an honest quality tier: top-tier | solid | budget-ok | chinesium (cheap crap).",
  "4. Call out common failure points, and whether a better-value alternative exists near the same price.",
  "5. Every reviewSource 'url' must be a real, working link to that review/thread so the buyer can read it.",
  "",
  "# OUTPUT",
  "Respond with EXACTLY ONE JSON object (no prose before/after):",
  `{
  "quality": {
    "tier": "top-tier"|"solid"|"budget-ok"|"chinesium",
    "score": number,
    "verdict": string,
    "pros": [string],
    "cons": [string],
    "knownIssues": [string],
    "reputation": string,
    "alternatives": [ { "name": string, "why": string } ]
  },
  "reviewSources": [ { "title": string, "url": "direct link", "source": "e.g. Reddit r/guns, TFB, YouTube" } ]
}`,
  "score 0-100 = overall quality & value-for-the-money. Be blunt: if it's chinesium, say so and why. 3-6 review sources.",
].join("\n");

// ============ AGENT 3: THE GUN SHOW DEAL SPECIALIST (SOP) ============
const SPECIALIST_SOP = [
  "# ROLE",
  "You are a VETERAN GUN SHOW DEAL SPECIALIST. You've worked hundreds of shows on both sides of the table.",
  "You receive THE SCOUT's verified prices AND (when available) THE GUN GURU's quality assessment, plus the",
  "table's asking price and the buyer's tax/FFL info. You deliver the final verdict, the negotiation plan,",
  "and what to watch for.",
  "",
  "# WHAT YOU KNOW (apply the relevant parts)",
  "- QUALITY MATTERS: A low price on 'chinesium' is NOT a great deal. Don't tell someone to buy junk just because",
  "  it's cheap. If the Guru flagged a better-value alternative, surface it. Great quality can justify paying near fair.",
  "- OUT-THE-DOOR (OTD) MATH: an online price is really price + shipping + FFL transfer (use the buyer's fflFee for",
  "  firearms) + sales tax (use the buyer's salesTaxPct). A cash table price usually has no shipping and often no tax.",
  "  Use the buyer's actual numbers when given. Show the TRUE delta, not sticker vs sticker. Parts/ammo/optics ship",
  "  to the door (no FFL); only firearms need an FFL transfer.",
  "- CASH IS KING: most tables give ~5-10% off for cash. Have the buyer ask for the cash/out-the-door price first.",
  "- TIMING: best discounts come late on the final day — vendors don't want to pack inventory.",
  "- BUNDLES: adding ammo, a mag, a holster, or an optic can unlock a better package price.",
  "- INSPECTION (used firearms): bore/rifling, lockup & timing, finish wear vs refinish/reblue, import marks,",
  "  matching serials, police trade-in markings, cracks (especially polymer frames & cast slides).",
  "- COUNTERFEITS: fake optics (Trijicon RMR, Aimpoint, EOTech, Holosun clones), counterfeit Magpul PMAGs,",
  "  Glock/1911 clones sold as OEM, reproduction mil-surplus passed as original.",
  "- TOO-GOOD / RED FLAGS: far-below-market prices, no paperwork, filed/altered serials, pressure to rush — walk away.",
  "- LAW: remind the buyer to follow all federal/state/local law and use an FFL where required. Not legal advice.",
  "",
  "# RATING (vs the Scout's fairPrice, on an OTD basis, tempered by quality)",
  "  great = asking is >= 15% below fair (or below the cheapest legit listing) AND quality isn't junk -> buy it",
  "  good  = asking is 5-15% below fair",
  "  ok    = asking is within +/-5% of fair",
  "  bad   = asking is > 5% above fair, OR it's chinesium at any price -> pass / overpriced",
  "  unknown = no asking price given (still give the market read & a target to offer).",
  "score = 0-100, higher = better for the buyer. vsFairPct = signed % of asking vs fair (negative = below fair).",
  "",
  "# OUTPUT",
  "Respond with EXACTLY ONE JSON object (no prose before/after):",
  `{
  "deal": { "rating": "great"|"good"|"ok"|"bad"|"unknown", "score": number, "headline": string, "reasoning": string, "askingPrice": number|null, "vsFairPct": number|null },
  "otd": { "tableOTD": number|null, "onlineOTD": number|null, "cheaper": "table"|"online"|"even"|null, "delta": number|null, "explanation": string },
  "counterOffer": { "shouldCounter": boolean, "targetPrice": number|null, "walkAwayPrice": number|null, "script": string, "reasoning": string },
  "usedVsNew": string,
  "redFlags": [string],
  "specialistNotes": [string]
}`,
  "otd = the out-the-door comparison: tableOTD is the realistic cash price at the table; onlineOTD is the cheapest",
  "online price + shipping + tax + (FFL if a firearm). delta = |tableOTD - onlineOTD|. 'cheaper' = which wins.",
  "specialistNotes = 3-6 punchy, ITEM-SPECIFIC tactical tips for THIS purchase (cash ask, OTD delta, bundle idea,",
  "what to inspect, fake-spotting, and any better alternative from the Guru). 'script' is a short line the buyer can say.",
].join("\n");

// ============ FAST MODE: ONE agent does it all (default, ~3x faster) ============
const FAST_SOP = [
  "# ROLE",
  "You are a fast, expert gun-show buying assistant. In ONE pass you identify the item, find real current",
  "prices, rate the deal, and give a counter-offer plan. You handle complete firearms, AR/AK parts, barrels,",
  "uppers, 1911/2011 & Glock parts, magazines, optics, lights, holsters, and AMMUNITION. Be accurate and quick.",
  "",
  "# STEPS",
  "1. Identify the exact item, brand, model/variant, caliber/spec, and category (from name, UPC, and/or photo).",
  "2. Use web_search EFFICIENTLY (a few targeted queries) to get current US prices from reputable sellers,",
  "   covering BOTH new retailers AND used/auction for firearms (GunBroker, GunsAmerica, Guns.com), and",
  "   AmmoSeek/ammo sellers for ammo (normalize to the same quantity + price per round). Reputable sources:",
  SOURCE_REFERENCE,
  "3. Each price source 'url' MUST be a DIRECT product page link (not a homepage/search). Drop any you can't link.",
  "4. fairPrice = average street price of legit listings. Rate the table's asking price (out-the-door: factor the",
  "   buyer's tax/FFL when given; firearms need an FFL transfer, parts/ammo ship to the door):",
  "     great = asking >=15% below fair · good = 5-15% below · ok = within +/-5% · bad = >5% above.",
  "     unknown = no asking price (still give the market read and a target to offer).",
  "5. Give a counter-offer: target price, walk-away price, a one-line script, and brief reasoning.",
  "",
  "# OUTPUT — respond with EXACTLY ONE JSON object (no prose):",
  `{
  "product": { "name": string, "category": "firearm|part|accessory|optic|magazine|ammo|other", "summary": string, "specs": [string], "msrp": number|null },
  "market": { "currency": "USD", "newLow": number|null, "newHigh": number|null, "usedLow": number|null, "usedHigh": number|null, "fairPrice": number|null, "sampleSize": number, "note": string },
  "sources": [ { "store": string, "title": string, "price": number, "condition": "new"|"used", "url": "DIRECT product URL", "inStock": boolean|null, "note": string } ],
  "deal": { "rating": "great"|"good"|"ok"|"bad"|"unknown", "score": number, "headline": string, "reasoning": string, "askingPrice": number|null, "vsFairPct": number|null },
  "otd": { "tableOTD": number|null, "onlineOTD": number|null, "cheaper": "table"|"online"|"even"|null, "delta": number|null, "explanation": string },
  "counterOffer": { "shouldCounter": boolean, "targetPrice": number|null, "walkAwayPrice": number|null, "script": string, "reasoning": string },
  "usedVsNew": string,
  "redFlags": [string],
  "specialistNotes": [string]
}`,
  "Include 5-10 real sources with direct links, cheapest first. score 0-100 (higher = better buy). Keep it tight and useful.",
].join("\n");

// ============ REFINE: pull new item details out of a chat transcript ============
const REFINE_SOP = [
  "# ROLE",
  "You are a fast extraction utility. Input: the item currently being analyzed plus a chat transcript.",
  "Your ONLY job is to pull out NEW concrete facts the user revealed that should change a price/deal",
  "search. NO web search, NO pricing, NO advice — extraction only.",
  "",
  "# RULES",
  "- Compare what the user said against the CURRENT name/condition/askingPrice. If nothing materially new,",
  "  return changed:false and echo the current values.",
  "- Update 'name' ONLY when a spec changes the product identity (e.g. 'Gen 4 not Gen 5', 'threaded barrel',",
  "  '16in not 14.5'). Keep the existing brand/model — refine it, don't rewrite from scratch.",
  "- Map condition cues ('some holster wear', 'like new', 'NIB') to a short condition phrase.",
  "- Update 'askingPrice' ONLY when the user states a new number they could actually pay (e.g. 'they'll do",
  "  $420 cash'); otherwise keep the current value.",
  "- 'details': a compact semicolon-joined string of extras/specifics that don't fit name/condition/price",
  "  (e.g. 'threaded barrel; +2 mags; holster; night sights; light wear'). CUMULATIVE — fold in any prior details given.",
  "- 'changes': 2-5 short human-readable strings, one per change (e.g. 'Generation: Gen 5 → Gen 4',",
  "  'Asking: $480 → $420 cash', 'Added: threaded barrel, 3 mags, holster').",
  "",
  "# OUTPUT — respond with EXACTLY ONE JSON object (no prose):",
  `{
  "changed": true,
  "name": "Glock 19 Gen 4 9mm threaded barrel",
  "condition": "used - good",
  "askingPrice": 420,
  "details": "threaded barrel; +2 mags; holster; light holster wear",
  "changes": ["Generation: Gen 5 → Gen 4", "Asking: $480 → $420 cash", "Added: threaded barrel, 3 mags, holster"]
}`,
  "If nothing new: { \"changed\": false, \"name\": <current>, \"condition\": <current>, \"askingPrice\": <current>, \"details\": <current>, \"changes\": [] }",
].join("\n");

// ----- helpers -----
function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

function collectText(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function dataUrlToImageBlock(dataUrl) {
  const m = /^data:(image\/[a-zA-Z.+-]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

// Accept a single `image` (legacy) and/or an `images` array; return up to 4 valid blocks.
function imageBlocksFrom(body) {
  const urls = [];
  if (Array.isArray(body?.images)) urls.push(...body.images);
  if (body?.image) urls.push(body.image);
  return urls.map(dataUrlToImageBlock).filter(Boolean).slice(0, 4);
}

function validUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch { return null; }
}

function sanitizeSources(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const price = Number(s?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const url = validUrl(s?.url);
    const key = `${(s?.store || "").toLowerCase()}|${url || (s?.title || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      store: s.store || "",
      title: s.title || "",
      price,
      condition: String(s.condition || "").toLowerCase() === "used" ? "used" : "new",
      url,
      inStock: s.inStock ?? null,
      note: s.note || "",
    });
  }
  out.sort((a, b) => a.price - b.price);
  return out.slice(0, 12);
}

function sanitizeReviewSources(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const url = validUrl(s?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: s.title || url, url, source: s.source || "" });
  }
  return out.slice(0, 8);
}

// ----- shared prompt builders (used by both streaming and non-streaming) -----
function buildContext(body) {
  const { name, askingPrice, condition, location, upc, salesTaxPct, fflFee, details } = body || {};
  const asking = Number(askingPrice);
  const hasAsking = Number.isFinite(asking) && asking > 0;
  const tax = Number(salesTaxPct);
  const ffl = Number(fflFee);
  return [
    `Item: ${name || "(identify from the photo first)"}`,
    upc ? `UPC/barcode: ${upc}` : null,
    hasAsking ? `Table asking price: $${asking}` : "Table asking price: (not provided)",
    condition ? `Condition at the table: ${condition}` : null,
    (details && String(details).trim()) ? `Extra details from the buyer (treat as ground truth): ${String(details).trim()}` : null,
    location ? `Location: ${location}` : null,
    Number.isFinite(tax) && tax > 0 ? `Buyer's sales tax: ${tax}%` : null,
    Number.isFinite(ffl) && ffl >= 0 ? `Buyer's FFL transfer fee: $${ffl}` : null,
  ].filter(Boolean).join("\n");
}

function scoutUserContent(context, imgBlocks) {
  const content = [...(imgBlocks || [])];
  const photoNote = (imgBlocks && imgBlocks.length)
    ? ` Use the ${imgBlocks.length} photo(s) to confirm the EXACT variant/configuration (generation, finish, barrel length, markings, included extras) before pricing.`
    : "";
  content.push({ type: "text", text: `${context}\n\nIdentify the item, search reputable stores, and return the market JSON with DIRECT product links.${photoNote}` });
  return content;
}

function guruPrompt(context, scout) {
  return [
    context,
    "",
    `The Scout identified: ${JSON.stringify(scout.product || {})}`,
    "",
    "Research real-world quality, reviews, Reddit/forum consensus, and known issues. Is this quality kit or chinesium? Return only the JSON object.",
  ].join("\n");
}

function refinePrompt(current, product, transcript) {
  return [
    "CURRENT ITEM (known values):",
    "```json",
    JSON.stringify(current, null, 2),
    "```",
    product ? `CURRENT ANALYSIS (for context): ${JSON.stringify({ product })}` : "",
    "",
    "CONVERSATION:",
    transcript,
    "",
    "Extract any refinements per your SOP. Return only the JSON object.",
  ].filter(Boolean).join("\n");
}

function specialistPrompt(context, scout, guru, includeGuru) {
  return [
    context,
    "",
    "THE SCOUT'S VERIFIED FINDINGS:",
    "```json",
    JSON.stringify({ product: scout.product, market: scout.market, sources: scout.sources }, null, 2),
    "```",
    includeGuru ? "\nTHE GUN GURU'S QUALITY ASSESSMENT:\n```json\n" + JSON.stringify(guru.quality || {}, null, 2) + "\n```" : "",
    "",
    "Now deliver your verdict, OTD comparison, counter-offer plan, used-vs-new call, red flags, and tactical notes",
    "(factor in quality and the buyer's tax/FFL numbers). Return only the JSON object.",
  ].join("\n");
}

function fastUserContent(context, imgBlocks) {
  const content = [...(imgBlocks || [])];
  const photoNote = (imgBlocks && imgBlocks.length)
    ? ` Use the ${imgBlocks.length} photo(s) to confirm the EXACT variant/configuration (generation, finish, barrel length, markings, included extras) before pricing.`
    : "";
  content.push({ type: "text", text: `${context}\n\nIdentify, price (with DIRECT links), rate the deal, and give a counter-offer. Return only the JSON object.${photoNote}` });
  return content;
}

// Normalize a fast single-agent result into the same shape the UI expects.
function normalizeFast(obj) {
  obj = obj || {};
  return {
    product: obj.product || {},
    market: obj.market || {},
    sources: sanitizeSources(obj.sources),
    quality: null,
    reviewSources: [],
    deal: obj.deal || { rating: "unknown" },
    otd: obj.otd || null,
    counterOffer: obj.counterOffer || {},
    usedVsNew: obj.usedVsNew || "",
    redFlags: Array.isArray(obj.redFlags) ? obj.redFlags : [],
    specialistNotes: Array.isArray(obj.specialistNotes) ? obj.specialistNotes : [],
    _meta: { model: MODEL, mode: "fast" },
  };
}

function mergeResult(scout, guru, spec, includeGuru) {
  return {
    product: scout.product || {},
    market: scout.market || {},
    sources: scout.sources || [],
    quality: includeGuru ? (guru.quality || null) : null,
    reviewSources: includeGuru ? (guru.reviewSources || []) : [],
    deal: spec.deal || { rating: "unknown" },
    otd: spec.otd || null,
    counterOffer: spec.counterOffer || {},
    usedVsNew: spec.usedVsNew || "",
    redFlags: spec.redFlags || [],
    specialistNotes: spec.specialistNotes || [],
    _meta: { model: MODEL },
  };
}

// ---------- /api/identify : quick photo (and/or barcode) -> product name ----------
app.post("/api/identify", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });
  const imgs = imageBlocksFrom(req.body);
  const upc = (req.body?.upc || "").toString().trim();
  if (!imgs.length && !upc) return res.status(400).json({ error: "no_image" });
  try {
    const content = [...imgs];
    content.push({
      type: "text",
      text:
        (imgs.length > 1 ? `There are ${imgs.length} photos of the SAME item (e.g. profile, markings/roll-mark, box label) — combine them. ` : "") +
        (upc ? `Scanned UPC/barcode: ${upc}. Use it to identify the exact product. ` : "") +
        "Identify this item for a price search. Return only the JSON object.",
    });
    const message = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 700,
      system: cachedSystem(
        "You are a master firearms identifier (armorer + collector). Identify the EXACT item from the photo(s): " +
        "complete firearms, AR/AK-platform parts (uppers, lowers, barrels, BCGs, handguards, triggers), 1911/2011 and " +
        "Glock parts, magazines, optics, lights, holsters, suppressors, and AMMUNITION. " +
        "Be exact and look closely at ROLL MARKS, slide/barrel engravings, proof/import marks, model numbers, and box labels — " +
        "these disambiguate near-identical variants. For guns: make, model, caliber, generation/variant (e.g. Gen 3 vs 5, MOS, " +
        "Magpul vs standard), barrel length, finish, sights, threaded vs not. For parts: brand, model/part number, fitment " +
        "(AR-15 vs AR-10, Glock gen). For ammo: brand, caliber, grain weight, bullet type, ROUND COUNT. " +
        "If a UPC/barcode is provided or visible, read it and prefer it. Do NOT guess beyond what the image supports — if a spec " +
        "is unclear, omit it from name and lower confidence, and list realistic 'alternatives' the user can pick from. " +
        "Respond ONLY with a JSON object: " +
        '{ "name": "best single search string (brand model caliber/spec)", ' +
        '"category": "firearm|part|accessory|optic|magazine|ammo|other", ' +
        '"confidence": "high|medium|low", "upc": string|null, "alternatives": ["other plausible exact matches"], ' +
        '"markings": "roll marks / engravings / import marks read", ' +
        '"observedPrice": number|null, "quantity": number|null, "notes": "what you see, incl. condition cues" }'
      ),
      messages: [{ role: "user", content }],
    });
    const json = extractJson(collectText(message));
    if (!json) return res.status(502).json({ error: "parse_failed", raw: collectText(message) });
    res.json(json);
  } catch (err) {
    res.status(err?.status || 500).json({ error: "identify_failed", detail: String(err?.message || err) });
  }
});

// ---------- non-streaming phase (reliable everywhere) ----------
async function createPhase(client, { system, userContent, useTools, maxSearches, model = MODEL, think = true, maxTokens }) {
  const base = {
    model,
    max_tokens: maxTokens || (useTools ? 6000 : 4000),
    system: cachedSystem(system),
    messages: [{ role: "user", content: userContent }],
    ...(think ? { thinking: { type: "enabled", budget_tokens: THINK_BUDGET } } : {}),
  };
  const withTools = useTools
    ? { ...base, tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: maxSearches || MAX_SEARCHES }] }
    : base;
  try {
    const m = await client.messages.create(withTools);
    if (m.usage) log("usage", model, JSON.stringify(m.usage));
    return collectText(m);
  } catch (err) {
    // Drop thinking (and tools) if the account/model rejects them. Keep cached system + chosen model.
    return collectText(await client.messages.create({ model, max_tokens: base.max_tokens, system: base.system, messages: base.messages }));
  }
}

// ---------- /api/analyze : non-streaming pipeline (used directly + as stream fallback) ----------
app.post("/api/analyze", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });

  const { name, upc, deep } = req.body || {};
  const imgBlocks = imageBlocksFrom(req.body);
  if (!name && !imgBlocks.length && !upc) return res.status(400).json({ error: "need_name_or_image" });
  const includeGuru = deep === true; // FAST is the default; deep (3-agent) is opt-in
  const context = buildContext(req.body);
  const t0 = Date.now();
  log(`POST /api/analyze  item="${name || "(photo)"}" mode=${includeGuru ? "deep" : "fast"}`);

  // Metering gate (no-op unless billing is enabled). Debits up front; refunds on failure.
  const gate = await openGate(req, includeGuru ? "deep" : "fast");
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error, balance: gate.balance, cost: gate.cost });

  try {
    // ---- FAST: single agent does everything ----
    if (!includeGuru) {
      const text = await timed("fast", () =>
        createPhase(client, { system: FAST_SOP, userContent: fastUserContent(context, imgBlocks), useTools: true, maxSearches: MAX_SEARCHES })
      );
      const out = normalizeFast(extractJson(text));
      if (gate.billed) out.credits = { balance: gate.balance, charged: gate.cost };
      log(`POST /api/analyze done (fast) in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${out.sources.length} sources`);
      return res.json(out);
    }

    // ---- DEEP: Scout + Guru in PARALLEL, then Specialist ----
    const scoutP = timed("scout", () => createPhase(client, { system: SCOUT_SOP, userContent: scoutUserContent(context, imgBlocks), useTools: true }));
    const guruP = timed("guru", () => createPhase(client, { system: GURU_SOP, userContent: [{ type: "text", text: guruPrompt(context, { product: { name } }) }], useTools: true }));
    const [scoutText, guruText] = await Promise.all([scoutP, guruP]);
    const scout = extractJson(scoutText) || {};
    scout.sources = sanitizeSources(scout.sources);
    const guru = extractJson(guruText) || {};
    guru.reviewSources = sanitizeReviewSources(guru.reviewSources);

    const spec = extractJson(await timed("specialist", () =>
      createPhase(client, { system: SPECIALIST_SOP, userContent: [{ type: "text", text: specialistPrompt(context, scout, guru, true) }], useTools: false })
    )) || {};

    log(`POST /api/analyze done (deep) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const merged = mergeResult(scout, guru, spec, true);
    if (gate.billed) merged.credits = { balance: gate.balance, charged: gate.cost };
    res.json(merged);
  } catch (err) {
    await gate.refund();
    log(`POST /api/analyze ERROR in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(err?.message || err));
    res.status(err?.status || 500).json({ error: "analyze_failed", detail: String(err?.message || err) });
  }
});

// ---------- streaming helpers (Server-Sent Events) ----------
function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function consumeStream(stream, res, phase) {
  const toolBuf = {};
  for await (const event of stream) {
    if (event.type === "content_block_start") {
      const b = event.content_block;
      if (b?.type === "server_tool_use" && b?.name === "web_search") {
        toolBuf[event.index] = "";
      } else if (b?.type === "web_search_tool_result") {
        const arr = Array.isArray(b.content) ? b.content : [];
        const titles = arr.map((r) => r?.title).filter(Boolean).slice(0, 4);
        sse(res, { t: "results", phase, count: arr.length, titles });
      }
    } else if (event.type === "content_block_delta") {
      const d = event.delta;
      if (d?.type === "thinking_delta" && d.thinking) {
        sse(res, { t: "reasoning", phase, text: d.thinking });
      } else if (d?.type === "input_json_delta" && toolBuf[event.index] !== undefined) {
        toolBuf[event.index] += d.partial_json || "";
      }
    } else if (event.type === "content_block_stop") {
      if (toolBuf[event.index] !== undefined) {
        let q = "";
        try { q = JSON.parse(toolBuf[event.index] || "{}").query || ""; } catch {}
        if (q) sse(res, { t: "search", phase, query: q });
        delete toolBuf[event.index];
      }
    }
  }
  const final = await stream.finalMessage();
  return collectText(final);
}

async function runPhase(client, res, phase, { system, userContent, useTools, model = MODEL, think = true, maxTokens }) {
  const base = {
    model,
    max_tokens: maxTokens || (useTools ? 6000 : 4000),
    system: cachedSystem(system),
    messages: [{ role: "user", content: userContent }],
    ...(think ? { thinking: { type: "enabled", budget_tokens: THINK_BUDGET } } : {}),
  };
  const withTools = useTools
    ? { ...base, tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES }] }
    : base;
  try {
    return await consumeStream(client.messages.stream(withTools), res, phase);
  } catch (err) {
    sse(res, { t: "status", phase, text: "Adjusting capabilities and retrying…" });
    const fb = { model, max_tokens: base.max_tokens, system: base.system, messages: base.messages };
    return await consumeStream(client.messages.stream(fb), res, phase);
  }
}

// ---------- /api/analyze/stream : multi-agent live pipeline ----------
app.post("/api/analyze/stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const client = clientFor(req);
  if (!client) { sse(res, { t: "error", error: "missing_key" }); return res.end(); }

  const { name, upc, deep } = req.body || {};
  const imgBlocks = imageBlocksFrom(req.body);
  if (!name && !imgBlocks.length && !upc) { sse(res, { t: "error", error: "need_name_or_image" }); return res.end(); }
  const includeGuru = deep === true; // FAST default; deep (3-agent) opt-in
  const context = buildContext(req.body);
  const t0 = Date.now();
  log(`POST /api/analyze/stream  item="${name || "(photo)"}" mode=${includeGuru ? "deep" : "fast"}`);

  // Metering gate (no-op unless billing is enabled). Debits up front; refunds on failure/abort.
  const gate = await openGate(req, includeGuru ? "deep" : "fast");
  if (!gate.ok) { sse(res, { t: "error", error: gate.error, balance: gate.balance, cost: gate.cost }); return res.end(); }

  // Detect a real client disconnect. NOTE: req "close" fires once the request
  // BODY is fully read (always, immediately), so we must watch the RESPONSE
  // socket closing before it finished instead.
  let aborted = false;
  res.on("close", () => { if (!res.writableEnded) { aborted = true; gate.refund(); } });

  // heartbeat so proxies/browsers don't drop the connection during long thinking gaps
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 10000);

  try {
    // ---- FAST: one streamed agent ----
    if (!includeGuru) {
      sse(res, { t: "phase", phase: "scout", label: "Deal Finder", role: "Price + verdict", status: "start" });
      const text = await runPhase(client, res, "scout", { system: FAST_SOP, userContent: fastUserContent(context, imgBlocks), useTools: true });
      if (aborted) { clearInterval(hb); return res.end(); }
      sse(res, { t: "phase", phase: "scout", status: "done" });
      const out = normalizeFast(extractJson(text));
      if (gate.billed) out.credits = { balance: gate.balance, charged: gate.cost };
      log(`stream done (fast) in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${out.sources.length} sources`);
      sse(res, { t: "done", data: out });
      clearInterval(hb);
      return res.end();
    }

    // ---- DEEP: 3 agents, live ----
    sse(res, { t: "phase", phase: "scout", label: "The Scout", role: "Finds real prices", status: "start" });
    const scoutText = await runPhase(client, res, "scout", { system: SCOUT_SOP, userContent: scoutUserContent(context, imgBlocks), useTools: true });
    if (aborted) { clearInterval(hb); return res.end(); }
    const scout = extractJson(scoutText) || {};
    scout.sources = sanitizeSources(scout.sources);
    sse(res, { t: "phase", phase: "scout", status: "done" });

    sse(res, { t: "phase", phase: "guru", label: "The Gun Guru", role: "Quality & reviews", status: "start" });
    const guruText = await runPhase(client, res, "guru", { system: GURU_SOP, userContent: [{ type: "text", text: guruPrompt(context, scout) }], useTools: true });
    if (aborted) { clearInterval(hb); return res.end(); }
    const guru = extractJson(guruText) || {};
    guru.reviewSources = sanitizeReviewSources(guru.reviewSources);
    sse(res, { t: "phase", phase: "guru", status: "done" });

    sse(res, { t: "phase", phase: "specialist", label: "Deal Specialist", role: "Verdict & counter", status: "start" });
    const specText = await runPhase(client, res, "specialist", { system: SPECIALIST_SOP, userContent: [{ type: "text", text: specialistPrompt(context, scout, guru, true) }], useTools: false });
    if (aborted) { clearInterval(hb); return res.end(); }
    const spec = extractJson(specText) || {};

    log(`stream done (deep) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const merged = mergeResult(scout, guru, spec, true);
    if (gate.billed) merged.credits = { balance: gate.balance, charged: gate.cost };
    sse(res, { t: "done", data: merged });
  } catch (err) {
    await gate.refund();
    log(`stream ERROR in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(err?.message || err));
    sse(res, { t: "error", error: "analyze_failed", detail: String(err?.message || err) });
  }
  clearInterval(hb);
  res.end();
});

// ---------- /api/chat : conversational assistant (item-focused or global) ----------
const CHAT_SOP = [
  "# ROLE",
  "You are the in-app gun-show assistant — a sharp, friendly expert on firearms, parts, optics, ammo, prices,",
  "and gun-show negotiation. You help a shopper who is on the floor right now. Be concise and practical.",
  "",
  "# CONTEXT MODES",
  "- If an ITEM is in focus (provided below), answer about THAT item first, but you may go beyond it and",
  "  search the web or answer anything the user asks.",
  "- If no item is in focus, you have the user's recent searches as background; use them when relevant.",
  "- Use the web_search tool when the user asks about current prices, availability, reviews, or facts you should verify.",
  "",
  "# OUTPUT FORMAT — IMPORTANT",
  "Reply with clean, simple HTML (NOT markdown). Allowed tags ONLY: <p> <b> <i> <ul> <ol> <li> <br>",
  "<strong> <em> <a href> <code> <h4>. No markdown symbols (#, *, **, backticks). Keep paragraphs short.",
  "Use <ul>/<li> for lists. Use <b> for key numbers/verdicts. If you cite a source, link it with <a href>.",
  "Do not include <html>, <body>, <script>, or style attributes. Just the answer HTML.",
].join("\n");

app.post("/api/chat", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });

  const { message, history, item, recentSearches } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: "empty" });

  const ctxParts = [];
  if (item) {
    ctxParts.push(
      "ITEM IN FOCUS:\n```json\n" +
        JSON.stringify(
          {
            product: item.product,
            market: item.market,
            deal: item.deal,
            otd: item.otd,
            quality: item.quality,
            counterOffer: item.counterOffer,
          },
          null,
          2
        ) +
        "\n```"
    );
  } else if (Array.isArray(recentSearches) && recentSearches.length) {
    ctxParts.push("USER'S RECENT SEARCHES (background context):\n" + recentSearches.slice(0, 20).map((s, i) => `${i + 1}. ${s}`).join("\n"));
  }

  // Build a short rolling conversation
  const msgs = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-8)) {
      if (h && (h.role === "user" || h.role === "assistant") && h.content) {
        msgs.push({ role: h.role, content: String(h.content).slice(0, 4000) });
      }
    }
  }
  const userText = (ctxParts.length ? ctxParts.join("\n\n") + "\n\n" : "") + "USER: " + String(message).trim();
  msgs.push({ role: "user", content: userText });

  const params = {
    model: LIGHT_MODEL,
    max_tokens: 1200,
    system: cachedSystem(CHAT_SOP),
    messages: msgs,
  };
  try {
    let message;
    try {
      message = await client.messages.create({ ...params, tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: 4 }] });
    } catch (e) {
      message = await client.messages.create(params); // fallback: no tools
    }
    res.json({ html: collectText(message).trim() });
  } catch (err) {
    res.status(err?.status || 500).json({ error: "chat_failed", detail: String(err?.message || err) });
  }
});

// ---------- /api/reviews : run JUST the Gun Guru for one item (on-demand) ----------
app.post("/api/reviews", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });

  const { name, product } = req.body || {};
  const itemName = name || (product && product.name);
  if (!itemName) return res.status(400).json({ error: "need_name" });
  const t0 = Date.now();
  log(`POST /api/reviews item="${itemName}"`);

  const gate = await openGate(req, "reviews");
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error, balance: gate.balance, cost: gate.cost });

  try {
    const prompt = guruPrompt(`Item: ${itemName}`, { product: product || { name: itemName } });
    const text = await timed("guru-ondemand", () =>
      createPhase(client, { system: GURU_SOP, userContent: [{ type: "text", text: prompt }], useTools: true })
    );
    const guru = extractJson(text) || {};
    log(`POST /api/reviews done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const out = { quality: guru.quality || null, reviewSources: sanitizeReviewSources(guru.reviewSources) };
    if (gate.billed) out.credits = { balance: gate.balance, charged: gate.cost };
    res.json(out);
  } catch (err) {
    await gate.refund();
    log(`POST /api/reviews ERROR in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(err?.message || err));
    res.status(err?.status || 500).json({ error: "reviews_failed", detail: String(err?.message || err) });
  }
});

// ---------- /api/refine : extract new item details from chat (no web search) ----------
app.post("/api/refine", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });

  const { name, condition, askingPrice, details, product, history } = req.body || {};
  const itemName = name || (product && product.name);
  if (!itemName || !Array.isArray(history) || !history.length) {
    return res.status(400).json({ error: "need_context" });
  }
  const t0 = Date.now();
  log(`POST /api/refine item="${itemName}"`);

  // Reuse the same transcript shaping as /api/chat.
  const transcript = history
    .slice(-8)
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && h.content)
    .map((h) => `${h.role === "user" ? "USER" : "ASSISTANT"}: ${String(h.content).slice(0, 4000)}`)
    .join("\n");

  const current = {
    name: itemName,
    condition: condition || null,
    askingPrice: Number.isFinite(Number(askingPrice)) && Number(askingPrice) > 0 ? Number(askingPrice) : null,
    details: details || "",
  };

  try {
    const text = await timed("refine", () =>
      createPhase(client, { system: REFINE_SOP, userContent: [{ type: "text", text: refinePrompt(current, product, transcript) }], useTools: false, model: LIGHT_MODEL, think: false, maxTokens: 800 })
    );
    const out = extractJson(text) || {};
    const price = Number(out.askingPrice);
    const changes = Array.isArray(out.changes) ? out.changes.filter((c) => c && typeof c === "string").slice(0, 6) : [];
    const result = {
      changed: !!out.changed && changes.length > 0,
      name: (typeof out.name === "string" && out.name.trim()) ? out.name.trim() : current.name,
      condition: (typeof out.condition === "string" && out.condition.trim()) ? out.condition.trim() : current.condition,
      askingPrice: Number.isFinite(price) && price > 0 ? price : current.askingPrice,
      details: (typeof out.details === "string") ? out.details.trim() : current.details,
      changes,
    };
    log(`POST /api/refine done in ${((Date.now() - t0) / 1000).toFixed(1)}s, changed=${result.changed}`);
    res.json(result);
  } catch (err) {
    log(`POST /api/refine ERROR in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(err?.message || err));
    res.status(err?.status || 500).json({ error: "refine_failed", detail: String(err?.message || err) });
  }
});

// ---------- /api/credits : the signed-in user's balance + pricing (billing mode only) ----------
app.get("/api/credits", async (req, res) => {
  const cfg = billingConfig();
  if (!cfg.enabled) return res.json({ enabled: false, costs: cfg.costs });
  const user = verifyToken(bearer(req));
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const balance = await getBalance(user.id);
    res.json({ enabled: true, balance, costs: cfg.costs, freeCredits: cfg.freeCredits });
  } catch (err) {
    res.status(503).json({ error: "billing_unavailable", detail: String(err?.message || err) });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasServerKey: !!process.env.ANTHROPIC_API_KEY, billing: billingEnabled() });
});
app.listen(PORT, () => {
  console.log(`Gun Show Deal Finder running on http://localhost:${PORT}`);
});
