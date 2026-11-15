// Starts the Studio5 doc generator. All behaviour lives in app.js.
//
// By default it listens on this PC only (127.0.0.1) — other devices on the Wi-Fi cannot reach it.
// On Render (RENDER is set) or with HOST=0.0.0.0 it listens on all interfaces; set ACCESS_CODE then.
require("dotenv").config();
const { createApp } = require("./app.js");
const supabase = require("./lib/supabase.js");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const app = createApp({ supabase, env: process.env });
if (process.env.RENDER || process.env.TRUST_PROXY) app.set("trust proxy", 1);

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !process.env.ACCESS_CODE) {
  console.warn("WARNING: listening on " + HOST + " without ACCESS_CODE — anyone who can reach this server can create signed Studio5 documents. Set ACCESS_CODE.");
}
app.listen(PORT, HOST, () => console.log(`Studio5 doc generator running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
