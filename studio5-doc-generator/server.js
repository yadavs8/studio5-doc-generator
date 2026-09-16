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
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname)));

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