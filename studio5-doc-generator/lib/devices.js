const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const supabase = require("./supabase");

// Sign-in without passwords:
//   1. a new device proves its user with a one-time code emailed by Supabase;
//   2. the user sets a 4-digit MPIN for that device;
//   3. afterwards the device unlocks with the MPIN alone.
// The device keeps a random secret; the server keeps only its hash, the
// MPIN's scrypt hash and the user's Supabase refresh token (encrypted). An
// MPIN unlock refreshes that token and hands the device a normal Supabase
// session, so everything that already checks Supabase sign-ins (requireUser,
// the po-tracker) accepts it unchanged.

const MAX_PIN_ATTEMPTS = 5;
const PIN_RE = /^\d{4}$/;
// Easy-to-guess MPINs are refused, same as banking apps.
const WEAK_PINS = new Set(["1234", "4321", "1212", "1122", "2580", "0852", "1004", "2000", "6969", "1010"]);

function deviceTokenKey() {
  const raw = process.env.DEVICE_TOKEN_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function isConfigured() {
  return !!(supabase && deviceTokenKey());
}

function codedError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireConfigured() {
  if (!isConfigured()) {
    throw codedError(
      "MPIN sign-in is not set up on this server (SUPABASE_* or DEVICE_TOKEN_KEY missing).",
      "NOT_CONFIGURED",
      503
    );
  }
}

// A fresh client per call: verifyOtp / refreshSession store the user's
// session on the client they run on, and the shared service-role client must
// never start sending a user's token instead of the service key.
function authClient() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deviceTokenKey(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString("base64")).join(".");
}

function decrypt(packed) {
  const [iv, tag, body] = packed.split(".").map(s => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", deviceTokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// The server key acts as a pepper: a leaked table alone can't be used to
// try all 10,000 MPINs offline.
function hashPin(pin, salt) {
  return crypto.scryptSync(`${pin}:${deviceTokenKey().toString("base64")}`, salt, 32).toString("hex");
}

function isWeakPin(pin) {
  if (/^(\d)\1{3}$/.test(pin) || WEAK_PINS.has(pin)) return true;
  const d = pin.split("").map(Number);
  const step = d[1] - d[0];
  return Math.abs(step) === 1 && d.every((v, i) => i === 0 || v - d[i - 1] === step);
}

function sessionPayload(session) {
  return {
    access_token: session.access_token,
    expires_at: Date.now() + (session.expires_in || 3600) * 1000,
    email: (session.user && session.user.email) || "",
  };
}

// Wrong guesses on one device are checked one at a time, so a burst of
// parallel requests can't all be evaluated before the counter catches up.
const deviceLocks = new Map();
async function withDeviceLock(id, fn) {
  const prev = deviceLocks.get(id) || Promise.resolve();
  let release;
  const done = new Promise(r => (release = r));
  const tail = prev.then(() => done);
  deviceLocks.set(id, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (deviceLocks.get(id) === tail) deviceLocks.delete(id);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadDevice(deviceId, deviceSecret) {
  if (!deviceId || !deviceSecret || !UUID_RE.test(String(deviceId))) {
    throw codedError("This device is not set up yet.", "DEVICE_UNKNOWN", 401);
  }
  const { data, error } = await supabase.from("trusted_devices").select("*").eq("id", deviceId).maybeSingle();
  if (error) throw error;
  const good =
    data &&
    crypto.timingSafeEqual(Buffer.from(sha256(String(deviceSecret))), Buffer.from(data.secret_hash));
  if (!good || data.revoked_at) {
    throw codedError("This device is no longer signed in. Please sign in with an email code.", "DEVICE_UNKNOWN", 401);
  }
  return data;
}

// Step 1. Always answers the same way, so the form can't be used to find out
// which emails have accounts. shouldCreateUser:false means only people already
// added in Supabase ever receive a code.
async function startOtp(email) {
  requireConfigured();
  const clean = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw codedError("Please enter a valid email address.", "BAD_EMAIL", 400);
  const { error } = await authClient().auth.signInWithOtp({ email: clean, options: { shouldCreateUser: false } });
  if (error) {
    if (error.status === 429) throw codedError("Too many codes requested. Please wait a minute and try again.", "RATE_LIMITED", 429);
    console.warn(`[devices] OTP not sent to ${clean}: ${error.message}`);
  }
}

// Step 2. A correct code registers this browser as a trusted device (its MPIN
// still unset) and returns the device secret — the only time it is revealed.
async function verifyOtp(email, code, deviceName, replaceDeviceId) {
  requireConfigured();
  const clean = String(email || "").trim().toLowerCase();
  const token = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6,10}$/.test(token)) throw codedError("Please enter the code from the email.", "BAD_CODE", 400);

  const { data, error } = await authClient().auth.verifyOtp({ email: clean, token, type: "email" });
  if (error || !data || !data.session) {
    throw codedError("That code is wrong or has expired. Request a new one.", "BAD_CODE", 401);
  }
  const { session, user } = data;

  const deviceSecret = crypto.randomBytes(32).toString("base64url");
  const { data: device, error: insErr } = await supabase
    .from("trusted_devices")
    .insert({
      user_id: user.id,
      email: user.email,
      device_name: String(deviceName || "").slice(0, 80) || null,
      secret_hash: sha256(deviceSecret),
      refresh_token_enc: encrypt(session.refresh_token),
    })
    .select("id")
    .single();
  if (insErr) throw insErr;

  // "Forgot MPIN" on a device re-runs the OTP; its old record is retired.
  if (replaceDeviceId) {
    await supabase
      .from("trusted_devices")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: "Replaced after a new email code" })
      .eq("id", replaceDeviceId)
      .eq("user_id", user.id)
      .is("revoked_at", null);
  }

  return { device_id: device.id, device_secret: deviceSecret, ...sessionPayload(session) };
}

// Step 3. Only right after the OTP: the caller must hold that session and the
// device's secret, and the MPIN must not be set yet.
async function setPin(userId, deviceId, deviceSecret, pin) {
  requireConfigured();
  const device = await loadDevice(deviceId, deviceSecret);
  if (device.user_id !== userId) throw codedError("This device belongs to a different account.", "DEVICE_UNKNOWN", 403);
  if (device.pin_hash) throw codedError("An MPIN is already set on this device. Use \"Forgot MPIN\" to change it.", "PIN_ALREADY_SET", 409);
  const p = String(pin || "");
  if (!PIN_RE.test(p)) throw codedError("The MPIN must be exactly 4 digits.", "BAD_PIN", 400);
  if (isWeakPin(p)) throw codedError("That MPIN is too easy to guess. Please choose another.", "WEAK_PIN", 400);

  const salt = crypto.randomBytes(16).toString("hex");
  const { error } = await supabase
    .from("trusted_devices")
    .update({ pin_hash: hashPin(p, salt), pin_salt: salt, failed_attempts: 0, locked_at: null, last_used_at: new Date().toISOString() })
    .eq("id", device.id);
  if (error) throw error;
}

// Every day: MPIN -> a fresh Supabase session for this device.
async function unlockWithPin(deviceId, deviceSecret, pin) {
  requireConfigured();
  return withDeviceLock(String(deviceId), async () => {
    const device = await loadDevice(deviceId, deviceSecret);
    if (!device.pin_hash) throw codedError("No MPIN is set on this device yet.", "PIN_NOT_SET", 409);
    if (device.locked_at) {
      throw codedError("Too many wrong MPINs. This device is locked — sign in again with an email code.", "DEVICE_LOCKED", 423);
    }

    const given = hashPin(String(pin || ""), device.pin_salt);
    const right = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(device.pin_hash));
    if (!right) {
      const { data: attempts, error } = await supabase.rpc("fn_record_pin_failure", { p_device_id: device.id });
      if (error) throw error;
      const left = Math.max(0, MAX_PIN_ATTEMPTS - attempts);
      if (left === 0) {
        throw codedError("Too many wrong MPINs. This device is locked — sign in again with an email code.", "DEVICE_LOCKED", 423);
      }
      throw codedError(`Wrong MPIN. ${left} ${left === 1 ? "try" : "tries"} left.`, "WRONG_PIN", 401);
    }

    const { data, error } = await authClient().auth.refreshSession({ refresh_token: decrypt(device.refresh_token_enc) });
    if (error || !data || !data.session) {
      // The Supabase session behind this device ended (user removed, signed
      // out everywhere, or expired): the device has to start over.
      await supabase
        .from("trusted_devices")
        .update({ revoked_at: new Date().toISOString(), revoked_reason: "Supabase session ended" })
        .eq("id", device.id);
      throw codedError("Your sign-in on this device has ended. Please sign in again with an email code.", "DEVICE_UNKNOWN", 401);
    }

    const { error: upErr } = await supabase
      .from("trusted_devices")
      .update({
        refresh_token_enc: encrypt(data.session.refresh_token),
        failed_attempts: 0,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", device.id);
    if (upErr) throw upErr;
    return sessionPayload(data.session);
  });
}

// Signed-in users manage devices together, matching the po-tracker's rule
// that every signed-in user can do everything — so a lost phone can be
// removed by whoever notices first.
async function listDevices() {
  const { data, error } = await supabase
    .from("trusted_devices")
    .select("id, email, device_name, created_at, last_used_at, locked_at, pin_hash")
    .is("revoked_at", null)
    .order("last_used_at", { ascending: false, nullsFirst: false });
  if (error) throw error;
  // Field by field, so a hash or token can never ride along by accident.
  return data.map(d => ({
    id: d.id,
    email: d.email,
    device_name: d.device_name,
    created_at: d.created_at,
    last_used_at: d.last_used_at,
    locked_at: d.locked_at,
    pin_set: !!d.pin_hash,
  }));
}

async function revokeDevice(deviceId, byEmail) {
  if (!UUID_RE.test(String(deviceId))) throw codedError("That device was not found or is already removed.", "NOT_FOUND", 404);
  const { data, error } = await supabase
    .from("trusted_devices")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: `Removed by ${byEmail || "a signed-in user"}` })
    .eq("id", deviceId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw codedError("That device was not found or is already removed.", "NOT_FOUND", 404);
}

module.exports = {
  isConfigured,
  startOtp,
  verifyOtp,
  setPin,
  unlockWithPin,
  listDevices,
  revokeDevice,
  isWeakPin,
};
