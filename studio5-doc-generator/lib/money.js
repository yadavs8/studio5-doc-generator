// Document totals, worked out on the server in whole paise (decision 0003). The browser's figures are
// only checked against these; the document always prints the server's.
const { gstinState, stateName } = require("./company.js");

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const fromPaise = (p) => p / 100;

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : ""));
const three = (n) => (n < 100 ? two(n) : ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + two(n % 100) : ""));

/** "Rupees One Lakh Eighteen Thousand Only" — whole rupees, Indian grouping. */
function wordsIndian(rupees) {
  let n = Math.round(Math.abs(Number(rupees) || 0));
  if (n === 0) return "Rupees Zero Only";
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push((crore >= 1000 ? wordsIndian(crore).replace(/^Rupees |\s*Only$/g, "") : three(crore)) + " Crore");
  if (lakh) parts.push(two(lakh) + " Lakh");
  if (thousand) parts.push(two(thousand) + " Thousand");
  if (n) parts.push(three(n));
  return `Rupees ${parts.join(" ")} Only`;
}

function itemPaise(it, hasRooms) {
  const qty = Number(it.qty) || 0;
  const rate = Number(it.rate) || 0;
  const rooms = hasRooms ? Number(it.rooms) || 0 : 1;
  return Math.round(qty * rate * rooms * 100);
}

/**
 * Recomputes every figure of a PO / PI / tax invoice from its line items.
 * Rows with blank particulars are dropped (the browser drops them too).
 * Invoices and PIs round the grand total to the rupee with a round-off; POs are not rounded.
 */
function computeTotals(docType, payload) {
  const sections = (payload.sections || []).map((sec) => {
    const items = (sec.items || [])
      .filter((it) => String(it.particulars || "").trim() !== "")
      .map((it) => ({ ...it, amountPaise: itemPaise(it, !!sec.has_rooms) }));
    const subtotalPaise = items.reduce((s, it) => s + it.amountPaise, 0);
    return { sec, items, subtotalPaise };
  });
  const basePaise = sections.reduce((s, x) => s + x.subtotalPaise, 0);
  const gstPct = Number(payload.gst_pct) || 0;
  const gstPaise = Math.round((basePaise * gstPct) / 100);

  // Place of supply and the CGST/SGST vs IGST split (tax invoices; decision 0002).
  const issuerState = gstinState(payload.issuing_address && payload.issuing_address.gstin);
  const formState = /^\d{2}$/.test(String(payload.place_of_supply || "").trim()) ? String(payload.place_of_supply).trim() : null;
  const posCode = formState || gstinState(payload.buyer && payload.buyer.gstin) || issuerState;
  const intraState = !!posCode && posCode === issuerState;
  const cgst = docType === "invoice" && intraState ? Math.floor(gstPaise / 2) : 0;
  const sgst = docType === "invoice" && intraState ? gstPaise - cgst : 0;
  const igst = docType === "invoice" && !intraState ? gstPaise : 0;

  const exact = basePaise + gstPaise;
  const rounds = docType === "invoice" || docType === "pi";
  const grand = rounds ? Math.round(exact / 100) * 100 : exact;

  const out = {
    sections: sections.map(({ sec, items, subtotalPaise }) => ({
      ...sec,
      items: items.map(({ amountPaise, ...it }) => ({ ...it, amount: fromPaise(amountPaise) })),
      subtotal: fromPaise(subtotalPaise),
    })),
    gst_pct: gstPct,
    gst_amt: fromPaise(gstPaise),
    cgst_amt: fromPaise(cgst),
    sgst_amt: fromPaise(sgst),
    igst_amt: fromPaise(igst),
    place_of_supply_code: posCode,
    place_of_supply_name: posCode ? stateName(posCode) : null,
    round_off: fromPaise(grand - exact),
    grand_total: fromPaise(grand),
    amount_in_words: wordsIndian(fromPaise(grand)),
  };
  if (docType === "po") out.sub_total = fromPaise(basePaise);
  else out.project_total = fromPaise(basePaise);
  return out;
}

module.exports = { toPaise, fromPaise, wordsIndian, computeTotals };
