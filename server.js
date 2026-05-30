import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "25mb" })); // base64 photos can be large
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const WEB_SEARCH_TOOL = process.env.WEB_SEARCH_TOOL || "web_search_20250305";
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 6);
const THINK_BUDGET = Number(process.env.THINK_BUDGET || 2500);

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
  const { name, askingPrice, condition, location, upc, salesTaxPct, fflFee } = body || {};
  const asking = Number(askingPrice);
  const hasAsking = Number.isFinite(asking) && asking > 0;
  const tax = Number(salesTaxPct);
  const ffl = Number(fflFee);
  return [
    `Item: ${name || "(identify from the photo first)"}`,
    upc ? `UPC/barcode: ${upc}` : null,
    hasAsking ? `Table asking price: $${asking}` : "Table asking price: (not provided)",
    condition ? `Condition at the table: ${condition}` : null,
    location ? `Location: ${location}` : null,
    Number.isFinite(tax) && tax > 0 ? `Buyer's sales tax: ${tax}%` : null,
    Number.isFinite(ffl) && ffl >= 0 ? `Buyer's FFL transfer fee: $${ffl}` : null,
  ].filter(Boolean).join("\n");
}

function scoutUserContent(context, imgBlock) {
  const content = [];
  if (imgBlock) content.push(imgBlock);
  content.push({ type: "text", text: `${context}\n\nIdentify the item, search reputable stores, and return the market JSON with DIRECT product links.` });
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
  const img = dataUrlToImageBlock(req.body?.image);
  const upc = (req.body?.upc || "").toString().trim();
  if (!img && !upc) return res.status(400).json({ error: "no_image" });
  try {
    const content = [];
    if (img) content.push(img);
    content.push({
      type: "text",
      text:
        (upc ? `Scanned UPC/barcode: ${upc}. Use it to identify the exact product. ` : "") +
        "Identify this item for a price search. Return only the JSON object.",
    });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system:
        "You are an expert at identifying anything firearms-related: complete firearms, " +
        "AR-platform parts (uppers, lowers, barrels, BCGs, handguards), 1911/2011 and Glock parts, " +
        "magazines, optics, lights, holsters, suppressors, and AMMUNITION. " +
        "Identify the item as precisely as possible. If a UPC/barcode is provided or visible, read it and use it. " +
        "For guns: make, model, caliber, generation/variant, barrel length, finish. For parts: brand, model/part " +
        "number, fitment (e.g. AR-15 vs AR-10, Glock gen). For ammo: brand, caliber, grain weight, bullet type, " +
        "ROUND COUNT. Read any visible tags, price stickers, box labels, or markings. " +
        "Respond ONLY with a JSON object: " +
        '{ "name": "best single search string (brand model caliber/spec)", ' +
        '"category": "firearm|part|accessory|optic|magazine|ammo|other", ' +
        '"confidence": "high|medium|low", "upc": string|null, "alternatives": ["other possible matches"], ' +
        '"observedPrice": number|null, "quantity": number|null, "notes": "what you see, incl. condition cues" }',
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
async function createPhase(client, { system, userContent, useTools }) {
  const base = {
    model: MODEL,
    max_tokens: useTools ? 6000 : 4000,
    system,
    messages: [{ role: "user", content: userContent }],
    thinking: { type: "enabled", budget_tokens: THINK_BUDGET },
  };
  const withTools = useTools
    ? { ...base, tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES }] }
    : base;
  try {
    return collectText(await client.messages.create(withTools));
  } catch (err) {
    // Drop thinking (and tools) if the account/model rejects them.
    return collectText(await client.messages.create({ model: MODEL, max_tokens: base.max_tokens, system, messages: base.messages }));
  }
}

// ---------- /api/analyze : non-streaming pipeline (used directly + as stream fallback) ----------
app.post("/api/analyze", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });

  const { name, image, upc, deep } = req.body || {};
  const imgBlock = image ? dataUrlToImageBlock(image) : null;
  if (!name && !imgBlock && !upc) return res.status(400).json({ error: "need_name_or_image" });
  const includeGuru = deep !== false;
  const context = buildContext(req.body);

  try {
    const scout = extractJson(await createPhase(client, { system: SCOUT_SOP, userContent: scoutUserContent(context, imgBlock), useTools: true })) || {};
    scout.sources = sanitizeSources(scout.sources);

    let guru = {};
    if (includeGuru) {
      guru = extractJson(await createPhase(client, { system: GURU_SOP, userContent: [{ type: "text", text: guruPrompt(context, scout) }], useTools: true })) || {};
      guru.reviewSources = sanitizeReviewSources(guru.reviewSources);
    }

    const spec = extractJson(await createPhase(client, { system: SPECIALIST_SOP, userContent: [{ type: "text", text: specialistPrompt(context, scout, guru, includeGuru) }], useTools: false })) || {};

    res.json(mergeResult(scout, guru, spec, includeGuru));
  } catch (err) {
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

async function runPhase(client, res, phase, { system, userContent, useTools }) {
  const base = {
    model: MODEL,
    max_tokens: useTools ? 6000 : 4000,
    system,
    messages: [{ role: "user", content: userContent }],
    thinking: { type: "enabled", budget_tokens: THINK_BUDGET },
  };
  const withTools = useTools
    ? { ...base, tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES }] }
    : base;
  try {
    return await consumeStream(client.messages.stream(withTools), res, phase);
  } catch (err) {
    sse(res, { t: "status", phase, text: "Adjusting capabilities and retrying…" });
    const fb = { model: MODEL, max_tokens: base.max_tokens, system, messages: base.messages };
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

  const { name, image, upc, deep } = req.body || {};
  const imgBlock = image ? dataUrlToImageBlock(image) : null;
  if (!name && !imgBlock && !upc) { sse(res, { t: "error", error: "need_name_or_image" }); return res.end(); }
  const includeGuru = deep !== false;
  const context = buildContext(req.body);

  let aborted = false;
  req.on("close", () => { aborted = true; });

  // heartbeat so proxies/browsers don't drop the connection during long thinking gaps
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);

  try {
    sse(res, { t: "phase", phase: "scout", label: "The Scout", role: "Finds real prices", status: "start" });
    const scoutText = await runPhase(client, res, "scout", { system: SCOUT_SOP, userContent: scoutUserContent(context, imgBlock), useTools: true });
    if (aborted) { clearInterval(hb); return res.end(); }
    const scout = extractJson(scoutText) || {};
    scout.sources = sanitizeSources(scout.sources);
    sse(res, { t: "phase", phase: "scout", status: "done" });

    let guru = {};
    if (includeGuru) {
      sse(res, { t: "phase", phase: "guru", label: "The Gun Guru", role: "Quality & reviews", status: "start" });
      const guruText = await runPhase(client, res, "guru", { system: GURU_SOP, userContent: [{ type: "text", text: guruPrompt(context, scout) }], useTools: true });
      if (aborted) { clearInterval(hb); return res.end(); }
      guru = extractJson(guruText) || {};
      guru.reviewSources = sanitizeReviewSources(guru.reviewSources);
      sse(res, { t: "phase", phase: "guru", status: "done" });
    }

    sse(res, { t: "phase", phase: "specialist", label: "Deal Specialist", role: "Verdict & counter", status: "start" });
    const specText = await runPhase(client, res, "specialist", { system: SPECIALIST_SOP, userContent: [{ type: "text", text: specialistPrompt(context, scout, guru, includeGuru) }], useTools: false });
    if (aborted) { clearInterval(hb); return res.end(); }
    const spec = extractJson(specText) || {};

    sse(res, { t: "done", data: mergeResult(scout, guru, spec, includeGuru) });
  } catch (err) {
    sse(res, { t: "error", error: "analyze_failed", detail: String(err?.message || err) });
  }
  clearInterval(hb);
  res.end();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasServerKey: !!process.env.ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Gun Show Deal Finder running on http://localhost:${PORT}`);
});
