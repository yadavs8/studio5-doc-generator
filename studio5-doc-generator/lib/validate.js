// Checks a document request before anything is numbered or recorded, and replaces every figure with
// the server's own (lib/money.js). Throws { code: "INVALID_PAYLOAD" } with a plain message.
const { computeTotals } = require("./money.js");
const { isStudio5Gstin, findBank, gstinState, stateName } = require("./company.js");

const bad = (message) => Object.assign(new Error(message), { code: "INVALID_PAYLOAD" });
const isRealDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return false;
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
};
const text = (v, max = 2000) => typeof v === "string" && v.length <= max;

const DATE_FIELD = { po: "po_date", pi: "pi_date", invoice: "invoice_date", challan: "challan_date" };
const LABEL = { po: "purchase order", pi: "proforma invoice", invoice: "tax invoice", challan: "delivery challan" };

/**
 * Returns the cleaned payload: server totals, Studio5's own bank record. Refuses (400) when
 *  - a required field is missing or absurdly long, or the date is not a real date;
 *  - the issuer GSTIN is not one of Studio5's, or the bank account is not one of Studio5's;
 *  - the totals the browser showed differ from the server's by more than ₹1 (stale page or tampering).
 */
function validateAndPrice(docType, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("The request is empty.");
  const p = { ...input };
  const date = p[DATE_FIELD[docType]];
  if (date && !isRealDate(date)) throw bad(`The ${LABEL[docType]} date "${date}" is not a real date.`);

  const addr = p.issuing_address;
  if (!addr || typeof addr !== "object") throw bad("Choose the issuing address.");
  if (!isStudio5Gstin(addr.gstin)) throw bad("The issuing address must carry one of Studio5's own GSTINs (06ABICS6962P1ZG or 07ABICS6962P1ZE).");
  for (const k of ["name", "line1", "line2"]) if (addr[k] != null && !text(addr[k], 300)) throw bad("The issuing address is too long.");

  if (docType === "challan") {
    if (!Array.isArray(p.items) || p.items.length === 0) throw bad("Add at least one item to the challan.");
    if (p.items.length > 500) throw bad("Too many items.");
    return p;
  }

  if (!Array.isArray(p.sections) || p.sections.length === 0) throw bad(`Add at least one section with items to the ${LABEL[docType]}.`);
  if (p.sections.length > 100 || p.sections.some((s) => !s || typeof s !== "object" || !Array.isArray(s.items) || s.items.length > 500 || s.items.some((it) => !it || typeof it !== "object"))) throw bad("The sections or items are not in the expected form, or there are too many.");
  for (const s of p.sections) for (const it of s.items) {
    if (it.particulars != null && !text(it.particulars, 2000)) throw bad("An item description is too long.");
    for (const k of ["qty", "rate", "rooms"]) {
      if (it[k] != null && it[k] !== "" && !Number.isFinite(Number(it[k]))) throw bad(`An item has a ${k} that is not a number.`);
      if (Number(it[k]) < 0) throw bad(`An item has a negative ${k}.`);
    }
  }
  const gstPct = Number(p.gst_pct || 0);
  if (!Number.isFinite(gstPct) || gstPct < 0 || gstPct > 28) throw bad("GST % must be between 0 and 28.");

  // A typed GSTIN must be a real one, and a typed place of supply a real state code — a typo must not
  // silently turn an inter-state sale into CGST + SGST.
  const partyGstin = String(((docType === "po" ? p.vendor : p.buyer) || {}).gstin || "").trim();
  if (partyGstin && !gstinState(partyGstin)) throw bad(`"${partyGstin.slice(0, 20)}" is not a valid GSTIN (15 characters, starting with a state code).`);
  const pos = String(p.place_of_supply || "").trim();
  if (pos && !stateName(pos)) throw bad(`"${pos.slice(0, 5)}" is not a GST state code (e.g. 06 Haryana, 07 Delhi).`);

  const party = docType === "po" ? p.vendor : p.buyer;
  if (!party || !text(party.name, 300) || !party.name.trim()) throw bad(docType === "po" ? "Fill in the vendor's name." : "Fill in the buyer's name.");

  if (docType === "pi" || docType === "invoice") {
    const bank = findBank(p.bank);
    if (!bank) throw bad("Choose one of Studio5's bank accounts (HDFC or IDFC).");
    p.bank = { name: bank.name, account: bank.account, ifsc: bank.ifsc, branch: bank.branch };
  }

  const t = computeTotals(docType, p);
  if (p.grand_total != null && p.grand_total !== "" && Math.abs(Number(p.grand_total) - t.grand_total) > 1) {
    throw bad(`The totals on the page (₹${Number(p.grand_total).toFixed(2)}) do not match the line items (₹${t.grand_total.toFixed(2)}). Please re-check the amounts and try again.`);
  }
  const out = { ...p, ...t };
  if (docType === "po") out.items = t.sections.flatMap((s) => s.items);
  return out;
}

module.exports = { validateAndPrice, isRealDate, DATE_FIELD };
