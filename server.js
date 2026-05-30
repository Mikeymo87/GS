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

// ----- Reputable sources the model should consult to form an average -----
// High-volume, multi-brand US retailers + used/auction marketplaces (used vs new).
const SOURCES = [
  // Marketplaces & industry leaders (incl. used/auction)
  { name: "GunBroker", domain: "gunbroker.com", used: true },
  { name: "GunsAmerica", domain: "gunsamerica.com", used: true },
  { name: "Guns.com", domain: "guns.com", used: true },
  { name: "Brownells", domain: "brownells.com" },
  { name: "MidwayUSA", domain: "midwayusa.com" },
  { name: "Palmetto State Armory", domain: "palmettostatearmory.com" },
  // High-volume retailers
  { name: "GrabAGun", domain: "grabagun.com" },
  { name: "Bud's Gun Shop", domain: "budsgunshop.com" },
  { name: "Primary Arms", domain: "primaryarms.com" },
  { name: "Kentucky Gun Co (Kygunco)", domain: "kygunco.com" },
  { name: "Rainier Arms", domain: "rainierarms.com" },
  { name: "EuroOptic", domain: "eurooptic.com" },
  { name: "Impact Guns", domain: "impactguns.com", used: true },
  { name: "Classic Firearms", domain: "classicfirearms.com" },
  // Big-box & outdoor superstores
  { name: "Sportsman's Warehouse", domain: "sportsmans.com" },
  { name: "Cabela's", domain: "cabelas.com" },
  { name: "Bass Pro Shops", domain: "basspro.com" },
  { name: "Sportsman's Guide", domain: "sportsmansguide.com" },
  // Enthusiast & high-volume drop shippers
  { name: "AIM Surplus", domain: "aimsurplus.com" },
  { name: "Recoil Gunworks", domain: "recoilgunworks.com" },
  { name: "BattleHawk Armory", domain: "battlehawkarmory.com" },
  { name: "Family Firearms", domain: "familyfirearms.com" },
];
const SOURCE_LIST = SOURCES.map((s) => `${s.name} (${s.domain})`).join(", ");
const USED_SOURCE_LIST = SOURCES.filter((s) => s.used).map((s) => s.name).join(", ");

// Robustly pull the last balanced JSON object out of a model response.
function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  // also try the raw text as a last resort
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
        "You are a firearms and shooting-gear identification expert. Identify the item in the photo " +
        "as precisely as possible (make, model, caliber, variant, notable features). Read any visible " +
        "tags, price stickers, or markings. Respond ONLY with a JSON object: " +
        '{ "name": "best single search string (make model caliber)", "category": "...", ' +
        '"confidence": "high|medium|low", "alternatives": ["other possible matches"], ' +
        '"observedPrice": number|null, "notes": "what you see, incl. condition cues" }',
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
    "You are an expert firearms buyer and appraiser helping a shopper standing at a gun-show table RIGHT NOW.",
    "Use the web_search tool to look up CURRENT real prices for this exact item from several reputable sources",
    "(both NEW retailers and USED/auction marketplaces), then form a fair average market price.",
    `Reputable sources to consult include: ${SOURCE_LIST}.`,
    `For USED/auction comparisons especially, check: ${USED_SOURCE_LIST}.`,
    "Search both new and used listings. Prefer recent, in-stock, US prices in USD. Cite the store and a URL for each price you use.",
    "",
    "Form a FAIR 'good price' as the average of the legitimate prices you find (drop obvious outliers / out-of-stock placeholders).",
    "Then rate the table's asking price against that fair price using these bands:",
    "  great = asking is >= 15% BELOW the fair average (or below the cheapest legit listing) -> buy it",
    "  good  = asking is 5-15% below fair average",
    "  ok    = asking is within +/-5% of fair average",
    "  bad   = asking is > 5% ABOVE fair average -> overpriced",
    "If no asking price is given, set deal.rating to \"unknown\" and still report the market range.",
    "Give specific, practical counter-offer advice: a target price, a walk-away price, and a short script the shopper can say,",
    "with the reasoning (cite the comparable prices). Also advise whether a USED version is the smarter buy and why.",
    "",
    "Respond with EXACTLY ONE JSON object (no prose before/after), matching this schema:",
    `{
  "product": { "name": string, "category": string, "summary": string, "specs": [string], "msrp": number|null },
  "market": { "currency": "USD", "newLow": number|null, "newHigh": number|null, "usedLow": number|null, "usedHigh": number|null, "fairPrice": number|null, "sampleSize": number },
  "sources": [ { "store": string, "title": string, "price": number, "condition": "new"|"used", "url": string, "inStock": boolean|null, "note": string } ],
  "deal": { "rating": "great"|"good"|"ok"|"bad"|"unknown", "score": number, "headline": string, "reasoning": string, "askingPrice": number|null, "vsFairPct": number|null },
  "counterOffer": { "shouldCounter": boolean, "targetPrice": number|null, "walkAwayPrice": number|null, "script": string, "reasoning": string },
  "usedVsNew": string,
  "redFlags": [string]
}`,
    "score is 0-100 where higher = better deal for the buyer. Include 6-12 sources when possible, sorted cheapest first.",
  ].join("\n");

  const userText = [
    `Item: ${name || "(identify from the photo first, then search)"}`,
    hasAsking ? `Table asking price: $${asking}` : "Table asking price: (not provided)",
    condition ? `Condition at the table: ${condition}` : null,
    location ? `Location: ${location}` : null,
    "Search reputable stores for current new AND used prices, form the fair average, rate this deal, and give counter-offer advice. Return only the JSON object.",
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
