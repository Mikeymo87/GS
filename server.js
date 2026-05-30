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
// Covers firearms (new + used/auction), parts/accessories, optics, and ammo.
// The model is told to consult the groups relevant to the detected category.
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

// Robustly pull the last balanced JSON object out of a model response.
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
  return {
    type: "image",
    source: { type: "base64", media_type: m[1], data: m[2] },
  };
}

// Call the model, preferring the web_search tool. If the account/tool isn't
// available, transparently fall back to a no-tool call so the app still works.
async function createWithSearch(client, params) {
  try {
    return await client.messages.create({
      ...params,
      tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES }],
    });
  } catch (err) {
    const status = err?.status;
    const msg = String(err?.message || "");
    if (status === 400 || /tool|web_search|not.*support/i.test(msg)) {
      const m = await client.messages.create(params);
      m._searchUnavailable = true;
      return m;
    }
    throw err;
  }
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
        {
          role: "user",
          content: [
            img,
            { type: "text", text: "Identify this item for a price search. Return only the JSON object." },
          ],
        },
      ],
    });
    const json = extractJson(collectText(message));
    if (!json) return res.status(502).json({ error: "parse_failed", raw: collectText(message) });
    res.json(json);
  } catch (err) {
    res.status(err?.status || 500).json({ error: "identify_failed", detail: String(err?.message || err) });
  }
});

// ---------- /api/analyze : name (+optional photo, asking price) -> deal report ----------
app.post("/api/analyze", async (req, res) => {
  const client = clientFor(req);
  if (!client) return res.status(401).json({ error: "missing_key" });

  const { name, askingPrice, condition, location, image } = req.body || {};
  const imgBlock = image ? dataUrlToImageBlock(image) : null;
  if (!name && !imgBlock) return res.status(400).json({ error: "need_name_or_image" });

  const asking = Number(askingPrice);
  const hasAsking = Number.isFinite(asking) && asking > 0;

  const system = [
    "You are an expert buyer and appraiser helping a shopper standing at a gun-show table RIGHT NOW.",
    "You price ANYTHING firearms-related: complete firearms, AR-platform parts (uppers, lowers, barrels,",
    "BCGs, handguards, triggers), 1911/2011 and Glock parts, magazines, optics, lights, holsters, and AMMUNITION.",
    "First determine the item's category, then use the web_search tool to look up CURRENT real prices for this",
    "EXACT item from several reputable sources, and form a fair average market price.",
    "",
    "Reputable sources, grouped by category (consult the groups relevant to this item):",
    SOURCE_REFERENCE,
    "",
    "For FIREARMS: search both NEW retailers and USED/auction marketplaces (GunBroker, GunsAmerica, Guns.com) so you can advise used-vs-new.",
    "For PARTS/ACCESSORIES/OPTICS: include the parts/optics retailers above plus Amazon and B&H Photo where they carry it; match exact brand + model/part number + fitment.",
    "For AMMUNITION: use AmmoSeek and the ammo retailers; NORMALIZE everything to the SAME quantity as the table item (e.g. per box of 50/20, or per 1000-round case), and also state the price PER ROUND in market.note. Compare apples-to-apples on grain weight and bullet type.",
    "Prefer recent, in-stock, US prices in USD. Cite the store and a URL for each price you use.",
    "",
    "If a PHOTO is provided, use it to confirm the EXACT variant/configuration (generation, finish, barrel length,",
    "rail/optic cut, included accessories, round count) and match your listings to what is actually pictured.",
    "",
    "Form a FAIR 'good price' as the average of the legitimate prices you find (drop obvious outliers / out-of-stock placeholders).",
    "Then rate the table's asking price against that fair price using these bands:",
    "  great = asking is >= 15% BELOW the fair average (or below the cheapest legit listing) -> buy it",
    "  good  = asking is 5-15% below fair average",
    "  ok    = asking is within +/-5% of fair average",
    "  bad   = asking is > 5% ABOVE fair average -> overpriced",
    "If no asking price is given, set deal.rating to \"unknown\" and still report the market range.",
    "Give specific, practical counter-offer advice: a target price, a walk-away price, and a short script the shopper can say,",
    "with the reasoning (cite the comparable prices). For firearms, advise whether a USED version is the smarter buy and why;",
    "for parts/ammo, note if buying online (even after shipping/tax/transfer) beats the table price.",
    "",
    "Respond with EXACTLY ONE JSON object (no prose before/after), matching this schema:",
    `{
  "product": { "name": string, "category": "firearm|part|accessory|optic|magazine|ammo|other", "summary": string, "specs": [string], "msrp": number|null },
  "market": { "currency": "USD", "newLow": number|null, "newHigh": number|null, "usedLow": number|null, "usedHigh": number|null, "fairPrice": number|null, "sampleSize": number, "note": string },
  "sources": [ { "store": string, "title": string, "price": number, "condition": "new"|"used", "url": string, "inStock": boolean|null, "note": string } ],
  "deal": { "rating": "great"|"good"|"ok"|"bad"|"unknown", "score": number, "headline": string, "reasoning": string, "askingPrice": number|null, "vsFairPct": number|null },
  "counterOffer": { "shouldCounter": boolean, "targetPrice": number|null, "walkAwayPrice": number|null, "script": string, "reasoning": string },
  "usedVsNew": string,
  "redFlags": [string]
}`,
    "All prices (market + sources) must be for the SAME quantity/unit as the table item. Put per-round/per-unit math in market.note.",
    "score is 0-100 where higher = better deal for the buyer. Include 6-12 sources when possible, sorted cheapest first.",
  ].join("\n");

  const userText = [
    `Item: ${name || "(identify from the photo first, then search)"}`,
    hasAsking ? `Table asking price: $${asking}` : "Table asking price: (not provided)",
    condition ? `Condition at the table: ${condition}` : null,
    location ? `Location: ${location}` : null,
    "Determine the category, search reputable stores for current prices, form the fair average, rate this deal, and give counter-offer advice. Return only the JSON object.",
  ].filter(Boolean).join("\n");

  const content = [];
  if (imgBlock) content.push(imgBlock);
  content.push({ type: "text", text: userText });

  try {
    const message = await createWithSearch(client, {
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content }],
    });

    const json = extractJson(collectText(message));
    if (!json) {
      return res.status(502).json({ error: "parse_failed", raw: collectText(message).slice(0, 4000) });
    }
    json._meta = {
      model: MODEL,
      searchUnavailable: !!message._searchUnavailable,
      usage: message.usage || null,
    };
    res.json(json);
  } catch (err) {
    res.status(err?.status || 500).json({ error: "analyze_failed", detail: String(err?.message || err) });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasServerKey: !!process.env.ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Gun Show Deal Finder running on http://localhost:${PORT}`);
});
