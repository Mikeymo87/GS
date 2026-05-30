import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "20mb" })); // base64 photos can be large
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
  "item and find REAL, CURRENT market prices. You do NOT rate the deal or negotiate — a separate",
  "Deal Specialist does that. Be accurate and conservative; never invent prices or URLs.",
  "",
  "# STANDARD OPERATING PROCEDURE",
  "1. IDENTIFY: From the name and/or photo, determine the exact item, brand, model/variant, caliber/spec,",
  "   and CATEGORY (firearm | part | accessory | optic | magazine | ammo | other). If a photo is given,",
  "   confirm the precise configuration (generation, finish, barrel length, optic cut, included extras, round count).",
  "2. UNIT: Decide the correct pricing unit. For ammo, lock the quantity to match the table item",
  "   (e.g. per box of 20/50, or per case of 1000) and compute price PER ROUND.",
  "3. SEARCH: Use web_search to pull current listings from the source groups relevant to the category:",
  SOURCE_REFERENCE,
  "4. COVERAGE: For FIREARMS, get BOTH new retailers AND used/auction (GunBroker, GunsAmerica, Guns.com).",
  "   For PARTS/OPTICS/ACCESSORIES, include Amazon & B&H where they carry it; match exact model/part number + fitment.",
  "   For AMMO, use AmmoSeek + ammo retailers and normalize to the same quantity.",
  "5. VALIDATE: Prefer recent, in-stock, US listings in USD. Drop obvious outliers, expired, and out-of-stock placeholders.",
  "6. COMPUTE: fairPrice = the average street price of the legitimate listings (the realistic 'good' price).",
  "   Provide new low/high and used low/high ranges and how many listings you used (sampleSize).",
  "7. NOTE: In market.note, record per-round/per-unit math and any cost-to-compare factors (typical shipping,",
  "   whether an FFL transfer would be required for online firearm purchase).",
  "",
  "# OUTPUT",
  "Respond with EXACTLY ONE JSON object (no prose before/after):",
  `{
  "product": { "name": string, "category": "firearm|part|accessory|optic|magazine|ammo|other", "summary": string, "specs": [string], "msrp": number|null },
  "market": { "currency": "USD", "newLow": number|null, "newHigh": number|null, "usedLow": number|null, "usedHigh": number|null, "fairPrice": number|null, "sampleSize": number, "note": string },
  "sources": [ { "store": string, "title": string, "price": number, "condition": "new"|"used", "url": string, "inStock": boolean|null, "note": string } ]
}`,
  "Include 6-12 real sources when possible, cheapest first. Every source needs a real store, price, and URL you actually found.",
].join("\n");

// ============ AGENT 2: THE GUN SHOW DEAL SPECIALIST (SOP) ============
const SPECIALIST_SOP = [
  "# ROLE",
  "You are a VETERAN GUN SHOW DEAL SPECIALIST. You've worked hundreds of shows on both sides of the table.",
  "You receive THE SCOUT's verified market findings plus the table's asking price, and you deliver the verdict,",
  "the negotiation plan, and what to watch out for. Be street-smart, specific, and honest.",
  "",
  "# WHAT YOU KNOW (apply the relevant parts)",
  "- OUT-THE-DOOR (OTD) MATH: Compare apples to apples. An online price is really price + shipping",
  "  + FFL transfer ($25-75 for firearms) + possible sales tax. A cash table price often has no tax/shipping.",
  "  Factor this so the buyer sees the TRUE delta, not just sticker vs sticker.",
  "- CASH IS KING: Most tables give ~5-10% off for cash. Always have the buyer ask for the cash/out-the-door price first.",
  "- TIMING: Best discounts come late on the final day — vendors don't want to pack inventory. Sunday afternoon is leverage.",
  "- BUNDLES: Adding ammo, a mag, a holster, or an optic can unlock a package price better than buying separately.",
  "- INSPECTION (used firearms): check bore/rifling, lockup & timing, finish wear vs refinish/reblue, import marks,",
  "  matching serial numbers, police trade-in markings, and cracks (especially polymer frames & cast slides).",
  "- COUNTERFEITS / FAKES: watch for fake optics (Trijicon RMR, Aimpoint, EOTech, Holosun clones), counterfeit",
  "  magazines (fake Magpul PMAGs), Glock/1911 clones sold as OEM, and reproduction mil-surplus passed as original.",
  "- TOO-GOOD / RED FLAGS: prices far below market, no paperwork, filed/altered serials, pressure to rush — walk away.",
  "- COST TO FEED & SUPPORT: note caliber availability/price and aftermarket/holster/mag support for the platform.",
  "- LAW: remind the buyer to follow all federal/state/local law and use an FFL where required. You are not giving legal advice.",
  "",
  "# RATING (vs the Scout's fairPrice, considered on an OTD basis)",
  "  great = asking is >= 15% below fair (or below the cheapest legit listing) -> buy it",
  "  good  = asking is 5-15% below fair",
  "  ok    = asking is within +/-5% of fair",
  "  bad   = asking is > 5% above fair -> overpriced",
  "  unknown = no asking price given (still give the market read & a target to offer).",
  "score = 0-100, higher = better for the buyer. vsFairPct = signed % of asking vs fair (negative = below fair).",
  "",
  "# OUTPUT",
  "Respond with EXACTLY ONE JSON object (no prose before/after):",
  `{
  "deal": { "rating": "great"|"good"|"ok"|"bad"|"unknown", "score": number, "headline": string, "reasoning": string, "askingPrice": number|null, "vsFairPct": number|null },
  "counterOffer": { "shouldCounter": boolean, "targetPrice": number|null, "walkAwayPrice": number|null, "script": string, "reasoning": string },
  "usedVsNew": string,
  "redFlags": [string],
  "specialistNotes": [string]
}`,
  "specialistNotes = 3-6 punchy, ITEM-SPECIFIC tactical tips for THIS purchase (cash ask, OTD delta, bundle idea,",
  "what to inspect, fake-spotting). The 'script' is a short line the buyer can actually say at the table.",
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

// ---------- /api/identify : quick photo -> product name ----------
app.post("/api/identify", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });
  const img = dataUrlToImageBlock(req.body?.image);
  if (!img) return res.status(400).json({ error: "no_image" });
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system:
        "You are an expert at identifying anything firearms-related: complete firearms, " +
        "AR-platform parts (uppers, lowers, barrels, BCGs, handguards), 1911/2011 and Glock parts, " +
        "magazines, optics, lights, holsters, suppressors, and AMMUNITION. " +
        "Identify the item in the photo as precisely as possible. For guns: make, model, caliber, " +
        "generation/variant, barrel length, finish, notable features. For parts: brand, model/part number, " +
        "fitment (e.g. AR-15 vs AR-10, Glock gen). For ammo: brand, caliber, grain weight, bullet type, " +
        "and ROUND COUNT on the box. Read any visible tags, price stickers, box labels, or markings. " +
        "Respond ONLY with a JSON object: " +
        '{ "name": "best single search string (brand model caliber/spec)", ' +
        '"category": "firearm|part|accessory|optic|magazine|ammo|other", ' +
        '"confidence": "high|medium|low", "alternatives": ["other possible matches"], ' +
        '"observedPrice": number|null, "quantity": number|null, "notes": "what you see, incl. condition cues" }',
      messages: [
        { role: "user", content: [img, { type: "text", text: "Identify this item for a price search. Return only the JSON object." }] },
      ],
    });
    const json = extractJson(collectText(message));
    if (!json) return res.status(502).json({ error: "parse_failed", raw: collectText(message) });
    res.json(json);
  } catch (err) {
    res.status(err?.status || 500).json({ error: "identify_failed", detail: String(err?.message || err) });
  }
});

// ---------- streaming helpers (Server-Sent Events) ----------
function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Consume a streamed message, emitting reasoning/search/result events live.
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

// Run one agent phase as a stream, with graceful fallback if thinking/tools unsupported.
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
    // Fall back: drop thinking (and tools) if the account/model rejects them.
    sse(res, { t: "status", phase, text: "Adjusting capabilities and retrying…" });
    const fb = { model: MODEL, max_tokens: base.max_tokens, system, messages: base.messages };
    return await consumeStream(client.messages.stream(fb), res, phase);
  }
}

// ---------- /api/analyze/stream : two-agent live pipeline ----------
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

  const { name, askingPrice, condition, location, image } = req.body || {};
  const imgBlock = image ? dataUrlToImageBlock(image) : null;
  if (!name && !imgBlock) { sse(res, { t: "error", error: "need_name_or_image" }); return res.end(); }

  const asking = Number(askingPrice);
  const hasAsking = Number.isFinite(asking) && asking > 0;
  let aborted = false;
  req.on("close", () => { aborted = true; });

  const context = [
    `Item: ${name || "(identify from the photo first)"}`,
    hasAsking ? `Table asking price: $${asking}` : "Table asking price: (not provided)",
    condition ? `Condition at the table: ${condition}` : null,
    location ? `Location: ${location}` : null,
  ].filter(Boolean).join("\n");

  try {
    // ---- Phase 1: The Scout ----
    sse(res, { t: "phase", phase: "scout", label: "The Scout", role: "Finds real prices", status: "start" });
    const scoutContent = [];
    if (imgBlock) scoutContent.push(imgBlock);
    scoutContent.push({ type: "text", text: `${context}\n\nIdentify the item, search reputable stores, and return the market JSON.` });
    const scoutText = await runPhase(client, res, "scout", { system: SCOUT_SOP, userContent: scoutContent, useTools: true });
    if (aborted) return res.end();
    const scout = extractJson(scoutText) || {};
    sse(res, { t: "phase", phase: "scout", status: "done", data: scout });

    // ---- Phase 2: The Gun Show Deal Specialist ----
    sse(res, { t: "phase", phase: "specialist", label: "Gun Show Deal Specialist", role: "Verdict & negotiation", status: "start" });
    const specPrompt = [
      context,
      "",
      "THE SCOUT'S VERIFIED FINDINGS (use these as your market data):",
      "```json",
      JSON.stringify({ product: scout.product, market: scout.market, sources: scout.sources }, null, 2),
      "```",
      "",
      "Now deliver your verdict, counter-offer plan, used-vs-new call, red flags, and tactical notes. Return only the JSON object.",
    ].join("\n");
    const specText = await runPhase(client, res, "specialist", {
      system: SPECIALIST_SOP,
      userContent: [{ type: "text", text: specPrompt }],
      useTools: false,
    });
    if (aborted) return res.end();
    const spec = extractJson(specText) || {};

    const merged = {
      product: scout.product || {},
      market: scout.market || {},
      sources: scout.sources || [],
      deal: spec.deal || { rating: "unknown" },
      counterOffer: spec.counterOffer || {},
      usedVsNew: spec.usedVsNew || "",
      redFlags: spec.redFlags || [],
      specialistNotes: spec.specialistNotes || [],
      _meta: { model: MODEL },
    };
    sse(res, { t: "done", data: merged });
  } catch (err) {
    sse(res, { t: "error", error: "analyze_failed", detail: String(err?.message || err) });
  }
  res.end();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasServerKey: !!process.env.ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Gun Show Deal Finder running on http://localhost:${PORT}`);
});
