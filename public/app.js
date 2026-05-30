"use strict";

const $ = (id) => document.getElementById(id);
const KEY_STORE = "gsdf_api_key";
const HIST_STORE = "gsdf_history";

let selectedImage = null; // data URL
let identifying = false;
let runController = null;

/* ---------------- image handling ---------------- */
async function fileToResizedDataUrl(file, maxDim = 1280, quality = 0.82) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
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

async function onImageChosen(file) {
  if (!file) return;
  try {
    selectedImage = await fileToResizedDataUrl(file);
  } catch {
    selectedImage = null;
    return;
  }
  $("thumb").src = selectedImage;
  $("thumbWrap").classList.remove("hidden");
  $("idStatus").textContent = "";
  identify();
}

function clearImage() {
  selectedImage = null;
  $("thumbWrap").classList.add("hidden");
  $("cameraInput").value = "";
  $("galleryInput").value = "";
}

/* ---------------- API ---------------- */
function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  const key = localStorage.getItem(KEY_STORE);
  if (key) h["x-anthropic-key"] = key;
  return h;
}

async function identify() {
  if (!selectedImage || identifying) return;
  identifying = true;
  $("idStatus").textContent = "🔎 Identifying…";
  try {
    const r = await fetch("/api/identify", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ image: selectedImage }),
    });
    if (r.status === 401) {
      $("idStatus").textContent = "⚠️ Add your API key in ⚙️";
      openSettings();
      return;
    }
    const data = await r.json();
    if (data && data.name) {
      if (!$("nameInput").value.trim()) $("nameInput").value = data.name;
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
let currentThink = null; // { el, txt, phase }

function resetFeed() {
  $("feed").innerHTML = "";
  currentThink = null;
  ["scout", "specialist"].forEach((p) => {
    const a = $(`agent-${p}`);
    a.classList.remove("active", "done");
  });
}

function feedScroll() {
  const f = $("feed");
  f.scrollTop = f.scrollHeight;
}

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
  if (next.length > 700) next = "…" + next.slice(next.length - 699); // keep it tidy
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
        addLine("phase", `${ev.phase === "scout" ? "🔭" : "🤝"} ${esc(ev.label || ev.phase)} — ${esc(ev.role || "")}`);
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
      addLine("result", `<span class="ic">✓</span><span>Found ${ev.count} listings${titles ? ` <small>${titles}</small>` : ""}</span>`);
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
  if (!name && !selectedImage) {
    showFormError("Take a photo or type an item name first.");
    return;
  }
  hideFormError();

  const payload = {
    name,
    askingPrice: $("priceInput").value || null,
    condition: $("conditionInput").value || null,
    image: selectedImage || null,
  };
  lastPayload = payload;

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
        if (line) {
          try { handleEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") showFormError("Network error: " + e.message);
  } finally {
    if ($("analyzeBtn").disabled) $("analyzeBtn").disabled = false;
  }
}

function stopRun() {
  if (runController) { try { runController.abort(); } catch {} runController = null; }
  $("analyzeBtn").disabled = false;
  $("activity").classList.add("hidden");
}

function finishRun(data) {
  $("analyzeBtn").disabled = false;
  document.querySelector(".activity-title").textContent = "Done";
  renderResults(data, lastPayload);
  saveHistory(data);
  // collapse the feed a moment after results show
  setTimeout(() => $("activity").classList.add("hidden"), 400);
}

/* ---------------- rendering ---------------- */
let lastPayload = {};
const money = (n) =>
  n == null || n === "" || isNaN(n)
    ? "—"
    : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const RATING_LABEL = {
  great: "Great deal", good: "Good deal", ok: "OK deal", bad: "Bad deal", unknown: "Market read",
};

function renderResults(d, payload) {
  payload = payload || {};
  const deal = d.deal || {};
  const rating = (deal.rating || "unknown").toLowerCase();
  const market = d.market || {};
  const product = d.product || {};
  const counter = d.counterOffer || {};
  const notes = Array.isArray(d.specialistNotes) ? d.specialistNotes : [];
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

  // sources
  if (sources.length) {
    html += `<div class="card">
      <div class="section-title">Price sources (${sources.length})</div>
      <div class="sources">
        ${sources
          .map((s, i) => {
            const cond = (s.condition || "").toLowerCase() === "used" ? "used" : "new";
            const cheap = i === 0 ? "src-cheapest" : "";
            const inner = `
              <div class="src-rank">${i + 1}</div>
              <div class="src-main">
                <div class="src-store">${esc(s.store || "Store")}<span class="badge ${cond}">${cond}</span></div>
                <div class="src-title">${esc(s.title || "")}${s.inStock === false ? " · out of stock" : ""}</div>
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

  // product
  if (product.summary || (product.specs && product.specs.length)) {
    html += `<div class="card">
      <div class="section-title">About this item</div>
      <div style="font-weight:700;margin-bottom:4px">${esc(product.name || "")}</div>
      ${product.summary ? `<p class="muted-p" style="margin-top:0">${esc(product.summary)}</p>` : ""}
      ${product.msrp ? `<p class="muted-p">MSRP: ${money(product.msrp)}</p>` : ""}
      ${
        Array.isArray(product.specs) && product.specs.length
          ? `<ul class="specs">${product.specs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
          : ""
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

  if (d._meta && d._meta.searchUnavailable) {
    html += `<p class="notice">Live web search wasn't available on this key — prices are model estimates. Verify before buying.</p>`;
  }

  html += `<button class="primary-btn new-search" onclick="window.scrollTo({top:0,behavior:'smooth'})"><span class="btn-label">↑ New search</span></button>`;

  $("results").innerHTML = html;
  $("results").classList.remove("hidden");
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });

  // animate the gauge ring
  const g = $("results").querySelector(".gauge");
  if (g) requestAnimationFrame(() => g.style.setProperty("--p", g.dataset.score));
}

/* ---------------- history ---------------- */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_STORE) || "[]"); } catch { return []; }
}
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
$("galleryInput").addEventListener("change", (e) => onImageChosen(e.target.files[0]));
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
