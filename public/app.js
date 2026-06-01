"use strict";

const $ = (id) => document.getElementById(id);
const KEY_STORE = "gsdf_api_key";
const HIST_STORE = "gsdf_history";
const DEEP_STORE = "gsdf_deep";
const TAX_STORE = "gsdf_tax";
const FFL_STORE = "gsdf_ffl";
const CACHE_STORE = "gsdf_cache";   // last 20 full results, keyed by search
const CACHE_MAX = 20;

let selectedImages = []; // data URLs (up to 3) — front, markings, box label, etc.
let selectedImage = null; // primary (= selectedImages[0]); kept for scanner/cache compatibility
let scannedUPC = null;
let identifying = false;
let runController = null;
let lastPayload = {};
let lastResult = null;
let pendingDetails = null;   // extra details pulled from chat, applied to the next analyze()
let refining = false;
let lastNudgeAt = 0;

/* ---------------- image helpers ---------------- */
function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

async function fileToResizedDataUrl(file, maxDim = 1600, quality = 0.9) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await loadImg(dataUrl);
  let { width, height } = img;
  if (Math.max(width, height) > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

// Try to read a barcode/UPC from the image using the native BarcodeDetector
// (Android Chrome). On unsupported browsers we just return null and let Claude
// vision read the barcode/label from the photo instead.
async function attemptBarcode(dataUrl) {
  try {
    if (!("BarcodeDetector" in window)) return null;
    const fmts = await window.BarcodeDetector.getSupportedFormats?.().catch(() => null);
    const det = new window.BarcodeDetector(fmts ? { formats: fmts } : undefined);
    const img = await loadImg(dataUrl);
    const codes = await det.detect(img);
    return codes && codes[0] ? codes[0].rawValue : null;
  } catch { return null; }
}

function renderThumbs() {
  const wrap = $("thumbs");
  wrap.innerHTML = selectedImages
    .map((src, i) => `<div class="thumb-item"><img src="${src}" alt="photo ${i + 1}"/><button class="thumb-x" data-i="${i}" aria-label="Remove">✕</button></div>`)
    .join("");
  wrap.querySelectorAll(".thumb-x").forEach((b) => b.addEventListener("click", () => removePhoto(Number(b.dataset.i))));
  $("thumbWrap").classList.toggle("hidden", selectedImages.length === 0);
}

function removePhoto(i) {
  selectedImages.splice(i, 1);
  selectedImage = selectedImages[0] || null;
  renderThumbs();
  if (!selectedImages.length) { $("idStatus").textContent = ""; $("idAlts").innerHTML = ""; }
}

async function onImageChosen(file, opts = {}) {
  const files = Array.isArray(file) ? file : [file];
  let added = null;
  for (const f of files) {
    if (!f) continue;
    if (selectedImages.length >= 3) { toast("Max 3 photos"); break; }
    try { added = await fileToResizedDataUrl(f); selectedImages.push(added); } catch { /* skip */ }
  }
  if (!selectedImages.length) return;
  selectedImage = selectedImages[0];
  renderThumbs();
  $("idStatus").textContent = opts.barcode ? "🔖 Reading barcode…" : "";
  if (opts.barcode && added) {
    scannedUPC = await attemptBarcode(added);
    if (scannedUPC) $("idStatus").textContent = `🔖 UPC ${scannedUPC} — identifying…`;
  }
  identify();
}

function clearImage() {
  selectedImages = [];
  selectedImage = null;
  scannedUPC = null;
  $("thumbs").innerHTML = "";
  $("idAlts").innerHTML = "";
  $("thumbWrap").classList.add("hidden");
  $("cameraInput").value = "";
  $("galleryInput").value = "";
  $("barcodeInput").value = "";
}

/* ---------------- live barcode scanner ---------------- */
let scanStream = null, scanTimer = null, scanReader = null, scanControls = null, scanHandled = false;

async function loadZXing() {
  if (window.ZXingBrowser) return window.ZXingBrowser;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js";
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return window.ZXingBrowser;
}

async function openScanner() {
  hideFormError();
  scanHandled = false;
  $("scanner").classList.remove("hidden");
  const video = $("scanVideo");
  try {
    if ("BarcodeDetector" in window) {
      // Native scanner (Android Chrome, desktop Chrome/Edge)
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false,
      });
      video.srcObject = scanStream;
      await video.play();
      const fmts = await window.BarcodeDetector.getSupportedFormats?.().catch(() => null);
      const det = new window.BarcodeDetector(fmts ? { formats: fmts } : undefined);
      scanTimer = setInterval(async () => {
        try {
          const codes = await det.detect(video);
          if (codes && codes[0]) onScanned(codes[0].rawValue, video);
        } catch {}
      }, 320);
    } else {
      // ZXing fallback (iOS Safari and anything without BarcodeDetector)
      const Z = await loadZXing();
      scanReader = new Z.BrowserMultiFormatReader();
      scanControls = await scanReader.decodeFromVideoDevice(undefined, video, (res) => {
        if (res) onScanned(res.getText(), video);
      });
    }
  } catch (e) {
    closeScanner();
    // Camera blocked/unavailable → fall back to snapping a photo of the barcode
    $("idStatus").textContent = "Camera unavailable — snap the barcode instead";
    $("barcodeInput").click();
  }
}

function onScanned(code, video) {
  if (scanHandled || !code) return;
  scanHandled = true;
  if (navigator.vibrate) navigator.vibrate(90);
  try {
    const c = document.createElement("canvas");
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 480;
    c.getContext("2d").drawImage(video, 0, 0);
    const snap = c.toDataURL("image/jpeg", 0.85);
    if (selectedImages.length < 3) selectedImages.push(snap);
    selectedImage = selectedImages[0] || snap;
    renderThumbs();
  } catch {}
  scannedUPC = code;
  closeScanner();
  $("idStatus").textContent = `🔖 UPC ${code} — identifying…`;
  identify();
}

function closeScanner() {
  $("scanner").classList.add("hidden");
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanControls) { try { scanControls.stop(); } catch {} scanControls = null; }
  if (scanReader) { try { scanReader.reset(); } catch {} scanReader = null; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const v = $("scanVideo");
  if (v) v.srcObject = null;
}

/* ---------------- result cache (saves money on repeat searches) ---------------- */
function cacheKey(p) {
  return [
    (p.name || "").trim().toLowerCase(),
    p.askingPrice || "",
    (p.condition || "").toLowerCase(),
    (p.details || "").trim().toLowerCase(),
    p.deep ? "deep" : "fast",
  ].join("|");
}
function loadCache() { try { return JSON.parse(localStorage.getItem(CACHE_STORE) || "{}"); } catch { return {}; } }
function cacheGet(p) {
  if (!p.name || p.image) return null; // photo runs aren't cached (image not stored)
  const c = loadCache();
  const e = c[cacheKey(p)];
  return e ? e.data : null;
}
function cachePut(p, data) {
  if (!p.name || p.image) return;
  const c = loadCache();
  c[cacheKey(p)] = { data, at: Date.now() };
  // keep only the most recent CACHE_MAX entries
  const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at);
  const trimmed = {};
  keys.slice(0, CACHE_MAX).forEach((k) => (trimmed[k] = c[k]));
  try { localStorage.setItem(CACHE_STORE, JSON.stringify(trimmed)); } catch {}
}

/* ---------------- API ---------------- */
function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  const key = localStorage.getItem(KEY_STORE);
  if (key) h["x-anthropic-key"] = key;
  return h;
}

async function identify() {
  if ((!selectedImages.length && !scannedUPC) || identifying) return;
  identifying = true;
  $("idAlts").innerHTML = "";
  if (!$("idStatus").textContent) $("idStatus").textContent = "🔎 Identifying…";
  try {
    const r = await fetch("/api/identify", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ images: selectedImages, image: selectedImages[0] || null, upc: scannedUPC }),
    });
    if (r.status === 401) {
      $("idStatus").textContent = "⚠️ Add your API key in ⚙️";
      openSettings();
      return;
    }
    const data = await r.json();
    if (data && data.name) {
      if (!$("nameInput").value.trim()) $("nameInput").value = data.name;
      toggleClearName();
      if (data.upc && !scannedUPC) scannedUPC = data.upc;
      const conf = data.confidence ? ` · ${data.confidence} confidence` : "";
      $("idStatus").textContent = `✓ ${data.name}${conf}`;
      if (data.observedPrice && !$("priceInput").value) $("priceInput").value = data.observedPrice;
      renderIdAlts(data.alternatives);
    } else {
      $("idStatus").textContent = "Couldn't ID it — type the name";
    }
  } catch {
    $("idStatus").textContent = "ID failed — type the name";
  } finally {
    identifying = false;
  }
}

// Tappable "not quite? pick the exact match" chips from identify alternatives.
function renderIdAlts(alts) {
  const el = $("idAlts");
  if (!Array.isArray(alts) || !alts.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="alts-label">Not quite? Tap the exact match:</span>` +
    alts.slice(0, 4).map((a) => `<button class="id-alt-chip">${esc(a)}</button>`).join("");
  el.querySelectorAll(".id-alt-chip").forEach((b) =>
    b.addEventListener("click", () => {
      $("nameInput").value = b.textContent;
      toggleClearName();
      $("idStatus").textContent = `✓ ${b.textContent}`;
      el.innerHTML = "";
    })
  );
}

/* ---------------- live activity feed ---------------- */
const PHASE_ICON = { scout: "🔭", guru: "🧠", specialist: "🤝" };
let currentThink = null;

function resetFeed() {
  $("feed").innerHTML = "";
  currentThink = null;
  ["scout", "guru", "specialist"].forEach((p) => $(`agent-${p}`).classList.remove("active", "done"));
}
function feedScroll() { const f = $("feed"); f.scrollTop = f.scrollHeight; }

function finalizeThink() {
  if (currentThink) {
    const c = currentThink.el.querySelector(".cursor");
    if (c) c.remove();
    currentThink = null;
  }
}
function addLine(cls, html) {
  finalizeThink();
  const div = document.createElement("div");
  div.className = `feed-line ${cls}`;
  div.innerHTML = html;
  $("feed").appendChild(div);
  feedScroll();
  return div;
}
function pushReasoning(phase, text) {
  if (!currentThink || currentThink.phase !== phase) {
    finalizeThink();
    const div = document.createElement("div");
    div.className = "feed-line think";
    div.innerHTML = `<span class="ic">💭</span><span class="txt"></span><span class="cursor"></span>`;
    $("feed").appendChild(div);
    currentThink = { el: div, txt: div.querySelector(".txt"), phase };
  }
  let next = currentThink.txt.textContent + text;
  if (next.length > 700) next = "…" + next.slice(next.length - 699);
  currentThink.txt.textContent = next;
  feedScroll();
}
function setAgent(phase, state) {
  const a = $(`agent-${phase}`);
  if (!a) return;
  if (state === "active") { a.classList.add("active"); a.classList.remove("done"); }
  else if (state === "done") { a.classList.remove("active"); a.classList.add("done"); }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function handleEvent(ev) {
  switch (ev.t) {
    case "phase":
      if (ev.status === "start") {
        setAgent(ev.phase, "active");
        addLine("phase", `${PHASE_ICON[ev.phase] || "•"} ${esc(ev.label || ev.phase)} — ${esc(ev.role || "")}`);
      } else if (ev.status === "done") {
        setAgent(ev.phase, "done");
      }
      break;
    case "reasoning":
      pushReasoning(ev.phase, ev.text);
      break;
    case "search":
      addLine("search", `<span class="ic">🔎</span><span>Searching: ${esc(ev.query)}</span>`);
      break;
    case "results": {
      const titles = (ev.titles || []).slice(0, 3).map(esc).join(" · ");
      addLine("result", `<span class="ic">✓</span><span>Found ${ev.count} results${titles ? ` <small>${titles}</small>` : ""}</span>`);
      break;
    }
    case "status":
      addLine("think", `<span class="ic">⚙️</span><span>${esc(ev.text)}</span>`);
      break;
    case "done":
      finalizeThink();
      finishRun(ev.data);
      break;
    case "error":
      finalizeThink();
      stopRun();
      if (ev.error === "missing_key") {
        openSettings();
        showFormError("Add your Anthropic API key in ⚙️ Settings to search.");
      } else {
        showFormError("Search failed: " + (ev.detail || ev.error));
      }
      break;
  }
}

/* ---------------- run the pipeline (SSE) ---------------- */
async function analyze() {
  const name = $("nameInput").value.trim();
  if (!name && !selectedImage && !scannedUPC) {
    showFormError("Take a photo, scan a barcode, or type an item name first.");
    return;
  }
  hideFormError();

  const payload = {
    name,
    askingPrice: $("priceInput").value || null,
    condition: $("conditionInput").value || null,
    image: selectedImages[0] || null,
    images: selectedImages.length ? selectedImages : null,
    upc: scannedUPC || null,
    deep: $("deepToggle").checked,
    details: pendingDetails || null,
    salesTaxPct: localStorage.getItem(TAX_STORE) || null,
    fflFee: localStorage.getItem(FFL_STORE) || null,
  };
  lastPayload = payload;

  // Instant cache hit — no API call, no cost.
  const cached = cacheGet(payload);
  if (cached) {
    $("activity").classList.add("hidden");
    finishRun(cached, { cached: true });
    toast("Loaded from cache — no charge");
    return;
  }

  // Fast mode = a single agent lane; Deep mode = all three.
  $("agent-guru").classList.toggle("hidden", !payload.deep);
  $("agent-specialist").classList.toggle("hidden", !payload.deep);
  $("agent-scout").querySelector(".agent-meta b").textContent = payload.deep ? "The Scout" : "Deal Finder";
  $("agent-scout").querySelector(".agent-meta small").textContent = payload.deep ? "Finds real prices" : "Price + verdict";

  $("analyzeBtn").disabled = true;
  $("results").classList.add("hidden");
  $("results").innerHTML = "";
  resetFeed();
  $("activity").classList.remove("hidden");
  document.querySelector(".activity-title").textContent = "Agents working…";
  $("activity").scrollIntoView({ behavior: "smooth", block: "center" });

  let gotResult = false;
  let streamWorked = false;
  runController = new AbortController();
  try {
    const resp = await fetch("/api/analyze/stream", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload),
      signal: runController.signal,
    });
    if (!resp.ok || !resp.body) throw new Error("stream unavailable (" + resp.status + ")");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamWorked = true;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.t === "done") gotResult = true;
          handleEvent(ev);
        }
      }
    }
    // Stream ended without delivering a result → fall back to a plain request.
    if (!gotResult) await analyzeFallback(payload);
  } catch (e) {
    if (e.name === "AbortError") return;
    // Streaming failed entirely (network/proxy/Safari) → reliable non-streaming path.
    await analyzeFallback(payload, !streamWorked);
  } finally {
    $("analyzeBtn").disabled = false;
  }
}

// Reliable fallback: one normal POST that returns the full result. Works on
// networks/browsers where Server-Sent Events get buffered or dropped.
async function analyzeFallback(payload, quiet) {
  try {
    if (!quiet) addLine("status", `<span class="ic">⚙️</span><span>Live view unavailable — finishing the analysis…</span>`);
    document.querySelector(".activity-title").textContent = payload.deep ? "Working… (~30–60s)" : "Working… (~15–30s)";
    const lanes = payload.deep ? ["scout", "guru", "specialist"] : ["scout"];
    lanes.forEach((p) => setAgent(p, "active"));
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      stopRun();
      if (data.error === "missing_key" || resp.status === 401) {
        openSettings();
        showFormError("Add your Anthropic API key in ⚙️ Settings to search.");
      } else {
        showFormError("Search failed: " + (data.detail || data.error || resp.status));
      }
      return;
    }
    (payload.deep ? ["scout", "guru", "specialist"] : ["scout"]).forEach((p) => setAgent(p, "done"));
    finishRun(data);
  } catch (e) {
    stopRun();
    showFormError("Couldn't reach the server. Check your connection and try again.");
  }
}

function stopRun() {
  if (runController) { try { runController.abort(); } catch {} runController = null; }
  $("analyzeBtn").disabled = false;
  $("activity").classList.add("hidden");
}

function finishRun(data, opts = {}) {
  lastResult = data;
  $("analyzeBtn").disabled = false;
  document.querySelector(".activity-title").textContent = "Done";
  renderResults(data, lastPayload);
  if (!opts.cached) {
    cachePut(lastPayload, data);
    saveHistory(data);
  }
  setChatScope();
  setTimeout(() => $("activity").classList.add("hidden"), 400);
}

/* ---------------- rendering ---------------- */
const money = (n) =>
  n == null || n === "" || isNaN(n)
    ? "—"
    : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const RATING_LABEL = { great: "Great deal", good: "Good deal", ok: "OK deal", bad: "Bad deal", unknown: "Market read" };
const TIER_LABEL = { "top-tier": "Top tier", solid: "Solid", "budget-ok": "Budget-OK", chinesium: "Chinesium ⚠️" };

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function favicon(url) {
  const d = domainOf(url);
  return d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64` : "";
}

function renderResults(d, payload) {
  payload = payload || {};
  const deal = d.deal || {};
  const rating = (deal.rating || "unknown").toLowerCase();
  const market = d.market || {};
  const product = d.product || {};
  const counter = d.counterOffer || {};
  const quality = d.quality || null;
  const notes = Array.isArray(d.specialistNotes) ? d.specialistNotes : [];
  const reviews = Array.isArray(d.reviewSources) ? d.reviewSources : [];
  const sources = Array.isArray(d.sources) ? [...d.sources] : [];
  sources.sort((a, b) => (Number(a.price) || 1e12) - (Number(b.price) || 1e12));

  const score = deal.score != null ? Math.round(deal.score) : null;
  const vsPct = deal.vsFairPct;

  let html = "";

  // verdict + gauge
  html += `<div class="verdict ${esc(rating)}">
    <div class="verdict-body">
      <div class="verdict-rating">${esc(RATING_LABEL[rating] || rating)}</div>
      <h2 class="verdict-headline">${esc(deal.headline || product.name || "Result")}</h2>
      ${deal.reasoning ? `<p class="verdict-reason">${esc(deal.reasoning)}</p>` : ""}
    </div>
    ${score != null ? `<div class="gauge" data-score="${score}"><div class="gauge-num"><b>${score}</b><small>SCORE</small></div></div>` : ""}
  </div>`;

  // action bar
  html += `<div class="action-bar">
    <button class="ghost-btn small" id="negotiateBtn">💬 Negotiate</button>
    ${!quality ? `<button class="ghost-btn small" id="reviewsBtn">🧠 Check reviews</button>` : ""}
    <button class="ghost-btn small" id="shareBtn">📤 Share</button>
  </div>`;

  // price summary
  html += `<div class="card">
    <div class="section-title">Market price</div>
    <div class="price-summary">
      <div class="psum"><small>New</small><b>${money(market.newLow)}${market.newHigh ? "–" + money(market.newHigh).replace("$", "") : ""}</b></div>
      <div class="psum fair"><small>Fair avg</small><b>${money(market.fairPrice)}</b></div>
      <div class="psum"><small>Used</small><b>${money(market.usedLow)}${market.usedHigh ? "–" + money(market.usedHigh).replace("$", "") : ""}</b></div>
    </div>
    ${market.note ? `<p class="muted-p" style="margin-top:8px">${esc(market.note)}</p>` : ""}
    ${
      payload.askingPrice
        ? `<p class="muted-p">Their price <b>${money(payload.askingPrice)}</b>${
            vsPct != null ? ` is <b>${vsPct > 0 ? "+" : ""}${Math.round(vsPct)}%</b> vs the fair average.` : "."
          }</p>`
        : ""
    }
  </div>`;

  // out-the-door comparison
  const otd = d.otd || null;
  if (otd && (otd.tableOTD != null || otd.onlineOTD != null)) {
    const cheaper = (otd.cheaper || "").toLowerCase();
    html += `<div class="card">
      <div class="section-title">🚪 Out-the-door — true cost</div>
      <div class="co-prices">
        <div class="co-box ${cheaper === "table" ? "target" : ""}"><small>At the table (cash)</small><b>${money(otd.tableOTD)}</b></div>
        <div class="co-box ${cheaper === "online" ? "target" : ""}"><small>Cheapest online +ship/tax${product.category === "firearm" ? "/FFL" : ""}</small><b>${money(otd.onlineOTD)}</b></div>
      </div>
      ${
        cheaper && otd.delta != null
          ? `<p class="muted-p"><b>${cheaper === "even" ? "About even" : (cheaper === "table" ? "Table wins" : "Online wins")}</b>${cheaper !== "even" ? ` by ${money(otd.delta)}` : ""}.</p>`
          : ""
      }
      ${otd.explanation ? `<p class="muted-p">${esc(otd.explanation)}</p>` : ""}
    </div>`;
  }

  // quality (Gun Guru)
  if (quality && quality.tier) {
    const tier = String(quality.tier).toLowerCase();
    html += `<div class="card">
      <div class="section-title">🧠 Gun Guru — quality check</div>
      <div class="quality-head">
        <span class="tier tier-${esc(tier)}">${esc(TIER_LABEL[tier] || tier)}</span>
        ${quality.score != null ? `<span class="tier-score">${Math.round(quality.score)}<small>/100</small></span>` : ""}
      </div>
      ${quality.verdict ? `<p class="muted-p" style="margin-top:6px">${esc(quality.verdict)}</p>` : ""}
      ${
        Array.isArray(quality.pros) && quality.pros.length
          ? `<ul class="pc pros">${quality.pros.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""
      }
      ${
        Array.isArray(quality.cons) && quality.cons.length
          ? `<ul class="pc cons">${quality.cons.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""
      }
      ${
        Array.isArray(quality.knownIssues) && quality.knownIssues.length
          ? `<p class="muted-p"><b>Known issues:</b> ${quality.knownIssues.map(esc).join("; ")}</p>` : ""
      }
      ${
        Array.isArray(quality.alternatives) && quality.alternatives.length
          ? `<div class="alts"><b>Consider instead:</b>${quality.alternatives.map((a) => `<div class="alt"><b>${esc(a.name)}</b> — ${esc(a.why)}</div>`).join("")}</div>` : ""
      }
    </div>`;
  }

  // counter offer playbook
  html += `<div class="card counter">
    <div class="section-title">💬 Counter-offer playbook</div>
    <div class="co-prices">
      <div class="co-box target"><small>Offer this</small><b>${money(counter.targetPrice)}</b></div>
      <div class="co-box walk"><small>Walk away above</small><b>${money(counter.walkAwayPrice)}</b></div>
    </div>
    ${counter.script ? `<div class="script">“${esc(counter.script)}”</div>` : ""}
    ${counter.reasoning ? `<p class="muted-p">${esc(counter.reasoning)}</p>` : ""}
  </div>`;

  // specialist tactical notes
  if (notes.length) {
    html += `<div class="card">
      <div class="section-title">🤝 Specialist's playbook</div>
      <ul class="notes-list">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    </div>`;
  }

  // price sources (verifiable links)
  if (sources.length) {
    html += `<div class="card">
      <div class="section-title">Price sources — tap to verify (${sources.length})</div>
      <div class="sources">
        ${sources
          .map((s, i) => {
            const cond = (s.condition || "").toLowerCase() === "used" ? "used" : "new";
            const cheap = i === 0 ? "src-cheapest" : "";
            const dom = s.url ? domainOf(s.url) : "";
            const fav = s.url ? `<img class="fav" src="${esc(favicon(s.url))}" alt="" loading="lazy" onerror="this.style.display='none'"/>` : `<span class="src-rank">${i + 1}</span>`;
            const inner = `
              ${fav}
              <div class="src-main">
                <div class="src-store">${esc(s.store || dom || "Store")}<span class="badge ${cond}">${cond}</span></div>
                <div class="src-title">${esc(s.title || "")}${s.inStock === false ? " · out of stock" : ""}</div>
                ${dom ? `<div class="src-dom">${esc(dom)} ↗</div>` : `<div class="src-dom no-link">no direct link</div>`}
              </div>
              <div class="src-price">${money(s.price)}</div>`;
            return s.url
              ? `<a class="src ${cheap}" href="${esc(s.url)}" target="_blank" rel="noopener">${inner}</a>`
              : `<div class="src ${cheap}">${inner}</div>`;
          })
          .join("")}
      </div>
    </div>`;
  }

  // review sources
  if (reviews.length) {
    html += `<div class="card">
      <div class="section-title">📚 Reviews &amp; threads</div>
      <div class="sources">
        ${reviews
          .map((r) => {
            const dom = domainOf(r.url);
            return `<a class="src" href="${esc(r.url)}" target="_blank" rel="noopener">
              <img class="fav" src="${esc(favicon(r.url))}" alt="" loading="lazy" onerror="this.style.display='none'"/>
              <div class="src-main">
                <div class="src-store">${esc(r.source || dom)}</div>
                <div class="src-title">${esc(r.title || "")}</div>
              </div>
              <div class="src-dom">↗</div>
            </a>`;
          })
          .join("")}
      </div>
    </div>`;
  }

  // product
  if (product.summary || (product.specs && product.specs.length)) {
    html += `<div class="card">
      <div class="section-title">About this item</div>
      <div style="font-weight:700;margin-bottom:4px">${esc(product.name || "")}</div>
      ${product.summary ? `<p class="muted-p" style="margin-top:0">${esc(product.summary)}</p>` : ""}
      ${product.msrp ? `<p class="muted-p">MSRP: ${money(product.msrp)}</p>` : ""}
      ${
        Array.isArray(product.specs) && product.specs.length
          ? `<ul class="specs">${product.specs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""
      }
    </div>`;
  }

  // used vs new
  if (d.usedVsNew) {
    html += `<div class="card">
      <div class="section-title">Used vs. new</div>
      <p class="muted-p" style="margin-top:0">${esc(d.usedVsNew)}</p>
    </div>`;
  }

  // red flags
  if (Array.isArray(d.redFlags) && d.redFlags.length) {
    html += `<div class="card">
      <div class="section-title">⚠️ Watch out for</div>
      <ul class="redflags">${d.redFlags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    </div>`;
  }

  html += `<button class="primary-btn new-search" onclick="window.scrollTo({top:0,behavior:'smooth'})"><span class="btn-label">↑ New search</span></button>`;

  $("results").innerHTML = html;
  $("results").classList.remove("hidden");
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });

  const g = $("results").querySelector(".gauge");
  if (g) requestAnimationFrame(() => g.style.setProperty("--p", g.dataset.score));
  const sb = $("shareBtn");
  if (sb) sb.addEventListener("click", shareResult);
  const nb = $("negotiateBtn");
  if (nb) nb.addEventListener("click", openNegotiate);
  const rb = $("reviewsBtn");
  if (rb) rb.addEventListener("click", () => fetchReviews(rb));
}

// On-demand Gun Guru: fetch quality/reviews for the current item only.
async function fetchReviews(btn) {
  if (!lastResult || !lastResult.product) return;
  btn.disabled = true;
  btn.innerHTML = `🧠 Checking…`;
  try {
    const resp = await fetch("/api/reviews", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ name: lastResult.product.name, product: lastResult.product }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      if (data.error === "missing_key" || resp.status === 401) { openSettings(); }
      else { toast("Couldn't load reviews"); }
      btn.disabled = false; btn.innerHTML = "🧠 Check reviews";
      return;
    }
    // merge into the result and re-render (quality card now shows, button drops off)
    lastResult.quality = data.quality;
    lastResult.reviewSources = data.reviewSources || [];
    // keep the cache copy in sync so it persists without another call
    cachePut(lastPayload, lastResult);
    renderResults(lastResult, lastPayload);
  } catch {
    toast("Couldn't reach the server");
    btn.disabled = false; btn.innerHTML = "🧠 Check reviews";
  }
}

// Open chat focused on the item, pre-seeded for negotiation.
function openNegotiate() {
  openChat();
  const ask = lastPayload && lastPayload.askingPrice ? ` They're asking ${money(lastPayload.askingPrice)}.` : "";
  sendChat(`Help me negotiate this${ask} What should I open with, what's my walk-away, and exactly what do I say?`);
}

/* ---------------- refine search from chat ---------------- */
// Show/hide the persistent "Update search" button as item focus changes.
function updateRefineBar() {
  const bar = $("chatRefineBar");
  if (!bar) return;
  const focused = !!(lastResult && lastResult.product);
  if (!focused) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  if (!bar.querySelector("#refineBtn") && !bar.querySelector(".refine-card")) {
    bar.innerHTML = `<button id="refineBtn" class="ghost-btn small refine-btn">✏️ Update search with new details</button>`;
    bar.querySelector("#refineBtn").addEventListener("click", () => requestRefine());
  }
  bar.classList.remove("hidden");
}

// Cheap client-side heuristic: does this message look like it adds a new item detail?
function looksLikeNewDetail(text) {
  const t = String(text || "");
  return (
    /\bgen\s?\d/i.test(t) ||
    /\b(mod|model)\s?\d/i.test(t) ||
    /threaded|barrel|\d+(\.\d+)?\s?(in|")/i.test(t) ||
    /\b(\d+\s*)?(mag|magazine|holster|case|optic|red ?dot|sight|ammo|box|round)s?\b/i.test(t) ||
    /\b(wear|scratch|holster wear|like new|new in box|nib|mint|refinish|reblue|blem)\b/i.test(t) ||
    /\$\s?\d+|\b\d{2,4}\s?(cash|out the door|otd|firm)\b|they('| wi)ll do\b/i.test(t)
  );
}

// Surface a stronger nudge once the heuristic fires (debounced).
function showRefineNudge() {
  const bar = $("chatRefineBar");
  if (!bar || refining) return;
  if (Date.now() - lastNudgeAt < 8000) return; // debounce
  lastNudgeAt = Date.now();
  const btn = bar.querySelector("#refineBtn");
  if (btn) { btn.classList.add("nudge"); btn.innerHTML = "✨ New details — update the deal check?"; }
}

async function requestRefine() {
  if (!lastResult || !lastResult.product || refining) return;
  refining = true;
  const bar = $("chatRefineBar");
  const btn = bar && bar.querySelector("#refineBtn");
  if (btn) { btn.disabled = true; btn.classList.remove("nudge"); btn.innerHTML = "Reading the details…"; }
  try {
    const resp = await fetch("/api/refine", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        name: lastPayload.name || lastResult.product.name,
        condition: lastPayload.condition || null,
        askingPrice: lastPayload.askingPrice || null,
        details: lastPayload.details || pendingDetails || "",
        product: lastResult.product,
        history: chatHistory.map((m) => ({ role: m.role, content: m.role === "assistant" ? (m._plain || m.content) : m.content })),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      if (data.error === "missing_key" || resp.status === 401) openSettings();
      else toast("Couldn't read the details");
      refining = false; updateRefineBar(); return;
    }
    refining = false;
    if (!data.changed || !data.changes.length) {
      toast("No new details to add");
      updateRefineBar();
      return;
    }
    showRefineConfirm(data);
  } catch {
    toast("Couldn't reach the server");
    refining = false; updateRefineBar();
  }
}

function showRefineConfirm(data) {
  const bar = $("chatRefineBar");
  if (!bar) return;
  bar.classList.remove("hidden");
  bar.innerHTML =
    `<div class="refine-card">
      <div class="refine-title">Update the deal check with:</div>
      <ul class="refine-changes">${data.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <div class="refine-actions">
        <button class="primary-btn small" id="refineConfirm"><span class="btn-label">Update &amp; re-run</span></button>
        <button class="ghost-btn small" id="refineCancel">Cancel</button>
      </div>
    </div>`;
  bar.querySelector("#refineConfirm").addEventListener("click", () => applyRefine(data));
  bar.querySelector("#refineCancel").addEventListener("click", () => { updateRefineBar(); });
}

// Match a freeform condition string to one of the fixed <select> options if possible.
function setConditionValue(s) {
  if (!s) return;
  const sel = $("conditionInput");
  const want = String(s).toLowerCase();
  for (const opt of sel.options) {
    if (opt.value && (opt.value.toLowerCase() === want || want.includes(opt.value.toLowerCase()))) {
      sel.value = opt.value;
      return;
    }
  }
  // no exact match — leave the select; the nuance still rides along in details
}

function applyRefine(data) {
  if (data.name) { $("nameInput").value = data.name; toggleClearName(); }
  if (data.askingPrice != null) $("priceInput").value = data.askingPrice;
  if (data.condition) setConditionValue(data.condition);
  pendingDetails = data.details || pendingDetails || null;
  const bar = $("chatRefineBar");
  if (bar) { bar.innerHTML = ""; bar.classList.add("hidden"); }
  addBubble("bot", "Updated the deal check with your new details — see the refreshed report above.");
  window.scrollTo({ top: 0, behavior: "smooth" });
  analyze(); // finishRun() will re-render, re-cache, and resync chat scope
}

/* ---------------- share ---------------- */
function shareResult() {
  const d = lastResult || {};
  const deal = d.deal || {};
  const m = d.market || {};
  const c = d.counterOffer || {};
  const lines = [
    `${(d.product && d.product.name) || "Item"} — ${RATING_LABEL[(deal.rating || "unknown")] || ""}`,
    lastPayload.askingPrice ? `Asking: ${money(lastPayload.askingPrice)}` : null,
    m.fairPrice ? `Fair price: ${money(m.fairPrice)}` : null,
    c.targetPrice ? `Offer: ${money(c.targetPrice)} (walk above ${money(c.walkAwayPrice)})` : null,
    d.quality && d.quality.tier ? `Quality: ${TIER_LABEL[d.quality.tier] || d.quality.tier}` : null,
    deal.headline ? `“${deal.headline}”` : null,
  ].filter(Boolean);
  const text = lines.join("\n");
  if (navigator.share) {
    navigator.share({ title: "Gun Show Deal Finder", text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard")).catch(() => toast("Couldn't copy"));
  } else {
    toast("Sharing not supported");
  }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 1800);
}

/* ---------------- history ---------------- */
function loadHistory() { try { return JSON.parse(localStorage.getItem(HIST_STORE) || "[]"); } catch { return []; } }
function saveHistory(d) {
  const hist = loadHistory().filter((h) => h.key !== cacheKey(lastPayload));
  hist.unshift({
    name: (d.product && d.product.name) || lastPayload.name || "Item",
    rating: (d.deal && d.deal.rating) || "unknown",
    fair: d.market && d.market.fairPrice,
    key: cacheKey(lastPayload),
    query: lastPayload.name || "",
    askingPrice: lastPayload.askingPrice || null,
    condition: lastPayload.condition || null,
    details: lastPayload.details || null,
    deep: !!lastPayload.deep,
    at: Date.now(),
  });
  localStorage.setItem(HIST_STORE, JSON.stringify(hist.slice(0, CACHE_MAX)));
  renderHistory();
}
function renderHistory() {
  const hist = loadHistory();
  const sec = $("historySection");
  if (!hist.length) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  const cache = loadCache();
  $("historyList").innerHTML = hist
    .map((h, i) => {
      const r = (h.rating || "unknown").toLowerCase();
      const cached = h.key && cache[h.key];
      return `<li data-i="${i}" class="h-item">
        <span class="h-name">${esc(h.name)}</span>
        ${cached ? `<span class="h-cached" title="Cached — reloads free">⚡</span>` : ""}
        <span style="color:var(--muted);font-size:13px">${h.fair ? money(h.fair) : ""}</span>
        <span class="h-pill ${r}">${esc(r)}</span>
      </li>`;
    })
    .join("");
  $("historyList").querySelectorAll(".h-item").forEach((li) => {
    li.addEventListener("click", () => reloadHistory(hist[Number(li.dataset.i)]));
  });
}

// Tapping a history row repopulates the form and re-runs (cache → instant & free).
function reloadHistory(h) {
  if (!h) return;
  clearImage();
  $("nameInput").value = h.query || h.name || "";
  $("priceInput").value = h.askingPrice || "";
  $("conditionInput").value = h.condition || "";
  $("deepToggle").checked = !!h.deep;
  pendingDetails = h.details || null;
  toggleClearName();
  window.scrollTo({ top: 0, behavior: "smooth" });
  analyze();
}

/* ---------------- settings ---------------- */
function openSettings() {
  $("keyInput").value = localStorage.getItem(KEY_STORE) || "";
  $("taxInput").value = localStorage.getItem(TAX_STORE) || "";
  $("fflInput").value = localStorage.getItem(FFL_STORE) || "";
  updateKeyStatus();
  $("settingsModal").classList.remove("hidden");
}
function closeSettings() { $("settingsModal").classList.add("hidden"); }
async function updateKeyStatus() {
  const el = $("keyStatus");
  try {
    const h = await (await fetch("/api/health")).json();
    if (localStorage.getItem(KEY_STORE)) {
      el.textContent = "✓ Using your saved key on this device."; el.className = "key-status ok";
    } else if (h.hasServerKey) {
      el.textContent = "✓ Server key detected — you're ready to go."; el.className = "key-status ok";
    } else {
      el.textContent = "⚠️ No key set. Paste one to start searching."; el.className = "key-status warn";
    }
  } catch { el.textContent = ""; }
}

/* ---------------- form helpers ---------------- */
function showFormError(msg) { const e = $("formError"); e.textContent = msg; e.classList.remove("hidden"); }
function hideFormError() { $("formError").classList.add("hidden"); }

/* ---------------- wire up ---------------- */
$("cameraInput").addEventListener("change", (e) => onImageChosen(e.target.files[0]));
$("barcodeInput").addEventListener("change", (e) => onImageChosen(e.target.files[0], { barcode: true }));
$("galleryInput").addEventListener("change", (e) => onImageChosen([...e.target.files]));
$("scanBtn").addEventListener("click", openScanner);
$("scanClose").addEventListener("click", closeScanner);
$("clearThumb")?.addEventListener("click", clearImage);
$("analyzeBtn").addEventListener("click", analyze);
$("cancelRun").addEventListener("click", stopRun);
$("settingsBtn").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", closeSettings);
$("settingsModal").addEventListener("click", (e) => { if (e.target === $("settingsModal")) closeSettings(); });
$("saveKey").addEventListener("click", () => {
  const v = $("keyInput").value.trim();
  if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE);
  const tax = $("taxInput").value.trim();
  if (tax) localStorage.setItem(TAX_STORE, tax); else localStorage.removeItem(TAX_STORE);
  const ffl = $("fflInput").value.trim();
  if (ffl) localStorage.setItem(FFL_STORE, ffl); else localStorage.removeItem(FFL_STORE);
  updateKeyStatus();
  setTimeout(closeSettings, 600);
});
$("clearHistory").addEventListener("click", () => { localStorage.removeItem(HIST_STORE); renderHistory(); });
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });
$("nameInput").addEventListener("input", () => { toggleClearName(); pendingDetails = null; });
$("clearName").addEventListener("click", () => { $("nameInput").value = ""; toggleClearName(); $("nameInput").focus(); });
$("deepToggle").addEventListener("change", (e) => localStorage.setItem(DEEP_STORE, e.target.checked ? "1" : "0"));

function toggleClearName() { $("clearName").classList.toggle("hidden", !$("nameInput").value); }

// restore deep-mode preference (Fast is the default; only restore if user turned Deep on)
if (localStorage.getItem(DEEP_STORE) === "1") $("deepToggle").checked = true;
toggleClearName();
renderHistory();
initChat();

(async () => {
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.hasServerKey && !localStorage.getItem(KEY_STORE)) openSettings();
  } catch {}
})();

/* ---------------- chat ---------------- */
let chatHistory = [];     // {role, content(plain for user / html for bot)}
let chatBusy = false;

const CHAT_TAGS = { P:1, B:1, I:1, EM:1, STRONG:1, UL:1, OL:1, LI:1, BR:1, A:1, CODE:1, H4:1 };

// Sanitize model HTML to a safe allowlist (no scripts/styles/handlers).
function sanitizeHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html || "");
  (function walk(node) {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 1) {
        if (!CHAT_TAGS[n.tagName]) { n.replaceWith(...n.childNodes); walk(node); return; }
        [...n.attributes].forEach((a) => {
          const ok = n.tagName === "A" && a.name === "href" && /^https?:/i.test(a.value);
          if (!ok) n.removeAttribute(a.name);
        });
        if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); }
        walk(n);
      } else if (n.nodeType !== 3) {
        n.remove();
      }
    });
  })(tmp);
  return tmp.innerHTML;
}

function initChat() {
  $("chatFab").addEventListener("click", openChat);
  $("chatClose").addEventListener("click", () => $("chatPanel").classList.add("hidden"));
  $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat($("chatText").value); });
}

function setChatScope() {
  const focused = !!(lastResult && lastResult.product);
  const name = focused ? (lastResult.product.name || "this item") : null;
  $("chatScope").textContent = focused ? `Focused on: ${name}` : "All your searches";
  updateRefineBar();
}

function chatChips() {
  const focused = !!(lastResult && lastResult.product);
  const chips = focused
    ? ["Is this a good price?", "How low should I offer?", "Common problems?", "Better alternative?", "New vs used?"]
    : ["What was my best deal?", "Cheapest 9mm right now?", "Is a Holosun 507C worth it?", "AR barrel buying tips"];
  $("chatChips").innerHTML = chips.map((c) => `<button class="chip">${esc(c)}</button>`).join("");
  $("chatChips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => sendChat(b.textContent)));
}

function openChat() {
  setChatScope();
  if (!chatHistory.length) {
    const focused = !!(lastResult && lastResult.product);
    $("chatMessages").innerHTML = `<div class="chat-empty">${
      focused
        ? "Ask me anything about <b>" + esc(lastResult.product.name || "this item") + "</b> — price, negotiation, quality, alternatives. I can also look things up."
        : "Ask me anything — about your searches, current prices, gear advice, or gun-show tips. I can search the web too."
    }</div>`;
  }
  chatChips();
  $("chatPanel").classList.remove("hidden");
  setTimeout(() => $("chatText").focus(), 100);
}

function addBubble(cls, html) {
  const empty = $("chatMessages").querySelector(".chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `bubble ${cls}`;
  div.innerHTML = html;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  return div;
}

async function sendChat(text) {
  text = (text || "").trim();
  if (!text || chatBusy) return;
  if (!localStorage.getItem(KEY_STORE)) {
    // still allow server key; only block if neither exists (health says so)
  }
  chatBusy = true;
  $("chatText").value = "";
  $("chatSend").disabled = true;
  addBubble("user", esc(text));
  chatHistory.push({ role: "user", content: text });
  const typing = addBubble("bot typing", `<span class="dots"><span></span><span></span><span></span></span>`);

  const recentSearches = loadHistory().map((h) => h.name).filter(Boolean);
  const item = lastResult && lastResult.product ? lastResult : null;

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        message: text,
        history: chatHistory.slice(0, -1).map((m) => ({ role: m.role, content: m.role === "assistant" ? m._plain || m.content : m.content })),
        item,
        recentSearches,
      }),
    });
    const data = await resp.json();
    typing.remove();
    if (!resp.ok || data.error) {
      if (data.error === "missing_key" || resp.status === 401) {
        addBubble("bot", "Add your Anthropic API key in <b>⚙️ Settings</b> to use chat.");
        openSettings();
      } else {
        addBubble("bot", "Sorry — " + esc(data.detail || data.error || "something went wrong") + ".");
      }
    } else {
      const safe = sanitizeHtml(data.html);
      const b = addBubble("bot", safe || "(no answer)");
      chatHistory.push({ role: "assistant", content: safe, _plain: b.textContent });
      // If the user's message looks like it added a new item detail, nudge to refine.
      if (item && looksLikeNewDetail(text)) showRefineNudge();
    }
  } catch (e) {
    typing.remove();
    addBubble("bot", "Couldn't reach the server. Check your connection and try again.");
  } finally {
    chatBusy = false;
    $("chatSend").disabled = false;
    $("chatText").focus();
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
