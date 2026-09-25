const express = require("express");
const fs = require("fs");
const path = require("path");

const generatePO = require("./generators/generate_po.js");
const generatePI = require("./generators/generate_pi.js");
const generateInvoice = require("./generators/generate_invoice.js");
const generateChallan = require("./generators/generate_challan.js");
const documentNumbering = require("./lib/documentNumbering.js");

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    const buf = await generateChallan(payload, logoBuffer, stampBuffer);
    sendDocx(res, buf, `Delivery_Challan_${safeFilenamePart(docNumber)}.docx`, docNumber);
  } catch (e) {
    handleLedgerError(res, e);
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio5 doc generator API running on port ${PORT}`));