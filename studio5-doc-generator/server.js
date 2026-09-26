require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const generatePO = require("./generators/generate_po.js");
const generatePI = require("./generators/generate_pi.js");
const generateInvoice = require("./generators/generate_invoice.js");
const generateChallan = require("./generators/generate_challan.js");
const documentNumbering = require("./lib/documentNumbering.js");

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.includes("mp4") ? ".mp4" : ".webm");
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `audio-${uniqueSuffix}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-gemini-key, x-openai-key, x-anthropic-key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname)));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "studio5_doc_generator.html"));
});

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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "studio5_doc_generator.html"));
});

const logoBuffer = fs.readFileSync(path.join(__dirname, "assets", "logo.png"));
const stampBuffer = fs.existsSync(path.join(__dirname, "assets", "stamp.png"))
  ? fs.readFileSync(path.join(__dirname, "assets", "stamp.png"))
  : null;

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
  if (e.code === "DUPLICATE_NUMBER") {
    return res.status(409).json({ error: e.message });
  }
  console.error(e);
  return res.status(500).json({ error: e.message });
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
    sendDocx(res, buf, `Purchase_Order_${safeFilenamePart(docNumber)}.docx`, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

app.post("/generate/proforma-invoice", async (req, res) => {
  try {
    const payload = req.body;
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
    sendDocx(res, buf, `Proforma_Invoice_${safeFilenamePart(docNumber)}.docx`, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

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
    sendDocx(res, buf, `Invoice_${safeFilenamePart(docNumber)}.docx`, docNumber);
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
    sendDocx(res, buf, `Delivery_Challan_${safeFilenamePart(docNumber)}.docx`, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

app.post("/api/parse-item-audio", upload.single("audio"), async (req, res) => {
  const tempFilePath = req.file ? req.file.path : null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const geminiApiKey = req.body.geminiApiKey || req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;
    const openaiApiKey = req.body.openaiApiKey || req.headers["x-openai-key"] || process.env.OPENAI_API_KEY;
    const anthropicApiKey = req.body.anthropicApiKey || req.headers["x-anthropic-key"] || process.env.ANTHROPIC_API_KEY;

    // --- STRATEGY 1: GOOGLE GEMINI (100% Free Tier, no prepaid credit limits) ---
    if (geminiApiKey) {
      try {
        console.log(`[parse-item-audio] Processing audio via Google Gemini (Free Tier)...`);
        const audioBuffer = fs.readFileSync(req.file.path);
        const cleanBase64 = audioBuffer.toString("base64");

        let actualMime = req.file.mimetype || "audio/webm";
        if (actualMime.includes("webm")) actualMime = "audio/webm";
        else if (actualMime.includes("mp4")) actualMime = "audio/mp4";
        else if (actualMime.includes("ogg")) actualMime = "audio/ogg";
        else if (actualMime.includes("wav")) actualMime = "audio/wav";
        else actualMime = "audio/webm";

        const promptText = `You are the Chief Fit-Out Estimator for Studio5 Interiors (an interior contracting firm in India).
Listen carefully to this spoken audio in Hindi, Hinglish, or English.
Parse the spoken words into a structured contracting line item:
1. Translate informal or slang terms (e.g., 'malba') into formal contracting terms ('Debris Carting Away').
2. Format the description professionally according to Indian interior contracting standards (e.g., 'Providing & fixing Gypsum board false ceiling in Master Bedroom').
3. UOM must strictly be one of: 'sqft', 'rft', 'nos', or 'lumpsum'.
   - Area works (ceilings, flooring, wall panelling, painting, plastering, dismantling) -> 'sqft'
   - Running length (cove profiles, skirting, pelmet, kitchen counter length, AC copper piping) -> 'rft'
   - Discrete fixtures (mirrors, lights, doors, locks, vanity, sanitaryware, chairs) -> 'nos'
   - General cleaning / bulk dumping -> 'lumpsum'
4. If rate or quantity is not explicitly spoken, return null for those fields.

Return ONLY valid JSON matching this schema:
{
  "transcript": "string (the exact spoken transcription in Hindi/English)",
  "description": "string (formal contractor line item description)",
  "uom": "string",
  "qty": number | null,
  "rate": number | null
}`;

        const callGeminiAudio = async (modelName) => {
          return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`, {
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
        };

        const available = await getAvailableGeminiModels(geminiApiKey);
        const preferred = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.0-flash-exp"];
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

        let geminiResponse = null;
        let lastGeminiError = "";
        for (const model of candidateModels) {
          console.log(`[parse-item-audio] Attempting Gemini model: ${model}`);
          geminiResponse = await callGeminiAudio(model);
          if (geminiResponse.ok) break;
          lastGeminiError = await geminiResponse.text();
          console.warn(`[parse-item-audio] Gemini model ${model} error: ${lastGeminiError}`);
        }

        if (geminiResponse && geminiResponse.ok) {
          const gData = await geminiResponse.json();
          const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            let parsed = null;
            const match = rawText.match(/\{[\s\S]*\}/);
            parsed = match ? JSON.parse(match[0]) : JSON.parse(rawText);
            return res.json({
              success: true,
              engine: "gemini-free",
              transcript: parsed.transcript || "",
              data: parsed,
              description: parsed.description || "",
              uom: parsed.uom || "",
              qty: parsed.qty ?? null,
              rate: parsed.rate ?? null
            });
          }
        }
      } catch (geminiErr) {
        console.warn("[parse-item-audio] Gemini attempt failed, trying fallback:", geminiErr.message);
      }
    }

    // --- STRATEGY 2: OPENAI WHISPER + CLAUDE FALLBACK ---
    if (openaiApiKey && anthropicApiKey) {
      console.log(`[parse-item-audio] Processing audio via Whisper + Claude fallback...`);
      const openai = new OpenAI({ apiKey: openaiApiKey });
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(req.file.path),
        model: "whisper-1",
        language: "hi"
      });

      const transcript = (transcription.text || "").trim();
      if (!transcript) {
        return res.status(400).json({ error: "No spoken speech was detected in the audio recording." });
      }

      const claudeMsg = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: `You are the Chief Fit-Out Estimator for Studio5 Interiors.
Parse this raw spoken transcript into a structured contracting line item.
The user is speaking in Hindi/English. Translate informal terms (e.g., 'malba') into formal terms ('Debris Carting Away').
UOM must strictly be one of: 'sqft', 'rft', 'nos', or 'lumpsum'.
If rate or quantity is not explicitly spoken, return null for those fields.

Return ONLY valid JSON matching this schema:
{
  "description": "string",
  "uom": "string",
  "qty": number | null,
  "rate": number | null
}`,
        messages: [{ role: "user", content: transcript }]
      });

      let rawText = "";
      if (claudeMsg.content && claudeMsg.content.length > 0) {
        rawText = claudeMsg.content.map(c => c.text || "").join("\n");
      }

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsedData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawText);

      return res.json({
        success: true,
        engine: "whisper-claude",
        transcript,
        data: parsedData,
        description: parsedData.description || "",
        uom: parsedData.uom || "",
        qty: parsedData.qty ?? null,
        rate: parsedData.rate ?? null
      });
    }

    return res.status(400).json({
      error: "No AI key available. Please configure GEMINI_API_KEY on Render (it is 100% free)."
    });
  } catch (err) {
    console.error("Audio parsing error:", err);
    return res.status(500).json({ error: err.message || "Failed to parse item audio" });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, (err) => {
        if (err) console.warn("Could not delete temp audio file:", tempFilePath, err.message);
      });
    }
  }
});

app.post("/api/parse-party-audio", upload.single("audio"), async (req, res) => {
  const tempFilePath = req.file ? req.file.path : null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const geminiApiKey = req.body.geminiApiKey || req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;

    if (geminiApiKey) {
      try {
        console.log(`[parse-party-audio] Processing party voice via Google Gemini (Free Tier)...`);
        const audioBuffer = fs.readFileSync(req.file.path);
        const cleanBase64 = audioBuffer.toString("base64");

        let actualMime = req.file.mimetype || "audio/webm";
        if (actualMime.includes("webm")) actualMime = "audio/webm";
        else if (actualMime.includes("mp4")) actualMime = "audio/mp4";
        else if (actualMime.includes("ogg")) actualMime = "audio/ogg";
        else if (actualMime.includes("wav")) actualMime = "audio/wav";
        else actualMime = "audio/webm";

        const promptText = `You are an administrative and accounting assistant for Studio5 Interiors (an interior contracting firm in India).
Listen carefully to this spoken audio in Hindi, Hinglish, or English where the user is dictating party, client, buyer, vendor, or project site details.
Extract and structure the information into clean, formal Indian business format:
1. "name": The formal business, company, hotel, or individual client name. If informal, capitalize properly (e.g., 'Lemon Tree Hotels', 'DLF Cyber City Developers').
2. "address": The complete, properly formatted multi-line postal address with street, area/sector, city, state, and 6-digit PIN code.
3. "gstin": The 15-character Indian Goods & Services Tax identification number if spoken (e.g., '06AAACC3164A1ZD'). If not spoken or unclear, return "".
4. "attn": Contact person name or 'Kind Attention' designation (e.g., 'Mr. Kuldeep Ji', 'Amit Verma (Project Head)'), plus phone number if mentioned.
5. "label": A clean, concise label for dropdown menus (e.g., 'Lemon Tree Hotel, Dehradun' or 'DLF Cyber City - Phase 5').

Return ONLY valid JSON matching this schema:
{
  "transcript": "string",
  "label": "string",
  "name": "string",
  "address": "string",
  "gstin": "string",
  "attn": "string"
}`;

        const callGemini = async (modelName) => {
          return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`, {
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
        };

        const available = await getAvailableGeminiModels(geminiApiKey);
        const preferred = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.0-flash-exp"];
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

        let geminiResponse = null;
        for (const model of candidateModels) {
          console.log(`[parse-party-audio] Attempting Gemini model: ${model}`);
          geminiResponse = await callGemini(model);
          if (geminiResponse.ok) break;
        }

        if (geminiResponse && geminiResponse.ok) {
          const gData = await geminiResponse.json();
          const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const match = rawText.match(/\{[\s\S]*\}/);
            const parsed = match ? JSON.parse(match[0]) : JSON.parse(rawText);
            return res.json({
              success: true,
              engine: "gemini-free",
              transcript: parsed.transcript || "",
              data: parsed,
              label: parsed.label || parsed.name || "New Party",
              name: parsed.name || "",
              address: parsed.address || "",
              gstin: parsed.gstin || "",
              attn: parsed.attn || ""
            });
          }
        }
      } catch (geminiErr) {
        console.warn("[parse-party-audio] Gemini attempt failed:", geminiErr.message);
      }
    }

    return res.status(400).json({
      error: "No AI key available. Please configure GEMINI_API_KEY on Render."
    });
  } catch (err) {
    console.error("Party audio parsing error:", err);
    return res.status(500).json({ error: err.message || "Failed to parse party audio" });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, (err) => {
        if (err) console.warn("Could not delete temp audio file:", tempFilePath, err.message);
      });
    }
  }
});

app.get("/api/config-status", (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    supabase: !!process.env.SUPABASE_URL
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio5 doc generator API running on port ${PORT}`));