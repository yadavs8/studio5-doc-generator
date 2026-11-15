// Starts the Studio5 doc generator. All behaviour lives in app.js.
//
// By default it listens on this PC only (127.0.0.1) — other devices on the Wi-Fi cannot reach it.
// On Render (RENDER is set) or with HOST=0.0.0.0 it listens on all interfaces; set ACCESS_CODE then.
//
// Offline: on a PC the generator keeps its own number ledger (data/ledger.json). Without internet it keeps
// numbering from there and uploads everything to Supabase when the connection is back (every minute).
// Render's disk is wiped on every restart, so there the ledger is off (set OFFLINE_LEDGER=1 to force it).
require("dotenv").config();
const path = require("path");
const { createApp } = require("./app.js");
const { createLocalLedger } = require("./lib/localLedger.js");
const supabase = require("./lib/supabase.js");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const useLedger = process.env.OFFLINE_LEDGER ? process.env.OFFLINE_LEDGER === "1" : !process.env.RENDER;
const ledgerFile = path.join(process.env.STUDIO5_DATA_DIR || path.join(__dirname, "data"), "ledger.json");
const local = useLedger ? createLocalLedger(ledgerFile) : null;

const app = createApp({ supabase, local, env: process.env });
if (process.env.RENDER || process.env.TRUST_PROXY) app.set("trust proxy", 1);

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !process.env.ACCESS_CODE) {
  console.warn("WARNING: listening on " + HOST + " without ACCESS_CODE — anyone who can reach this server can create signed Studio5 documents. Set ACCESS_CODE.");
}
app.listen(PORT, HOST, () => {
  console.log(`Studio5 doc generator running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (local) console.log(`Offline number ledger: ${ledgerFile}`);
});

// Upload whatever was numbered offline, as soon as the internet is back.
if (local && supabase) {
  // Numbers first, then the PO tracker work that waits behind them.
  const tick = () => app.locals.numbering.sync()
    .then((r) => { if (r.uploaded || r.conflicts) console.log(`[sync] uploaded ${r.uploaded}, conflicts ${r.conflicts}, still waiting ${r.pending}`); })
    .then(() => app.locals.tracker.sync())
    .then((t) => { if (t.tracker_done || t.tracker_set_aside) console.log(`[sync] PO tracker: done ${t.tracker_done}, set aside ${t.tracker_set_aside}`); })
    .catch((e) => console.error("[sync]", e.message));
  tick();
  setInterval(tick, 60 * 1000).unref();
}
