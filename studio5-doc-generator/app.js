// The doc generator's web app: serves the one-page tool and its API. server.js starts it.
// Safety without a login (decision 0001): only this app's own page may call the API, only the page and
// its assets are served, documents can only carry Studio5's GSTINs and bank accounts, and an optional
// ACCESS_CODE locks everything when the server is reachable by others (e.g. on Render).
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const multer = require("multer");

const generatePO = require("./generators/generate_po.js");
const generatePI = require("./generators/generate_pi.js");
const generateInvoice = require("./generators/generate_invoice.js");
const generateChallan = require("./generators/generate_challan.js");
const { createNumbering, todayIST } = require("./lib/documentNumbering.js");
const { validateAndPrice, isRealDate, DATE_FIELD } = require("./lib/validate.js");
const { getExtractionPrompt, extractItems } = require("./lib/extract.js");

const ROOT = __dirname;
const SUBDIRS = { pi: "proforma_invoices", po: "purchase_orders", inv: "invoices", invoice: "invoices", challan: "challans" };
const SAVE_EXT = [".pdf", ".docx"];

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameText = (a, b) => {
  const x = Buffer.from(sha(a)), y = Buffer.from(sha(b));
  return crypto.timingSafeEqual(x, y);
};
const cookieValue = (req, name) => {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
};
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function createApp({ supabase = null, local = null, env = process.env } = {}) {
  const app = express();
  app.disable("x-powered-by");
  const numbering = createNumbering(supabase, { local });
  app.locals.numbering = numbering;
  const ACCESS_CODE = env.ACCESS_CODE ? String(env.ACCESS_CODE) : null;
  const allowedOrigins = new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean));

  // ── Which host names this server answers to (blocks DNS rebinding) ───────
  // A web page can point its own domain at 127.0.0.1 and then look "same-origin" to the generator on the
  // PC. Answering only to known host names stops that. Render's own name is added automatically.
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]",
    ...String(env.ALLOWED_HOSTS || "").split(","), String(env.RENDER_EXTERNAL_HOSTNAME || "")]
    .map((h) => h.trim().toLowerCase()).filter(Boolean));
  app.use((req, res, next) => {
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    if (allowedHosts.has(host)) return next();
    res.status(421).json({ error: `This server does not answer to "${host}". Add it to ALLOWED_HOSTS if it is yours.` });
  });

  // ── Who may call ────────────────────────────────────────────────────────
  // Browsers send Origin on cross-site requests. Only this app's own page (same host) or an origin the
  // owner listed in ALLOWED_ORIGINS gets in; everything else is refused, so a website the owner happens
  // to visit cannot drive the generator running on their PC.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    let originHost = null;
    try { originHost = origin ? new URL(origin).host : null; } catch { originHost = "?"; }
    // Compare host names only: behind Render's (or any) proxy the scheme seen here can differ from the browser's.
    const sameHost = !!originHost && originHost === req.headers.host;
    const listed = !!origin && allowedOrigins.has(origin);
    // Browsers also say where a request comes from; a cross-site one is refused unless listed — except simply
    // opening the page in a new tab.
    const crossSite = req.headers["sec-fetch-site"] === "cross-site" && !(req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate");
    const ok = (!origin || sameHost || listed) && (!crossSite || listed);
    if (ok && listed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-access-code, x-record-only");
      res.setHeader("Access-Control-Expose-Headers", "X-Document-Number, X-Offline, Content-Disposition");
    }
    if (req.method === "OPTIONS") return res.sendStatus(ok ? 204 : 403);
    if (!ok) return res.status(403).json({ error: "This server only accepts requests from its own page." });
    next();
  });

  app.use(express.json({ limit: "12mb" }));

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // ── Optional access code (ACCESS_CODE) ──────────────────────────────────
  // When set, nothing — not even the page, the logo or the stamp — is served until the code is entered.
  // The unlock cookie is an HMAC of the code with a secret (SESSION_SECRET, or a random one per start),
  // so it cannot be turned back into the code. Wrong codes are limited to 5 per 10 minutes per address.
  const sessionSecret = env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  const sessionToken = ACCESS_CODE ? crypto.createHmac("sha256", sessionSecret).update(ACCESS_CODE).digest("hex") : null;
  const failures = new Map();
  const tooMany = (ip) => {
    const f = failures.get(ip);
    if (f && Date.now() - f.first > 10 * 60 * 1000) { failures.delete(ip); return false; }
    return !!f && f.count >= 5;
  };
  const noteFailure = (ip) => {
    const f = failures.get(ip) || { count: 0, first: Date.now() };
    f.count++;
    failures.set(ip, f);
  };
  const unlocked = (req) => {
    if (!ACCESS_CODE) return true;
    const cookie = cookieValue(req, "s5_access");
    const header = req.headers["x-access-code"];
    return (cookie && sameText(cookie, sessionToken)) || (typeof header === "string" && !tooMany(req.ip) && sameText(header, ACCESS_CODE));
  };
  app.post("/api/unlock", (req, res) => {
    if (!ACCESS_CODE) return res.json({ ok: true, required: false });
    if (tooMany(req.ip)) return res.status(429).json({ error: "Too many wrong codes. Try again in 10 minutes." });
    if (!req.body || typeof req.body.code !== "string" || !sameText(req.body.code, ACCESS_CODE)) {
      noteFailure(req.ip);
      return res.status(401).json({ error: "That access code is not right." });
    }
    failures.delete(req.ip);
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `s5_access=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 90}${secure ? "; Secure" : ""}`);
    res.json({ ok: true, required: true });
  });
  const UNLOCK_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studio5 Docs — locked</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#f7f5f2">
<form id="f" style="background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 12px #0002;max-width:320px;width:100%">
<h2 style="margin-top:0">Studio5 Document Generator</h2><label>Access code<br><input id="c" type="password" autofocus style="width:100%;padding:8px;margin:8px 0"></label>
<button style="padding:8px 16px">Unlock</button><p id="m" style="color:#b0413e"></p></form>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('c').value})});
if(r.ok)location.reload();else document.getElementById('m').textContent=(await r.json().catch(()=>({}))).error||'Not accepted.';};</script>`;
  app.use((req, res, next) => {
    if (unlocked(req)) return next();
    if (req.method === "GET" && (req.path === "/" || req.path === "/studio5_doc_generator.html")) return res.type("html").send(UNLOCK_PAGE);
    res.status(401).json({ error: "Enter the access code first.", code: "ACCESS_CODE_REQUIRED" });
  });

  // ── Static: only the page, the app manifest and assets/ ──────────────────
  const page = (req, res) => res.sendFile(path.join(ROOT, "studio5_doc_generator.html"));
  app.get("/", page);
  app.get("/studio5_doc_generator.html", page);
  app.get("/manifest.json", (req, res) => res.sendFile(path.join(ROOT, "manifest.json")));
  app.use("/assets", express.static(path.join(ROOT, "assets"), { dotfiles: "deny", index: false }));

  // ── Errors people can read; details stay in the server log ──────────────
  function fail(res, e) {
    const map = {
      INVALID_PAYLOAD: [400], INVALID_NUMBER: [400], INVALID_DOC_TYPE: [400], NOT_FOUND: [404],
      DUPLICATE_NUMBER: [409], NOT_CONFIGURED: [503],
    };
    const known = map[e && e.code];
    if (known) return res.status(known[0]).json({ error: e.message, code: e.code });
    console.error("[error]", e);
    return res.status(500).json({ error: "Something went wrong on the server. Please try again; if it keeps happening, check the server log." });
  }

  // ── Generated-file folders ──────────────────────────────────────────────
  function docsBase() {
    const custom = env.STUDIO5_DOCS_DIR;
    const base = custom && fs.existsSync(custom) ? custom : path.join(ROOT, "generated_docs");
    fs.mkdirSync(base, { recursive: true });
    return path.resolve(base);
  }
  const subdir = (docType) => (has(SUBDIRS, docType) ? SUBDIRS[docType] : "other");
  const dateFolder = (d) => (isRealDate(d) ? d : todayIST());
  function targetFolder(docType, date) {
    const dir = path.join(docsBase(), subdir(docType), dateFolder(date));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  /** A plain file name inside `dir`, or null if it would escape it or has a disallowed extension. */
  function safeFileIn(dir, name) {
    const base = path.basename(String(name || ""));
    if (!base || base !== String(name) || !SAVE_EXT.includes(path.extname(base).toLowerCase())) return null;
    const full = path.resolve(dir, base);
    return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
  }
  const cleanPart = (s, n) => String(s || "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, n);
  function descriptiveName(docType, payload, docNo) {
    const prefix = { pi: "PI", po: "PO", invoice: "Invoice", challan: "Challan" }[docType] || "Document";
    const tag = cleanPart((payload.sections || []).map((s) => s.name).filter(Boolean)[0] || payload.subject
      || (payload.buyer && payload.buyer.name) || (payload.vendor && payload.vendor.name) || payload.receiver_name, 30);
    return [prefix, dateFolder(payload[DATE_FIELD[docType]]), tag, String(docNo).replace(/[^\w-]+/g, "-")].filter(Boolean).join("_") + ".docx";
  }
  function autoSave(docType, payload, filename, buffer) {
    try {
      const dir = targetFolder(docType, payload[DATE_FIELD[docType]]);
      fs.writeFileSync(path.join(dir, filename), buffer);
    } catch (e) {
      console.warn(`[autosave] could not save ${filename}: ${e.message}`);
    }
  }

  // ── Numbers and history ─────────────────────────────────────────────────
  app.get("/next-number/:docType", async (req, res) => {
    try {
      const number = await numbering.preview(req.params.docType, { addressKey: req.query.address, date: req.query.date });
      res.json({ number });
    } catch (e) { fail(res, e); }
  });

  app.get("/documents", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
      res.json(await numbering.listDocuments(req.query.type || null, limit));
    } catch (e) { fail(res, e); }
  });

  app.post("/void-document", async (req, res) => {
    try {
      const { doc_type, doc_number, reason } = req.body || {};
      if (!doc_type || !doc_number) return res.status(400).json({ error: "doc_type and doc_number are required." });
      res.json(await numbering.voidDocument(doc_type, String(doc_number), reason ? String(reason).slice(0, 500) : null));
    } catch (e) { fail(res, e); }
  });

  // ── Generate ────────────────────────────────────────────────────────────
  const KINDS = [
    { route: "purchase-order", type: "po", numberField: "po_no", gen: generatePO, party: (p) => p.vendor && p.vendor.name },
    { route: "proforma-invoice", type: "pi", numberField: "pi_no", gen: generatePI, party: (p) => p.buyer && p.buyer.name },
    { route: "invoice", type: "invoice", numberField: "invoice_no", gen: generateInvoice, party: (p) => p.buyer && p.buyer.name },
    { route: "challan", type: "challan", numberField: "challan_no", gen: generateChallan, party: (p) => p.receiver_name },
  ];
  const logo = fs.readFileSync(path.join(ROOT, "assets", "logo.png"));
  const stampPath = path.join(ROOT, "assets", "stamp.png");
  const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath) : null;

  for (const k of KINDS) {
    app.post(`/generate/${k.route}`, async (req, res) => {
      try {
        const payload = validateAndPrice(k.type, req.body);
        const recordOnly = req.query.format === "json" || req.headers["x-record-only"] === "true";
        const { docNumber, file, offline } = await numbering.issue(k.type, {
          docNumber: payload[k.numberField],
          addressKey: payload.issuing_address_key,
          date: payload[DATE_FIELD[k.type]],
          counterpartyName: k.party(payload),
          totalAmount: k.type === "challan" ? null : payload.grand_total,
          payload,
          build: recordOnly ? null : (num) => k.gen({ ...payload, [k.numberField]: num }, logo, stamp),
        });
        payload[k.numberField] = docNumber;
        // Numbered on this PC without the internet: it will be uploaded to the cloud ledger automatically.
        if (offline) res.setHeader("X-Offline", "1");
        if (recordOnly) return res.json({ success: true, docNumber, payload, offline: !!offline });
        const filename = descriptiveName(k.type, payload, docNumber);
        autoSave(k.type, payload, filename, file);
        res.attachment(filename);
        res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        res.setHeader("X-Document-Number", docNumber);
        res.send(file);
      } catch (e) { fail(res, e); }
    });
  }

  // ── Files kept on this PC ───────────────────────────────────────────────
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  app.post("/api/save-generated-doc", upload.single("file"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file provided." });
      const docType = has(SUBDIRS, req.body.docType) ? req.body.docType : "pi";
      const dir = targetFolder(docType, req.body.docDate);
      const full = safeFileIn(dir, req.body.filename || req.file.originalname);
      if (!full) return res.status(400).json({ error: "The file name must be a plain .pdf or .docx name." });
      fs.writeFileSync(full, req.file.buffer);
      res.json({ success: true, folder: path.relative(docsBase(), dir), dateFolder: path.basename(dir), filename: path.basename(full) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/open-folder", (req, res) => {
    try {
      const { docType, date } = req.body || {};
      const dir = docType && docType !== "all" ? targetFolder(docType, date) : docsBase();
      // execFile passes the folder as one argument — no shell, nothing to inject.
      if (process.platform === "win32") execFile("explorer.exe", [dir], () => {});
      else if (process.platform === "darwin") execFile("open", [dir], () => {});
      else return res.json({ ok: true, platform: process.platform, message: "Folders can only be opened on the PC running the generator." });
      res.json({ ok: true, platform: process.platform });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/generated-docs", (req, res) => {
    try {
      const docType = has(SUBDIRS, req.query.docType) ? req.query.docType : "pi";
      const base = path.join(docsBase(), subdir(docType));
      if (!fs.existsSync(base)) return res.json({ docType, folders: [] });
      const folders = fs.readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((d) => ({
          date: d.name,
          files: fs.readdirSync(path.join(base, d.name)).map((f) => {
            const st = fs.statSync(path.join(base, d.name, f));
            return { name: f, size: st.size, mtime: st.mtime };
          }),
        }));
      res.json({ docType, folders });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/download-file", (req, res) => {
    try {
      const { docType, date, filename } = req.query;
      if (!has(SUBDIRS, docType) || !isRealDate(date) || !filename) return res.status(400).send("Missing or invalid parameters.");
      const full = safeFileIn(path.join(docsBase(), subdir(docType), date), filename);
      if (!full || !fs.existsSync(full)) return res.status(404).send("File not found.");
      res.download(full, path.basename(full));
    } catch (e) { fail(res, e); }
  });

  // ── Reading a photo / PDF of a measurement sheet (needs the internet) ───
  app.post("/extract-items", async (req, res) => {
    try {
      const out = await extractItems(req.body || {}, env.GEMINI_API_KEY);
      res.json(out);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      fail(res, e);
    }
  });

  // What was numbered offline and is still waiting to be uploaded, and any conflicts found when uploading.
  app.get("/api/offline-status", (req, res) => res.json({ offlineLedger: !!local, ...numbering.status() }));
  app.post("/api/sync", async (req, res) => {
    try {
      res.json({ offlineLedger: !!local, ...(await numbering.sync()), ...numbering.status() });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/config-status", (req, res) => {
    res.json({ gemini: !!env.GEMINI_API_KEY, supabase: !!supabase, accessCode: !!ACCESS_CODE });
  });

  // Anything else: not here (and never a file from the app folder).
  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  // Bad JSON, oversize bodies, anything unexpected: a plain message, never a stack trace or a path.
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (e && (e.type === "entity.parse.failed")) return res.status(400).json({ error: "The request was not valid JSON." });
    if (e && (e.type === "entity.too.large" || e.code === "LIMIT_FILE_SIZE")) return res.status(413).json({ error: "The request is too large." });
    fail(res, e);
  });
  return app;
}

module.exports = { createApp, getExtractionPrompt };
