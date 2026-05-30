"use strict";

const $ = (id) => document.getElementById(id);
const KEY_STORE = "gsdf_api_key";
const HIST_STORE = "gsdf_history";
const DEEP_STORE = "gsdf_deep";

let selectedImage = null; // data URL
let scannedUPC = null;
let identifying = false;
let runController = null;
let lastPayload = {};
let lastResult = null;

/* ---------------- image helpers ---------------- */
function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

async function fileToResizedDataUrl(file, maxDim = 1280, quality = 0.82) {
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

async function onImageChosen(file, opts = {}) {
  if (!file) return;
  try {
    selectedImage = await fileToResizedDataUrl(file);
  } catch {
    selectedImage = null;
    return;
  }
  $("thumb").src = selectedImage;
  $("thumbWrap").classList.remove("hidden");
  $("idStatus").textContent = opts.barcode ? "🔖 Reading barcode…" : "";
  scannedUPC = null;
  if (opts.barcode) {
    scannedUPC = await attemptBarcode(selectedImage);
    if (scannedUPC) $("idStatus").textContent = `🔖 UPC ${scannedUPC} — identifying…`;
  }
  identify();
}

function clearImage() {
  selectedImage = null;
  scannedUPC = null;
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
    selectedImage = c.toDataURL("image/jpeg", 0.8);
    $("thumb").src = selectedImage;
    $("thumbWrap").classList.remove("hidden");
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

/* ---------------- API ---------------- */
function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  const key = localStorage.getItem(KEY_STORE);
  if (key) h["x-anthropic-key"] = key;
  return h;
}

async function identify() {
  if ((!selectedImage && !scannedUPC) || identifying) return;
  identifying = true;
  if (!$("idStatus").textContent) $("idStatus").textContent = "🔎 Identifying…";
  try {
    const r = await fetch("/api/identify", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ image: selectedImage, upc: scannedUPC }),
    });
    if (r.status === 401) {
      $("idStatus").textContent = "⚠️ Add your API key in ⚙️";
      openSettings();
      return;
    }
    const data = await r.json();
    if (data && data.name) {
      if (!$("nameInput").value.trim()) $("nameInput").value = data.name;
      if (data.upc && !scannedUPC) scannedUPC = data.upc;
      const conf = data.confidence ? ` · ${data.confidence} confidence` : "";
      $("idStatus").textContent = `✓ ${data.name}${conf}`;
      if (data.observedPrice && !$("priceInput").value) $("priceInput").value = data.observedPrice;
    } else {
      $("idStatus").textContent = "Couldn't ID it — type the name";
    }
  } catch {
    $("idStatus").textContent = "ID failed — type the name";
  } finally {
    identifying = false;
  }
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
    image: selectedImage || null,
    upc: scannedUPC || null,
    deep: $("deepToggle").checked,
  };
  lastPayload = payload;

  // hide the Guru lane if quality mode is off
  $("agent-guru").classList.toggle("hidden", !payload.deep);

  $("analyzeBtn").disabled = true;
  $("results").classList.add("hidden");
  $("results").innerHTML = "";
  resetFeed();
  $("activity").classList.remove("hidden");
  document.querySelector(".activity-title").textContent = "Agents working…";
  $("activity").scrollIntoView({ behavior: "smooth", block: "center" });

  runController = new AbortController();
  try {
    const resp = await fetch("/api/analyze/stream", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload),
      signal: runController.signal,
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) { try { handleEvent(JSON.parse(line.slice(6))); } catch {} }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") showFormError("Network error: " + e.message);
  } finally {
    $("analyzeBtn").disabled = false;
  }
}

function stopRun() {
  if (runController) { try { runController.abort(); } catch {} runController = null; }
  $("analyzeBtn").disabled = false;
  $("activity").classList.add("hidden");
}

function finishRun(data) {
  lastResult = data;
  $("analyzeBtn").disabled = false;
  document.querySelector(".activity-title").textContent = "Done";
  renderResults(data, lastPayload);
  saveHistory(data);
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

  // action bar (share)
  html += `<div class="action-bar">
    <button class="ghost-btn small" id="shareBtn">📤 Share</button>
    ${sources[0] && sources[0].url ? `<a class="ghost-btn small" href="${esc(sources[0].url)}" target="_blank" rel="noopener">↗ Cheapest online</a>` : ""}
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
  const hist = loadHistory();
  hist.unshift({
    name: (d.product && d.product.name) || "Item",
    rating: (d.deal && d.deal.rating) || "unknown",
    fair: d.market && d.market.fairPrice,
    at: Date.now(),
  });
  localStorage.setItem(HIST_STORE, JSON.stringify(hist.slice(0, 15)));
  renderHistory();
}
function renderHistory() {
  const hist = loadHistory();
  const sec = $("historySection");
  if (!hist.length) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  $("historyList").innerHTML = hist
    .map((h) => {
      const r = (h.rating || "unknown").toLowerCase();
      return `<li>
        <span class="h-name">${esc(h.name)}</span>
        <span style="color:var(--muted);font-size:13px">${h.fair ? money(h.fair) : ""}</span>
        <span class="h-pill ${r}">${esc(r)}</span>
      </li>`;
    })
    .join("");
}

/* ---------------- settings ---------------- */
function openSettings() {
  $("keyInput").value = localStorage.getItem(KEY_STORE) || "";
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
$("galleryInput").addEventListener("change", (e) => onImageChosen(e.target.files[0]));
$("scanBtn").addEventListener("click", openScanner);
$("scanClose").addEventListener("click", closeScanner);
$("clearThumb").addEventListener("click", clearImage);
$("analyzeBtn").addEventListener("click", analyze);
$("cancelRun").addEventListener("click", stopRun);
$("settingsBtn").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", closeSettings);
$("settingsModal").addEventListener("click", (e) => { if (e.target === $("settingsModal")) closeSettings(); });
$("saveKey").addEventListener("click", () => {
  const v = $("keyInput").value.trim();
  if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE);
  updateKeyStatus();
  setTimeout(closeSettings, 600);
});
$("clearHistory").addEventListener("click", () => { localStorage.removeItem(HIST_STORE); renderHistory(); });
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });
$("deepToggle").addEventListener("change", (e) => localStorage.setItem(DEEP_STORE, e.target.checked ? "1" : "0"));

// restore deep-mode preference
if (localStorage.getItem(DEEP_STORE) === "0") $("deepToggle").checked = false;
renderHistory();

(async () => {
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.hasServerKey && !localStorage.getItem(KEY_STORE)) openSettings();
  } catch {}
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
