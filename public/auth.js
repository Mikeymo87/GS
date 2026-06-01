/* Lightweight Supabase auth + billing state for the PWA.
 *
 * No Supabase SDK — we hit the auth REST endpoints directly (mirrors the dependency-free server).
 * Everything here is INERT unless /api/config reports billing is on, so the BYO-key app is unchanged.
 *
 * Exposes a global `Auth`:
 *   Auth.ready            Promise that resolves once /api/config has loaded
 *   Auth.enabled          billing on?
 *   Auth.config           { billing, supabaseUrl, supabaseAnonKey, costs, freeCredits, packs }
 *   Auth.user             { id, email } | null
 *   Auth.balance          last known credit balance (number | null)
 *   Auth.accessToken()    current JWT string (sync; kept fresh in the background) | null
 *   Auth.signIn/signUp/signOut(...)   -> promises
 *   Auth.refreshBalance() -> fetches /api/credits
 *   Auth.onChange(fn)     subscribe to {user, balance} changes
 *   Auth.setBalance(n)    update balance (used when an API response returns credits.balance)
 */
(function () {
  const SESSION_STORE = "gsdf_session";
  const listeners = [];
  let session = null; // { access_token, refresh_token, expires_at, user }
  let refreshTimer = null;

  const Auth = {
    enabled: false,
    config: null,
    user: null,
    balance: null,
    accessToken() { return session && session.access_token ? session.access_token : null; },
    onChange(fn) { if (typeof fn === "function") listeners.push(fn); },
  };

  function emit() {
    Auth.user = session ? session.user : null;
    for (const fn of listeners) { try { fn({ user: Auth.user, balance: Auth.balance }); } catch {} }
  }

  function saveSession(s) {
    session = s;
    if (s) localStorage.setItem(SESSION_STORE, JSON.stringify(s));
    else localStorage.removeItem(SESSION_STORE);
    scheduleRefresh();
  }

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SESSION_STORE) || "null"); } catch { session = null; }
  }

  function authFetch(path, body, useBearer) {
    const url = Auth.config.supabaseUrl + path;
    const headers = { "Content-Type": "application/json", apikey: Auth.config.supabaseAnonKey };
    if (useBearer && session) headers.Authorization = "Bearer " + session.access_token;
    return fetch(url, { method: "POST", headers, body: JSON.stringify(body || {}) });
  }

  // Turn a Supabase token response into our stored session shape.
  function adoptTokenResponse(data) {
    if (!data || !data.access_token) return null;
    const expiresAt = data.expires_at
      ? Number(data.expires_at)
      : Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600);
    const u = data.user || {};
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      user: { id: u.id, email: u.email },
    };
  }

  function scheduleRefresh() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (!session || !session.refresh_token) return;
    const msUntil = (session.expires_at - 60) * 1000 - Date.now(); // refresh 60s early
    refreshTimer = setTimeout(doRefresh, Math.max(5000, msUntil));
  }

  async function doRefresh() {
    if (!session || !session.refresh_token) return false;
    try {
      const r = await authFetch("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token });
      if (!r.ok) { if (r.status === 400 || r.status === 401) { saveSession(null); emit(); } return false; }
      const next = adoptTokenResponse(await r.json());
      if (next) { saveSession(next); emit(); return true; }
    } catch {}
    return false;
  }

  Auth.signIn = async function (email, password) {
    const r = await authFetch("/auth/v1/token?grant_type=password", { email, password });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data.error_description || data.msg || data.error || "Sign-in failed" };
    saveSession(adoptTokenResponse(data)); emit();
    await Auth.refreshBalance();
    return { ok: true };
  };

  Auth.signUp = async function (email, password) {
    const r = await authFetch("/auth/v1/signup", { email, password });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data.error_description || data.msg || data.error || "Sign-up failed" };
    if (data.access_token) {              // session returned immediately (email confirmation off)
      saveSession(adoptTokenResponse(data)); emit();
      await Auth.refreshBalance();
      return { ok: true, confirmed: true };
    }
    return { ok: true, confirmed: false }; // needs email confirmation
  };

  Auth.signOut = async function () {
    try { await authFetch("/auth/v1/logout", {}, true); } catch {}
    saveSession(null); Auth.balance = null; emit();
  };

  Auth.setBalance = function (n) {
    if (typeof n === "number" && !Number.isNaN(n)) { Auth.balance = n; emit(); }
  };

  Auth.refreshBalance = async function () {
    if (!Auth.enabled || !session) return;
    try {
      const r = await fetch("/api/credits", { headers: { Authorization: "Bearer " + session.access_token } });
      if (r.status === 401 && await doRefresh()) {
        return Auth.refreshBalance();
      }
      const data = await r.json().catch(() => ({}));
      if (typeof data.balance === "number") Auth.setBalance(data.balance);
    } catch {}
  };

  Auth.ready = (async function init() {
    try {
      Auth.config = await (await fetch("/api/config")).json();
    } catch {
      Auth.config = { billing: false };
    }
    Auth.enabled = !!Auth.config.billing;
    if (!Auth.enabled) return;
    loadSession();
    if (session) {
      // Refresh on boot if the stored token is expired/near expiry, then load balance.
      if (!session.expires_at || session.expires_at - 60 <= Math.floor(Date.now() / 1000)) await doRefresh();
      else scheduleRefresh();
      emit();
      Auth.refreshBalance();
    }
  })();

  window.Auth = Auth;
})();
