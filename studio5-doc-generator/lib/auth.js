const supabase = require("./supabase");

// Accounts are shared with studio5-po-tracker: the same Supabase project, the
// same users. Its rule is "any signed-in user may do everything" (RLS
// p_authenticated_all, no app_user role checks), and this backend follows the
// same rule, so one account works in both apps. How a device gets its session
// (email code, then MPIN) lives in lib/devices.js.
//
// Each request carries the user's Supabase access token as
// "Authorization: Bearer <jwt>". Verifying it costs a call to Supabase Auth,
// so a verified token is remembered for a minute.
const TOKEN_CACHE_MS = 60 * 1000;
const tokenCache = new Map();

function isLoopback(req) {
  const ip = req.socket && req.socket.remoteAddress;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authError(res, message) {
  return res.status(401).json({ error: message, code: "AUTH_REQUIRED" });
}

async function verifyToken(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.until > Date.now()) return cached.user;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  const user = { id: data.user.id, email: data.user.email };
  tokenCache.set(token, { user, until: Date.now() + TOKEN_CACHE_MS });
  if (tokenCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.until <= now) tokenCache.delete(k);
  }
  return user;
}

async function requireUser(req, res, next) {
  // Without Supabase there are no accounts to check against. That is only
  // acceptable for the desktop launcher talking to its own localhost server;
  // a cloud deploy missing its env vars must refuse rather than run open.
  if (!supabase) {
    if (isLoopback(req)) {
      req.user = null;
      return next();
    }
    return res.status(503).json({ error: "Sign-in is not configured on this server (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)." });
  }

  const token = bearerToken(req);
  if (!token) return authError(res, "Please sign in first.");
  try {
    const user = await verifyToken(token);
    if (!user) return authError(res, "Your sign-in has expired. Please sign in again.");
    req.user = user;
    next();
  } catch (e) {
    console.error("[auth] Token check failed:", e.message);
    res.status(502).json({ error: "Could not reach Supabase to check your sign-in. Try again in a moment." });
  }
}

// Sign-in (email code + MPIN, see lib/devices.js) runs through this server,
// so the browser only needs to know whether it is switched on.
function publicAuthConfig() {
  return { enabled: require("./devices").isConfigured(), method: "otp_mpin" };
}

module.exports = { requireUser, publicAuthConfig };
