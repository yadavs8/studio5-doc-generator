const express = require("express");
const fs = require("fs");
const path = require("path");

const generatePO = require("./generators/generate_po.js");
const generatePI = require("./generators/generate_pi.js");
const generateInvoice = require("./generators/generate_invoice.js");
const generateChallan = require("./generators/generate_challan.js");

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

const EXTRACTION_PROMPT = `You are an expert quantity surveyor and estimator for Studio5 Interiors (an interior design and architectural contracting company in India).
The attached image is a handwritten site measurement sheet, diary note, BOQ list, or contractor quotation.
Extract all line items, their quantities, units of measurement (UOM), and rates (if written).

Rules:
1. Identify any section/room/area headers (e.g. "Drawing Room", "Master Bedroom", "Living Area", "Kitchen", "Toilet", "General"). If no room/section is mentioned, use "Main Works".
2. For each item, extract:
   - particulars: Clean, professional interior description (e.g. "Gypsum false ceiling with cove", "Modular wardrobe in laminate finish", "Flush door 32mm with teak frame").
   - uom: Standard unit in lowercase: "sqft", "rft", "nos", "set", "lumpsum", "sqm", "mtr", "kg".
   - qty: Numeric quantity (number only). If area calculation is written like "10x12", calculate the value (120) or extract the total number. If missing or unclear, use 1.
   - rate: Unit price/rate if mentioned (number only, no commas or currency symbols). If not mentioned, return null.
   - rooms: Number of rooms if specified, otherwise null.
3. Respond ONLY in valid JSON matching this schema:
{
  "sections": [
    {
      "section_name": "Living Room",
      "items": [
        {
          "particulars": "Gypsum false ceiling with cove",
          "uom": "sqft",
          "qty": 350,
          "rate": 125,
          "rooms": null
        }
      ]
    }
  ]
}`;

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
    const { image, mimeType } = req.body;
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

    const callGemini = async (modelName) => {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inlineData: { mimeType: actualMime, data: cleanBase64 } },
                { text: EXTRACTION_PROMPT }
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

function sendDocx(res, buffer, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

app.post("/generate/purchase-order", async (req, res) => {
  try {
    const buf = await generatePO(req.body, logoBuffer, stampBuffer);
    sendDocx(res, buf, "Purchase_Order.docx");
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/generate/proforma-invoice", async (req, res) => {
  try {
    const buf = await generatePI(req.body, logoBuffer, stampBuffer);
    sendDocx(res, buf, "Proforma_Invoice.docx");
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/generate/invoice", async (req, res) => {
  try {
    const buf = await generateInvoice(req.body, logoBuffer, stampBuffer);
    sendDocx(res, buf, "Invoice.docx");
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/generate/challan", async (req, res) => {
  try {
    const buf = await generateChallan(req.body, logoBuffer, stampBuffer);
    sendDocx(res, buf, "Delivery_Challan.docx");
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio5 doc generator API running on port ${PORT}`));