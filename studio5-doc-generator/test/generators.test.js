const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateAndPrice } = require("../lib/validate.js");
const gen = {
  po: require("../generators/generate_po.js"), pi: require("../generators/generate_pi.js"),
  invoice: require("../generators/generate_invoice.js"), challan: require("../generators/generate_challan.js"),
};
const logo = fs.readFileSync(path.join(__dirname, "..", "assets", "logo.png"));
const addr = { name: "STUDIO5 INTERIORS PRIVATE LIMITED", line1: "a", line2: "b", gstin: "07ABICS6962P1ZE", msme: "m", email: "e", mobile: "1" };
const bank = { account: "10103784405" };
const sections = [{ name: "Hall", has_rooms: false, items: [{ particulars: "Ceiling", uom: "sqft", qty: 400, rate: 125.5 }] }];

const docxText = async (buf) => {
  // a .docx is a zip; the XML is deflated — look for the text through docx's own unzip dependency
  const JSZip = require("jszip");
  return (await JSZip.loadAsync(buf)).file("word/document.xml").async("string");
};

test("every document type builds a Word file from validated, server-priced data", async () => {
  const po = validateAndPrice("po", { po_date: "2026-09-01", issuing_address: addr, vendor: { name: "Vendor", address: "x" }, gst_pct: 18, sections });
  const pi = validateAndPrice("pi", { pi_date: "2026-09-01", issuing_address: addr, buyer: { name: "Buyer", address: "x" }, gst_pct: 18, sections, bank });
  const inv = validateAndPrice("invoice", { invoice_date: "2026-09-01", issuing_address: addr, buyer: { name: "Buyer", address: "x\ny", gstin: "06AAACL1234A1Z5" }, gst_pct: 18, sections, bank, sac_code: "995411" });
  const ch = validateAndPrice("challan", { challan_date: "2026-09-01", issuing_address: addr, items: [{ particulars: "Board", qty: 2 }], receiver_name: "Site" });
  for (const [t, p] of [["po", po], ["pi", pi], ["invoice", inv], ["challan", ch]]) {
    const buf = await gen[t]({ ...p, [{ po: "po_no", pi: "pi_no", invoice: "invoice_no", challan: "challan_no" }[t]]: "X/1" }, logo, null);
    assert.ok(buf.length > 1000, `${t} built`);
  }
  // Delhi issuer, Haryana buyer → inter-state → IGST, title TAX INVOICE, place of supply and SAC printed
  const xml = await docxText(await gen.invoice({ ...inv, invoice_no: "S52/26-27/001" }, logo, null));
  assert.match(xml, /TAX INVOICE/);
  assert.match(xml, /IGST @ 18%/);
  assert.doesNotMatch(xml, /CGST/);
  assert.match(xml, /Place of Supply: Haryana \(06\)/);
  assert.match(xml, /SAC: 995411/);
  assert.match(xml, /Rupees Fifty Nine Thousand Two Hundred Thirty Six Only/); // 50,200 + 9,036 = 59,236
});
