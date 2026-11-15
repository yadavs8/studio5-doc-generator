const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toPaise, wordsIndian, computeTotals } = require("../lib/money.js");

test("paise arithmetic avoids float noise", () => {
  assert.equal(toPaise(0.1) + toPaise(0.2), toPaise(0.3));
  assert.equal(toPaise(450.5), 45050);
});

test("amount in words, Indian system, rupees only", () => {
  assert.equal(wordsIndian(0), "Rupees Zero Only");
  assert.equal(wordsIndian(1001), "Rupees One Thousand One Only");
  assert.equal(wordsIndian(118000), "Rupees One Lakh Eighteen Thousand Only");
  assert.equal(wordsIndian(12345678), "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only");
});

const inv = (over = {}) => ({
  issuing_address: { gstin: "06ABICS6962P1ZG" },
  buyer: { gstin: "06AAACL1234A1Z5" },
  gst_pct: 18,
  sections: [
    { name: "Kitchen", has_rooms: false, items: [{ particulars: "Ceiling", qty: 10, rate: 100.05 }, { particulars: "Floor", qty: 3, rate: 33.33 }] },
    { name: "Rooms", has_rooms: true, items: [{ particulars: "Paint", qty: 2, rate: 50, rooms: 3 }] },
  ],
  ...over,
});

test("line amounts, subtotals and project total are recomputed in paise", () => {
  const t = computeTotals("invoice", inv());
  assert.deepEqual(t.sections.map((s) => s.items.map((i) => i.amount)), [[1000.5, 99.99], [300]]);
  assert.deepEqual(t.sections.map((s) => s.subtotal), [1100.49, 300]);
  assert.equal(t.project_total, 1400.49);
});

test("same-state invoice: CGST + SGST halves, round to rupee with round-off", () => {
  const t = computeTotals("invoice", inv());
  assert.equal(t.gst_amt, 252.09);                 // 18% of 1400.49 = 252.0882 → 252.09
  assert.equal(t.cgst_amt + t.sgst_amt, 252.09);
  assert.equal(t.igst_amt, 0);
  assert.equal(t.place_of_supply_code, "06");
  assert.equal(t.round_off, 0.42);                 // 1652.58 → 1653
  assert.equal(t.grand_total, 1653);
  assert.equal(t.amount_in_words, "Rupees One Thousand Six Hundred Fifty Three Only");
});

test("other-state buyer: IGST", () => {
  const t = computeTotals("invoice", inv({ buyer: { gstin: "07AAACL1234A1Z5" } }));
  assert.equal(t.igst_amt, 252.09);
  assert.equal(t.cgst_amt, 0);
  assert.equal(t.place_of_supply_code, "07");
});

test("place of supply entered on the form wins; unregistered buyer falls back to issuer state", () => {
  assert.equal(computeTotals("invoice", inv({ buyer: { gstin: "" }, place_of_supply: "29" })).place_of_supply_code, "29");
  assert.equal(computeTotals("invoice", inv({ buyer: { gstin: "" } })).place_of_supply_code, "06");
});

test("rounding down gives a negative round-off", () => {
  const t = computeTotals("pi", inv({ gst_pct: 0, sections: [{ name: "", items: [{ particulars: "x", qty: 1, rate: 1000.4 }] }] }));
  assert.equal(t.round_off, -0.4);
  assert.equal(t.grand_total, 1000);
});

test("PO totals are not rounded (vendor document) and blank-particulars rows are ignored", () => {
  const t = computeTotals("po", { gst_pct: 18, sections: [{ name: "A", items: [{ particulars: "Board", qty: 3, rate: 33.33 }, { particulars: "", qty: 5, rate: 999 }] }] });
  assert.equal(t.sub_total, 99.99);
  assert.equal(t.gst_amt, 18);
  assert.equal(t.grand_total, 117.99);
  assert.equal(t.round_off, 0);
});
