// Optional billing layer (Part B): Supabase-backed credit ledger + metering gate.
//
// OFF by default. It activates only when BILLING_ENABLED is truthy AND the three
// Supabase env vars are present. When off, every export degrades to a no-op so the
// existing BYO-Anthropic-key flow is completely unchanged.
//
// Dependency-free on purpose: we verify the Supabase access token (HS256) locally
// with node:crypto and talk to the ledger via Supabase's PostgREST RPC over fetch,
// so there's nothing new to npm-install in the sandbox or on the deploy host.
//
// Env:
//   BILLING_ENABLED      "1" | "true" | "yes" to turn it on
//   SUPABASE_URL         https://<ref>.supabase.co
//   SUPABASE_SERVICE_KEY service-role key (server only — never ship to the client)
//   SUPABASE_JWT_SECRET  project JWT secret, to verify user tokens locally
//   COST_FAST=1 COST_DEEP=4 COST_REVIEWS=2   per-action credit costs (tunable)
//   FREE_CREDITS=3       one-time grant on first sign-in
import crypto from "node:crypto";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
const FLAG = /^(1|true|yes|on)$/i.test(process.env.BILLING_ENABLED || "");
const ENABLED = FLAG && !!SUPABASE_URL && !!SERVICE_KEY && !!JWT_SECRET;
const FREE_CREDITS = Number(process.env.FREE_CREDITS || 3);

// Per-action credit costs. Identify/chat/refine are intentionally absent (free).
export const CREDIT_COSTS = {
  fast: Number(process.env.COST_FAST || 1),
  deep: Number(process.env.COST_DEEP || 4),
  reviews: Number(process.env.COST_REVIEWS || 2),
};

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// Top-up packs shown in the client's "out of credits" sheet. Display + product-id only — the
// actual charge happens via the store / Stripe; configurable with RC_TOPUP_PACKS (JSON array).
const DEFAULT_TOPUP_PACKS = [
  { id: "topup_50", credits: 50, price: "$9.99" },
  { id: "topup_150", credits: 150, price: "$24.99" },
];
let TOPUP_PACKS = DEFAULT_TOPUP_PACKS;
if (process.env.RC_TOPUP_PACKS) {
  try { TOPUP_PACKS = JSON.parse(process.env.RC_TOPUP_PACKS); } catch { /* keep defaults */ }
}

export function billingEnabled() { return ENABLED; }
export function billingConfig() {
  return { enabled: ENABLED, flag: FLAG, costs: CREDIT_COSTS, freeCredits: FREE_CREDITS };
}

// Client-safe config (no secrets — the anon key is public by design). The app calls /api/config
// on load to decide whether to show sign-in + credits, and how to render the top-up sheet.
export function publicConfig() {
  return {
    billing: ENABLED,
    supabaseUrl: ENABLED ? SUPABASE_URL : null,
    supabaseAnonKey: ENABLED ? SUPABASE_ANON_KEY : null,
    costs: CREDIT_COSTS,
    freeCredits: FREE_CREDITS,
    packs: TOPUP_PACKS,
  };
}

// ---------- token verification (Supabase HS256 access token) ----------
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64");
}

// Verify signature + expiry, return { id, email } or null. Pure/synchronous; no network.
export function verifyToken(token) {
  if (!token || !JWT_SECRET) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header;
  try { header = JSON.parse(b64urlToBuf(h).toString("utf8")); } catch { return null; }
  if (header.alg !== "HS256") return null; // Supabase default; we don't accept others here
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest();
  const got = b64urlToBuf(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(p).toString("utf8")); } catch { return null; }
  if (!payload || !payload.sub) return null;
  if (payload.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) return null;
  return { id: payload.sub, email: payload.email || null };
}

export function bearer(req) {
  const h = req.get && (req.get("authorization") || req.get("Authorization"));
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

// ---------- Supabase RPC over PostgREST ----------
async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args || {}),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error((data && data.message) || `rpc ${fn} failed (${r.status})`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Profiles we've already ensured this process — avoids an RPC on every request.
const ensured = new Set();
async function ensureProfile(user) {
  if (ensured.has(user.id)) return;
  await rpc("ensure_profile", { p_user: user.id, p_email: user.email, p_free: FREE_CREDITS });
  ensured.add(user.id);
}

export async function getBalance(userId) {
  const d = await rpc("credits_balance", { p_user: userId });
  return Number(d ?? 0);
}

export async function grant(userId, amount, bucket, action, ref) {
  return rpc("grant_credits", { p_user: userId, p_amount: amount, p_bucket: bucket, p_action: action || "grant", p_ref: ref || null });
}

export async function resetMonthly(userId, amount, tier, ref) {
  return rpc("reset_monthly", { p_user: userId, p_amount: amount, p_tier: tier || null, p_ref: ref || null });
}

// ---------- RevenueCat webhook ----------
// Auth: RevenueCat sends the dashboard-configured value as `Authorization: Bearer <secret>`.
// We compare it timing-safely against REVENUECAT_WEBHOOK_SECRET. If the secret isn't set, the
// webhook is unusable (every call 401s) — fail closed.
const RC_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || "";

// Map store product_ids -> what they grant. Configure with RC_PRODUCT_MAP (JSON) to match the
// actual product identifiers you set up in App Store Connect / Play / RevenueCat. The defaults
// are placeholders aligned with MONETIZATION.md.
const DEFAULT_PRODUCT_MAP = {
  enthusiast_monthly: { type: "sub", tier: "enthusiast", monthly: 40 },
  pro_monthly: { type: "sub", tier: "pro", monthly: 150 },
  topup_50: { type: "topup", credits: 50 },
  topup_150: { type: "topup", credits: 150 },
};
let PRODUCT_MAP = DEFAULT_PRODUCT_MAP;
if (process.env.RC_PRODUCT_MAP) {
  try { PRODUCT_MAP = JSON.parse(process.env.RC_PRODUCT_MAP); } catch { /* keep defaults */ }
}

export function verifyWebhookSecret(req) {
  if (!RC_SECRET) return false; // not configured -> reject everything
  const tok = bearer(req);
  if (!tok) return false;
  const a = Buffer.from(tok);
  const b = Buffer.from(RC_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Subscription events that should (re)fill the monthly bucket to the tier allotment.
const SUB_GRANT_TYPES = new Set([
  "INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "SUBSCRIPTION_EXTENDED",
]);

// Apply one RevenueCat event to the ledger. Returns a small status object; never throws for
// "we just don't act on this" cases — only genuine infra errors propagate (caller -> 500 -> retry).
// app_user_id MUST be the Supabase user UUID (client calls Purchases.logIn(supabaseUserId)).
export async function handleWebhookEvent(event) {
  const type = event?.type;
  const userId = event?.app_user_id;
  if (!type) return { applied: false, reason: "no_type" };
  if (type === "TEST") return { applied: false, reason: "test_ok" };
  if (!userId || !UUID_RE.test(userId)) return { applied: false, reason: "unmapped_user" };

  // Make sure the profile row exists; no free grant via the webhook path. If the id isn't a real
  // auth user the FK insert fails with a 4xx — ack that (don't trigger endless retries). A network
  // / 5xx error is infra: rethrow so the route returns 500 and RevenueCat retries with backoff.
  try {
    await rpc("ensure_profile", { p_user: userId, p_email: null, p_free: 0 });
  } catch (e) {
    if (e && e.status >= 400 && e.status < 500) return { applied: false, reason: "unmapped_user" };
    throw e;
  }

  const ref = event.id || null;
  const prod = event.product_id ? PRODUCT_MAP[event.product_id] : null;

  if (type === "NON_RENEWING_PURCHASE") {
    if (!prod || prod.type !== "topup") return { applied: false, reason: "unknown_product" };
    const r = await grant(userId, prod.credits, "topup", "purchase", ref);
    return { applied: r?.applied !== false, balance: r?.balance };
  }
  if (SUB_GRANT_TYPES.has(type)) {
    if (!prod || prod.type !== "sub") return { applied: false, reason: "unknown_product" };
    const r = await resetMonthly(userId, prod.monthly, prod.tier, ref);
    return { applied: r?.applied !== false, balance: r?.balance };
  }
  if (type === "EXPIRATION") {
    // Subscription lapsed: zero the monthly bucket + drop to free. Purchased top-ups are untouched.
    const r = await resetMonthly(userId, 0, "free", ref);
    return { applied: r?.applied !== false, balance: r?.balance };
  }
  // CANCELLATION / BILLING_ISSUE / SUBSCRIPTION_PAUSED etc: access persists until EXPIRATION -> no-op.
  return { applied: false, reason: `ignored:${type}` };
}

// ---------- the metering gate ----------
// Resolves to one of:
//   { ok: true,  billed: false }                          billing off / free action
//   { ok: true,  billed: true,  user, cost, balance, refund }
//   { ok: false, status: 401, error: "unauthorized" }
//   { ok: false, status: 402, error: "insufficient_credits", balance, cost }
//   { ok: false, status: 503, error: "billing_unavailable" }   (Supabase unreachable)
// The caller is responsible for shaping the response (JSON vs SSE) and for calling
// refund() if the work fails after a successful debit.
const NOOP_REFUND = async () => {};
export async function openGate(req, action) {
  if (!ENABLED) return { ok: true, billed: false, refund: NOOP_REFUND };

  const user = verifyToken(bearer(req));
  if (!user) return { ok: false, status: 401, error: "unauthorized" };

  const cost = CREDIT_COSTS[action] ?? 0;
  try {
    await ensureProfile(user);
    if (cost <= 0) return { ok: true, billed: false, user, refund: NOOP_REFUND };
    const r = await rpc("spend_credits", { p_user: user.id, p_amount: cost, p_action: action, p_ref: null });
    if (!r || r.ok !== true) {
      return { ok: false, status: 402, error: "insufficient_credits", balance: Number(r?.balance ?? 0), cost };
    }
    let refunded = false;
    const refund = async () => {
      if (refunded) return;
      refunded = true;
      try { await grant(user.id, cost, "monthly", "refund", null); } catch { /* best-effort */ }
    };
    return { ok: true, billed: true, user, cost, balance: Number(r.balance ?? 0), refund };
  } catch (err) {
    // Fail closed: if the ledger is unreachable we don't give away paid work.
    return { ok: false, status: 503, error: "billing_unavailable", detail: String(err?.message || err) };
  }
}
