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

export function billingEnabled() { return ENABLED; }
export function billingConfig() {
  return { enabled: ENABLED, flag: FLAG, costs: CREDIT_COSTS, freeCredits: FREE_CREDITS };
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

export async function resetMonthly(userId, amount, tier) {
  return rpc("reset_monthly", { p_user: userId, p_amount: amount, p_tier: tier || null });
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
