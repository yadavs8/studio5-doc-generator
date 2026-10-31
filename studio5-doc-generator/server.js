require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const generatePO = require("./generators/generate_po.js");
const generatePI = require("./generators/generate_pi.js");
const generateInvoice = require("./generators/generate_invoice.js");
const generateChallan = require("./generators/generate_challan.js");
const documentNumbering = require("./lib/documentNumbering.js");
const storage = require("./lib/storage.js");
const { requireUser, publicAuthConfig } = require("./lib/auth.js");
const devices = require("./lib/devices.js");

const app = express();
// Render sits behind one proxy; trust it so req.ip is the caller, not the
// proxy (the sign-in rate limits below count per caller).
if (process.env.RENDER) app.set("trust proxy", 1);

// Only these sites may call the API from a browser. The tool itself is
// served by this same server, so it is same-origin and needs no entry here;
// add other front-ends (e.g. the po-tracker's GitHub Pages site) through
// CORS_ORIGINS, comma-separated.
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map(o => o.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-gemini-key, x-record-only");
    res.setHeader("Access-Control-Expose-Headers", "X-Document-Number, X-Ledger-Id, X-Revision, X-Pi-Id, Content-Disposition");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Public: the page itself, its assets, and what it needs before sign-in.
// Only named files are served — serving the whole folder used to expose
// generated_docs/ (every saved PI/invoice) to anyone who guessed a path.
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "manifest.json")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "studio5_doc_generator.html"));
});
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/api/auth-config", (req, res) => res.json(publicAuthConfig()));
app.get("/api/config-status", (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    supabase: !!process.env.SUPABASE_URL,
    auth: publicAuthConfig().enabled
  });
});

// ----- Sign-in: email code once per device, then a 4-digit MPIN -----
// These run before sign-in exists, so each is rate-limited per caller on top
// of Supabase's own limits and the 5-wrong-MPIN device lock.
const rateBuckets = new Map();
function rateLimit(name, perMinute) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || b.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60 * 1000 });
      if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
      return next();
    }
    if (++b.count > perMinute) {
      return res.status(429).json({ error: "Too many attempts. Please wait a minute and try again.", code: "RATE_LIMITED" });
    }
    next();
  };
}
const smallJson = express.json({ limit: "10kb" });

function handleDeviceError(res, e) {
  if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error("[devices]", e);
  res.status(500).json({ error: "Sign-in failed on the server. Please try again." });
}

app.post("/api/auth/otp/start", rateLimit("otp-start", 5), smallJson, async (req, res) => {
  try {
    await devices.startOtp(req.body.email);
    res.json({ ok: true });
  } catch (e) {
    handleDeviceError(res, e);
  }
});

app.post("/api/auth/otp/verify", rateLimit("otp-verify", 10), smallJson, async (req, res) => {
  try {
    const { email, code, device_name, replace_device_id } = req.body;
    res.json(await devices.verifyOtp(email, code, device_name, replace_device_id));
  } catch (e) {
    handleDeviceError(res, e);
  }
});

app.post("/api/auth/pin/unlock", rateLimit("pin-unlock", 20), smallJson, async (req, res) => {
  try {
    const { device_id, device_secret, pin } = req.body;
    res.json(await devices.unlockWithPin(device_id, device_secret, pin));
  } catch (e) {
    handleDeviceError(res, e);
  }
});

// Everything registered below requires a signed-in user. Checked before the
// body is parsed, so an anonymous caller can't make the server read 25 MB.
app.use(requireUser);

app.post("/api/auth/pin/set", smallJson, async (req, res) => {
  try {
    if (!req.user) return res.status(503).json({ error: "MPIN sign-in is not set up on this server.", code: "NOT_CONFIGURED" });
    const { device_id, device_secret, pin } = req.body;
    await devices.setPin(req.user.id, device_id, device_secret, pin);
    res.json({ ok: true });
  } catch (e) {
    handleDeviceError(res, e);
  }
});

app.get("/api/auth/devices", async (req, res) => {
  try {
    res.json(await devices.listDevices());
  } catch (e) {
    handleDeviceError(res, e);
  }
});

app.post("/api/auth/devices/:id/revoke", async (req, res) => {
  try {
    await devices.revokeDevice(req.params.id, req.user && req.user.email);
    res.json({ ok: true });
  } catch (e) {
    handleDeviceError(res, e);
  }
});

app.use(express.json({ limit: "25mb" }));

function getExtractionPrompt(scopeMode) {
  const isRenovation = scopeMode !== "new_work";
  return `You are an expert quantity surveyor and estimator for Studio5 Interiors (an interior architecture and contracting firm in India).
The attached image or text is a handwritten site measurement sheet, diary note, BOQ list, or contractor quotation.

CRITICAL CONTRACTING RULES & SCOPE IMPROVISATION:
Site notes are written in brief shorthand (e.g. "Ceiling 400 sqft", "Flooring 650 sqft", "Master bed renovation", "2 mirrors 4x3").
You must intelligently IMPROVISE and EXPAND raw shorthand into complete professional contracting line items according to real-world interior execution standards:

${isRenovation ? `
1. RENOVATION & MAJOR WORKS EXPANSION (Area-based in 'sqft' or running length in 'rft'):
   When a note mentions "ceiling", "flooring", "partition", "tile work", or general renovation for an area/room, DO NOT just return a single supply item.
   Break it down into the realistic contracting sequence:
   a) DISMANTLING / DEMOLITION:
      - For ceiling: "Dismantling of existing old false ceiling including framework and hardware safely without damaging structure" (UOM: sqft).
      - For flooring: "Dismantling/hacking of existing floor tiles, skirting and cement mortar bed" (UOM: sqft).
      - For walls/partitions: "Dismantling of existing wall panelling/partition/doors" (UOM: sqft or nos).
   b) DEBRIS CLEARING & CARTING AWAY:
      - "Collecting, lifting, cleaning and carting away all dismantled debris, malba and waste material from site to approved municipal dumping ground" (UOM: sqft or lumpsum).
   c) SURFACE PREPARATION / BASE WORK:
      - For flooring: "Surface preparation and cement mortar leveling screed bed complete" (UOM: sqft).
   d) REBUILDING & NEW FABRICATION:
      - For ceiling: "Providing & fixing new Gypsum board false ceiling with G.I. framing, perimeter channels, joint tape & compound finishing complete" (UOM: sqft).
      - For flooring: "Laying new glazed vitrified tiles / wooden flooring complete with adhesive, spacer and epoxy grouting" (UOM: sqft).
      - If cove is mentioned or standard: "Providing & fixing cove lighting profile detail in Gypsum false ceiling" (UOM: rft).
` : `
1. NEW WORK ONLY:
   Generate direct supply and installation line items with complete technical specifications (without demolition/dismantling steps).
`}

2. DISCRETE GOODS & FIXTURES (strictly in 'nos'):
   Items like mirrors, LED mirrors, vanity units, flush doors, door locks/handles, electrical fixtures, sanitary ware, loose furniture items MUST ALWAYS have UOM as "nos" (numbers) or "set", NEVER sqft or rft.
   - Example: "Supplying & installing 5mm bevelled edge designer mirror / LED backlit mirror with mounting bracket complete" -> UOM: "nos".
   - Example: "Providing & fixing 32mm flush door shutter with laminate finish, teak lipping, hinges & mortise lock" -> UOM: "nos".

3. ACCURATE UNITS (UOM) ENFORCEMENT:
   - Areas (ceilings, flooring, wall panelling, painting, plastering, dismantling) -> "sqft"
   - Running lengths (cove profiles, skirting, pelmet, kitchen counter length, AC copper piping) -> "rft"
   - Discrete fixtures (mirrors, lights, switches, doors, vanity, chairs, basins) -> "nos"
   - General cleaning / bulk debris dumping -> "lumpsum" or "sqft"

4. QUANTITIES & CALCULATIONS:
   - If dimensions are given (e.g. 10x12 or 15*20), compute the area (120, 300) for sqft items.
   - When a ceiling/floor area is given (e.g. 400 sqft), apply the SAME 400 sqft to the Dismantling, Debris, and Rebuilding steps.
   - Rates: Extract rates if written. If missing, leave rate as null.

5. SECTION & ROOM ORGANIZATION:
   Group items into logical sections by room/area (e.g. "Drawing Room", "Master Bedroom", "Kitchen", "Common Area"). If no room is mentioned, use "Main Fit-Out Works".

Respond ONLY in valid JSON matching this schema:
{
  "sections": [
    {
      "section_name": "Master Bedroom",
      "items": [
        {
          "particulars": "Dismantling of existing old false ceiling including framework safely",
          "uom": "sqft",
          "qty": 350,
          "rate": 18
        },
        {
          "particulars": "Collecting and carting away ceiling debris / malba from site",
          "uom": "sqft",
          "qty": 350,
          "rate": 8
        },
        {
          "particulars": "Providing & fixing Gypsum board false ceiling with G.I. channels complete",
          "uom": "sqft",
          "qty": 350,
          "rate": 125
        },
        {
          "particulars": "Supplying & installing 5mm bevelled edge LED backlit mirror complete",
          "uom": "nos",
          "qty": 2,
          "rate": 3500
        }
      ]
    }
  ]
}`;
}

async function getAvailableGeminiModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      const available = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ''));
      return available;
    }
  } catch (e) {
    console.warn("Could not query ListModels:", e.message);
  }
  return [];
}

app.post("/extract-items", async (req, res) => {
  try {
    const { image, mimeType, scopeMode } = req.body;
    const apiKey = req.body.apiKey || req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: "Gemini API key is required. Please set GEMINI_API_KEY on the server or enter it in the Library tab."
      });
    }
    if (!image) {
      return res.status(400).json({ error: "No image data provided" });
    }
    const cleanBase64 = String(image).replace(/^data:image\/[a-z]+;base64,/, "").replace(/^data:application\/pdf;base64,/, "");
    const actualMime = mimeType || "image/jpeg";
    const promptText = getExtractionPrompt(scopeMode || "renovation");

    const callGemini = async (modelName) => {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inlineData: { mimeType: actualMime, data: cleanBase64 } },
                { text: promptText }
              ]
            }
          ],
          generationConfig: { responseMimeType: "application/json" }
        })
      });
      return response;
    };

    const available = await getAvailableGeminiModels(apiKey);
    const preferred = [
      "gemini-2.0-flash",
      "gemini-2.0-flash-exp",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-1.5-flash-latest",
      "gemini-1.5-flash-002",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-pro"
    ];

    let candidateModels = [];
    if (available.length > 0) {
      for (const p of preferred) {
        if (available.includes(p)) candidateModels.push(p);
      }
      for (const m of available) {
        if (!candidateModels.includes(m) && m.includes("flash")) candidateModels.push(m);
      }
      if (candidateModels.length === 0) candidateModels = available;
    } else {
      candidateModels = preferred;
    }

    let response = null;
    let lastError = "";

    for (const model of candidateModels) {
      console.log(`[extract-items] Attempting Gemini model: ${model}`);
      response = await callGemini(model);
      if (response.ok) {
        break;
      }
      lastError = await response.text();
      console.warn(`[extract-items] Model ${model} returned error ${response.status}: ${lastError}`);
    }

    if (!response || !response.ok) {
      return res.status(response ? response.status : 500).json({
        error: `Gemini API error: ${lastError || "All candidate models failed"}`
      });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: "No extraction content returned by Gemini" });
    }
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    console.error("Extraction error:", err);
    res.status(500).json({ error: err.message || "Failed to extract items from image" });
  }
});

const logoBuffer = fs.readFileSync(path.join(__dirname, "assets", "logo.png"));
const stampBuffer = fs.existsSync(path.join(__dirname, "assets", "stamp.png"))
  ? fs.readFileSync(path.join(__dirname, "assets", "stamp.png"))
  : null;

let customDocsDir = process.env.STUDIO5_DOCS_DIR || null;

function getDocsBaseDir() {
  if (customDocsDir && fs.existsSync(customDocsDir)) {
    return customDocsDir;
  }
  const defaultDir = path.join(__dirname, "generated_docs");
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  return defaultDir;
}

function getDocSubdirName(docType) {
  if (docType === "pi") return "proforma_invoices";
  if (docType === "po") return "purchase_orders";
  if (docType === "inv" || docType === "invoice") return "invoices";
  if (docType === "challan") return "challans";
  return "other";
}

function getTargetDocFolder(docType, dateVal) {
  const base = getDocsBaseDir();
  const sub = getDocSubdirName(docType);
  const dateStr = (dateVal || new Date().toISOString().slice(0, 10)).replace(/[^\d-]/g, "") || new Date().toISOString().slice(0, 10);
  const targetDir = path.join(base, sub, dateStr);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return { targetDir, dateStr };
}

function getDescriptiveTag(docType, payload) {
  if (!payload) return "";
  // 1. Try section names
  const sectionNames = (payload.sections || [])
    .map(s => (s.name || "").trim())
    .filter(Boolean);

  if (sectionNames.length > 0) {
    const cleaned = sectionNames
      .map(n => n.replace(/[\\/:*?"<>|&#%{}@+!]/g, "").trim().replace(/\s+/g, "_"))
      .filter(Boolean);
    if (cleaned.length === 1) return cleaned[0].slice(0, 30);
    if (cleaned.length === 2) return (cleaned[0] + "_" + cleaned[1]).slice(0, 35);
    return (cleaned[0] + "_etc").slice(0, 30);
  }

  // 2. Try subject
  if (payload.subject && payload.subject.trim()) {
    const s = payload.subject.replace(/[\\/:*?"<>|&#%{}@+!]/g, "").trim().replace(/\s+/g, "_");
    if (s) return s.slice(0, 30);
  }

  // 3. Try buyer / vendor / receiver
  const party = (payload.buyer && payload.buyer.name) || (payload.vendor && payload.vendor.name) || payload.receiver_name;
  if (party && party.trim()) {
    const p = party.replace(/[\\/:*?"<>|&#%{}@+!]/g, "").trim().replace(/\s+/g, "_");
    if (p) return p.slice(0, 25);
  }

  return "";
}

function buildDescriptiveDocFilename(docType, payload, docNo, ext) {
  let typePrefix = "Document";
  let dateVal = "";

  if (docType === "pi") {
    typePrefix = "PI";
    dateVal = payload && payload.pi_date;
  } else if (docType === "po") {
    typePrefix = "PO";
    dateVal = payload && payload.po_date;
  } else if (docType === "inv" || docType === "invoice") {
    typePrefix = "Invoice";
    dateVal = payload && payload.invoice_date;
  } else if (docType === "challan") {
    typePrefix = "Challan";
    dateVal = payload && payload.challan_date;
  }

  const dateStr = (dateVal || new Date().toISOString().slice(0, 10)).replace(/[^\d-]/g, "") || new Date().toISOString().slice(0, 10);
  const tag = getDescriptiveTag(docType, payload);
  const cleanDocNo = String(docNo || "DRAFT").replace(/[\\/]/g, "-").trim();

  if (tag) {
    return `${typePrefix}_${dateStr}_${tag}_${cleanDocNo}.${ext}`;
  }
  return `${typePrefix}_${dateStr}_${cleanDocNo}.${ext}`;
}

function autoSaveDocBuffer(docType, dateVal, filename, buffer) {
  try {
    const { targetDir } = getTargetDocFolder(docType, dateVal);
    const fullPath = path.join(targetDir, filename);
    fs.writeFileSync(fullPath, buffer);
    console.log(`[AutoSave] Saved ${docType} to ${fullPath}`);
    return { ok: true, path: fullPath };
  } catch (err) {
    console.warn(`[AutoSave] Warning: Could not auto-save ${filename}:`, err.message);
    return { ok: false, error: err.message };
  }
}

function sendDocx(res, buffer, filename, docNumber) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // Document numbers contain "/" (e.g. "PO/1", "S51/26-27/001") which is
  // fine in a header VALUE but not safe inside the filename itself.
  if (docNumber) res.setHeader("X-Document-Number", docNumber);
  res.send(buffer);
}

function safeFilenamePart(docNumber) {
  return String(docNumber).replace(/[\\/]/g, "-");
}

function handleLedgerError(res, e) {
  if (["DUPLICATE_NUMBER", "NUMBER_FAR_AHEAD", "REVISION_IN_PROGRESS"].includes(e.code)) {
    return res.status(409).json({ error: e.message, code: e.code });
  }
  if (e.code === "BAD_INPUT") return res.status(400).json({ error: e.message, code: e.code });
  if (e.code === "NOT_FOUND") return res.status(404).json({ error: e.message, code: e.code });
  if (e.code === "NOT_CONFIGURED") return res.status(503).json({ error: e.message, code: e.code });
  console.error(e);
  return res.status(500).json({ error: e.message });
}

// ----- Proforma Invoice: draft / final / revise, linked to the po-tracker -----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageDocxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function badInput(message) {
  const err = new Error(message);
  err.code = "BAD_INPUT";
  return err;
}

// What the tracker's proforma_invoice row needs, checked before a number is
// spent so a missing site can't leave a pending entry behind.
function piTrackerFields(src) {
  const siteId = src.site_id;
  if (!siteId || !UUID_RE.test(siteId)) throw badInput("Pick the client site this PI is for.");
  if (src.po_id && !UUID_RE.test(src.po_id)) throw badInput("The selected PO / work order is not valid.");
  if (src.sub_project_id && !UUID_RE.test(src.sub_project_id)) throw badInput("The selected sub-project is not valid.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(src.pi_date || ""))) throw badInput("Enter the P.I. date.");
  const amount = Number(src.grand_total);
  if (!(amount > 0)) throw badInput("The PI total must be more than zero.");
  return {
    siteId,
    poId: src.po_id || null,
    subProjectId: src.sub_project_id || null,
    piDate: src.pi_date,
    amount,
    remarks: src.work_status || null,
  };
}

// Upload, then record in one database transaction. If recording fails the
// upload is removed again and the ledger row stays pending.
async function storeAndFinalizePi(ledger, buffer, ext, fields, userId) {
  const storagePath = storage.pathFor("pi", fields.siteId, ledger.docNumber, ledger.revision, ext);
  await storage.upload(storagePath, buffer, ext);
  try {
    const piId = await documentNumbering.finalizePi({ ledgerId: ledger.ledgerId, storagePath, userId, ...fields });
    return { piId, storagePath };
  } catch (e) {
    await storage.remove(storagePath);
    throw e;
  }
}

// After a number is reserved, a failure must say so: the entry is pending and
// can be retried or discarded from the Library.
function sendPendingError(res, e, ledger) {
  console.error(`[pi] ${ledger.docNumber} r${ledger.revision} left pending:`, e.message);
  res.status(502).json({
    error: `PI ${ledger.docNumber} could not be saved: ${e.message} It is kept as pending — retry or discard it from the Library.`,
    code: "SAVED_AS_PENDING",
    ledger_id: ledger.ledgerId,
    doc_number: ledger.docNumber,
    revision: ledger.revision,
  });
}

function sendFinalPi(res, buf, payload, ledger, result) {
  const label = ledger.revision > 1 ? `${ledger.docNumber} r${ledger.revision}` : ledger.docNumber;
  const filename = buildDescriptiveDocFilename("pi", payload, label, "docx");
  // Optional copy on this PC; on Render the disk is wiped on every restart.
  if (process.env.STUDIO5_DOCS_DIR) autoSaveDocBuffer("pi", payload.pi_date, filename, buf);
  res.setHeader("X-Ledger-Id", ledger.ledgerId);
  res.setHeader("X-Revision", String(ledger.revision));
  res.setHeader("X-Pi-Id", result.piId);
  sendDocx(res, buf, filename, ledger.docNumber);
}

// GET /next-number/:docType?address=<key> — read-only preview of what the
// next number would be. Does not allocate/spend a number, so opening a tab
// and never clicking Generate never creates a gap.
app.get("/next-number/:docType", async (req, res) => {
  try {
    const number = await documentNumbering.previewNextNumber(req.params.docType, {
      addressKey: req.query.address,
    });
    res.json({ number });
  } catch (e) {
    if (e.code === "INVALID_DOC_TYPE") return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /documents?type=<docType>&limit=<n> — recent generated-document
// history, for the Library tab's "Recent Generated Documents" panel.
app.get("/documents", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const docs = await documentNumbering.listDocuments(req.query.type || null, limit);
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /void-document { doc_type, doc_number, reason } — marks a rejected
// document void without disturbing the sequence, so the reason for the gap
// stays on record instead of being silently unexplained.
app.post("/void-document", async (req, res) => {
  try {
    const { doc_type, doc_number, reason } = req.body;
    if (!doc_type || !doc_number) {
      return res.status(400).json({ error: "doc_type and doc_number are required" });
    }
    const updated = await documentNumbering.voidDocument(doc_type, doc_number, reason);
    res.json(updated);
  } catch (e) {
    if (e.code === "NOT_FOUND" || e.code === "INVALID_DOC_TYPE") {
      return res.status(400).json({ error: e.message });
    }
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/generate/purchase-order", async (req, res) => {
  try {
    const payload = req.body;
    const { docNumber } = await documentNumbering.allocateAndRecord("po", {
      docNumber: payload.po_no,
      issuingAddressKey: payload.issuing_address_key,
      counterpartyName: payload.vendor && payload.vendor.name,
      totalAmount: payload.grand_total,
      payload,
    });
    payload.po_no = docNumber;
    if (req.query.format === "json" || req.headers["x-record-only"] === "true") {
      return res.json({ success: true, docNumber, payload });
    }
    const buf = await generatePO(payload, logoBuffer, stampBuffer);
    const filename = buildDescriptiveDocFilename("po", payload, docNumber, "docx");
    autoSaveDocBuffer("po", payload.po_date, filename, buf);
    sendDocx(res, buf, filename, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

// mode (in the body):
//   "draft"  — a DRAFT-numbered file to download; no number spent, nothing saved.
//   "final"  — new number, saved to storage, PI created in the po-tracker.
//   "revise" — revise_of: "<number>"; same number, next revision, the
//              tracker's PI updated, earlier revisions kept.
//   (none)   — the original behaviour, until the page sends a mode.
// With ?format=json (browser-made PDF), final/revise only reserve the number;
// the PDF then goes to POST /api/documents/:ledgerId/file.
app.post("/generate/proforma-invoice", async (req, res) => {
  const payload = req.body;
  const mode = payload.mode;
  if (mode) return generatePiWithMode(req, res, payload, mode);
  try {
    const { docNumber } = await documentNumbering.allocateAndRecord("pi", {
      docNumber: payload.pi_no,
      issuingAddressKey: payload.issuing_address_key,
      counterpartyName: payload.buyer && payload.buyer.name,
      totalAmount: payload.grand_total,
      payload,
    });
    payload.pi_no = docNumber;
    if (req.query.format === "json" || req.headers["x-record-only"] === "true") {
      return res.json({ success: true, docNumber, payload });
    }
    const buf = await generatePI(payload, logoBuffer, stampBuffer);
    const filename = buildDescriptiveDocFilename("pi", payload, docNumber, "docx");
    autoSaveDocBuffer("pi", payload.pi_date, filename, buf);
    sendDocx(res, buf, filename, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

async function generatePiWithMode(req, res, payload, mode) {
  let ledger = null;
  try {
    if (!["draft", "final", "revise"].includes(mode)) throw badInput(`Unknown mode "${mode}".`);

    if (mode === "draft") {
      payload.pi_no = "DRAFT";
      const buf = await generatePI(payload, logoBuffer, stampBuffer);
      return sendDocx(res, buf, buildDescriptiveDocFilename("pi", payload, "DRAFT", "docx"), null);
    }

    if (!require("./lib/supabase")) {
      const err = new Error("Final and revised PIs need Supabase, which is not configured on this server. Use Draft.");
      err.code = "NOT_CONFIGURED";
      throw err;
    }
    const fields = piTrackerFields(payload);
    const userId = req.user ? req.user.id : null;
    const common = {
      payload,
      totalAmount: fields.amount,
      counterpartyName: payload.buyer && payload.buyer.name,
      issuingAddressKey: payload.issuing_address_key,
      createdBy: userId,
      siteId: fields.siteId,
      poId: fields.poId,
    };

    if (mode === "final") {
      ledger = await documentNumbering.allocateAndRecord("pi", {
        ...common,
        docNumber: payload.pi_no,
        status: "pending",
        confirmFarAhead: payload.confirm_far_ahead === true,
      });
    } else {
      if (!payload.revise_of) throw badInput("Pick the PI to revise.");
      ledger = await documentNumbering.beginRevision("pi", payload.revise_of, common);
    }
    payload.pi_no = ledger.docNumber;

    if (req.query.format === "json" || req.headers["x-record-only"] === "true") {
      return res.json({ success: true, docNumber: ledger.docNumber, ledger_id: ledger.ledgerId, revision: ledger.revision, payload });
    }

    let buf, result;
    try {
      buf = await generatePI(payload, logoBuffer, stampBuffer);
      result = await storeAndFinalizePi(ledger, buf, "docx", fields, userId);
    } catch (e) {
      return sendPendingError(res, e, ledger);
    }
    sendFinalPi(res, buf, payload, ledger, result);
  } catch (e) {
    handleLedgerError(res, e);
  }
}

// A pending PI's ledger row holds everything needed to finish it.
async function loadPendingPi(ledgerId) {
  if (!UUID_RE.test(String(ledgerId))) throw Object.assign(new Error("No such document."), { code: "NOT_FOUND" });
  const row = await documentNumbering.getLedgerRow(ledgerId);
  if (!row || row.doc_type !== "pi") throw Object.assign(new Error("No such PI."), { code: "NOT_FOUND" });
  if (row.status !== "pending") throw badInput(`PI ${row.doc_number} (revision ${row.revision}) is already ${row.status}.`);
  const payload = { ...row.payload, pi_no: row.doc_number };
  const fields = piTrackerFields({
    ...payload,
    site_id: row.site_id,
    po_id: row.po_id,
    grand_total: row.total_amount,
  });
  return { row, payload, fields, ledger: { ledgerId: row.id, docNumber: row.doc_number, revision: row.revision } };
}

app.post("/generate/invoice", async (req, res) => {
  try {
    const payload = req.body;
    const { docNumber } = await documentNumbering.allocateAndRecord("invoice", {
      docNumber: payload.invoice_no,
      opts: { addressKey: payload.issuing_address_key },
      issuingAddressKey: payload.issuing_address_key,
      counterpartyName: payload.buyer && payload.buyer.name,
      totalAmount: payload.grand_total,
      payload,
    });
    payload.invoice_no = docNumber;
    if (req.query.format === "json" || req.headers["x-record-only"] === "true") {
      return res.json({ success: true, docNumber, payload });
    }
    const buf = await generateInvoice(payload, logoBuffer, stampBuffer);
    const filename = buildDescriptiveDocFilename("invoice", payload, docNumber, "docx");
    autoSaveDocBuffer("invoice", payload.invoice_date, filename, buf);
    sendDocx(res, buf, filename, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

app.post("/generate/challan", async (req, res) => {
  try {
    const payload = req.body;
    const { docNumber } = await documentNumbering.allocateAndRecord("challan", {
      docNumber: payload.challan_no,
      issuingAddressKey: payload.issuing_address_key,
      counterpartyName: payload.receiver_name,
      totalAmount: null,
      payload,
    });
    payload.challan_no = docNumber;
    if (req.query.format === "json" || req.headers["x-record-only"] === "true") {
      return res.json({ success: true, docNumber, payload });
    }
    const buf = await generateChallan(payload, logoBuffer, stampBuffer);
    const filename = buildDescriptiveDocFilename("challan", payload, docNumber, "docx");
    autoSaveDocBuffer("challan", payload.challan_date, filename, buf);
    sendDocx(res, buf, filename, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// POST /api/documents/:ledgerId/file (multipart "file") — finishes a pending
// PI with a file made in the browser (the PDF route), the same way the server
// finishes a .docx: upload, then record in the po-tracker.
app.post("/api/documents/:ledgerId/file", memoryUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw badInput("No file was sent.");
    const ext = req.file.mimetype === "application/pdf" ? "pdf"
      : req.file.mimetype === storageDocxType ? "docx" : null;
    if (!ext) throw badInput("Only PDF or Word (.docx) files can be saved.");
    const { fields, ledger } = await loadPendingPi(req.params.ledgerId);
    let result;
    try {
      result = await storeAndFinalizePi(ledger, req.file.buffer, ext, fields, req.user ? req.user.id : null);
    } catch (e) {
      return sendPendingError(res, e, ledger);
    }
    res.json({ success: true, doc_number: ledger.docNumber, revision: ledger.revision, pi_id: result.piId, storage_path: result.storagePath });
  } catch (e) {
    handleLedgerError(res, e);
  }
});

// POST /api/documents/:ledgerId/retry — rebuilds a pending PI's .docx from
// its saved details and finishes it.
app.post("/api/documents/:ledgerId/retry", async (req, res) => {
  try {
    const { payload, fields, ledger } = await loadPendingPi(req.params.ledgerId);
    let buf, result;
    try {
      buf = await generatePI(payload, logoBuffer, stampBuffer);
      result = await storeAndFinalizePi(ledger, buf, "docx", fields, req.user ? req.user.id : null);
    } catch (e) {
      return sendPendingError(res, e, ledger);
    }
    sendFinalPi(res, buf, payload, ledger, result);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

// POST /api/documents/:ledgerId/abandon { reason } — gives up on a pending
// entry. A new number is voided with the reason on record; a pending
// revision is voided and the live revision stays as it was.
app.post("/api/documents/:ledgerId/abandon", express.json(), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.ledgerId)) throw Object.assign(new Error("No such document."), { code: "NOT_FOUND" });
    await documentNumbering.abandonPending(req.params.ledgerId, req.body && req.body.reason);
    res.json({ success: true });
  } catch (e) {
    handleLedgerError(res, e);
  }
});

// GET /api/documents/:ledgerId/download — a 5-minute link to the saved file.
app.get("/api/documents/:ledgerId/download", async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.ledgerId)) throw Object.assign(new Error("No such document."), { code: "NOT_FOUND" });
    const row = await documentNumbering.getLedgerRow(req.params.ledgerId);
    if (!row || !row.storage_path) throw Object.assign(new Error("No saved file for this document."), { code: "NOT_FOUND" });
    res.json({ url: await storage.signedUrl(row.storage_path), doc_number: row.doc_number, revision: row.revision });
  } catch (e) {
    handleLedgerError(res, e);
  }
});

// POST /api/save-generated-doc — receives generated PDF (or other files) from client
app.post("/api/save-generated-doc", memoryUpload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }
    const docType = req.body.docType || "pi";
    const docDate = req.body.docDate || "";
    const filename = req.body.filename || req.file.originalname || `document_${Date.now()}.pdf`;

    const { targetDir, dateStr } = getTargetDocFolder(docType, docDate);
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    console.log(`[AutoSave] Saved uploaded ${docType} file to: ${filePath}`);
    res.json({
      success: true,
      savedPath: filePath,
      folder: targetDir,
      dateFolder: dateStr,
      filename
    });
  } catch (err) {
    console.error("[AutoSave] Error saving uploaded file:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/open-folder — opens the dated folder in Windows Explorer or macOS Finder
app.post("/api/open-folder", (req, res) => {
  try {
    const { docType, date } = req.body;
    let targetDir = getDocsBaseDir();
    if (docType && docType !== "all") {
      const folderRes = getTargetDocFolder(docType, date);
      targetDir = folderRes.targetDir;
    }

    if (process.platform === "win32") {
      require("child_process").exec(`explorer.exe "${targetDir}"`);
      return res.json({ ok: true, platform: "win32", path: targetDir });
    } else if (process.platform === "darwin") {
      require("child_process").exec(`open "${targetDir}"`);
      return res.json({ ok: true, platform: "darwin", path: targetDir });
    } else {
      return res.json({ ok: true, platform: "linux", path: targetDir, message: "Server running in cloud/Linux" });
    }
  } catch (err) {
    console.error("Open folder error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/generated-docs — lists organized folders and documents
app.get("/api/generated-docs", (req, res) => {
  try {
    const docType = req.query.docType || "pi";
    const sub = getDocSubdirName(docType);
    const baseDir = path.join(getDocsBaseDir(), sub);

    if (!fs.existsSync(baseDir)) {
      return res.json({ docType, baseDir, folders: [] });
    }

    const folders = [];
    const dateEntries = fs.readdirSync(baseDir, { withFileTypes: true });
    dateEntries
      .filter(d => d.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))
      .forEach(d => {
        const folderPath = path.join(baseDir, d.name);
        const files = fs.readdirSync(folderPath).map(f => {
          const stat = fs.statSync(path.join(folderPath, f));
          return {
            name: f,
            size: stat.size,
            mtime: stat.mtime
          };
        });
        folders.push({
          date: d.name,
          path: folderPath,
          files
        });
      });

    res.json({ docType, baseDir, folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/download-file — download any archived document
app.get("/api/download-file", (req, res) => {
  try {
    const { docType, date, filename } = req.query;
    if (!docType || !date || !filename) {
      return res.status(400).send("Missing parameters");
    }
    const safeDate = String(date).replace(/[^\d-]/g, "");
    const safeFile = path.basename(String(filename));
    const sub = getDocSubdirName(docType);
    const filePath = path.join(getDocsBaseDir(), sub, safeDate, safeFile);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("File not found");
    }
    res.download(filePath, safeFile);
  } catch (e) {
    res.status(500).send(e.message);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio5 doc generator API running on port ${PORT}`));