const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNumbering, fyFromDate, todayIST, parseTypedNumber } = require("../lib/documentNumbering.js");
const { fakeSupabase } = require("./fakeSupabase.js");

test("financial year comes from the document date (Apr–Mar)", () => {
  assert.equal(fyFromDate("2026-03-31"), "25-26");
  assert.equal(fyFromDate("2026-04-01"), "26-27");
  assert.equal(fyFromDate("1999-12-31"), "99-00");
});

test("today is the Indian date, whatever the server clock", () => {
  const d = new Date("2026-03-31T19:00:00Z"); // 00:30 on 1 April in India
  assert.equal(todayIST(d), "2026-04-01");
});

test("typed numbers are checked against the format and give their own series and year", () => {
  assert.deepEqual(parseTypedNumber("invoice", "S52/24-25/039"), { seq: 39, fy: "24-25", series: "2" });
  assert.deepEqual(parseTypedNumber("po", "PO/14"), { seq: 14 });
  assert.deepEqual(parseTypedNumber("pi", "26-27/1102"), { seq: 1102, fy: "26-27" });
  assert.deepEqual(parseTypedNumber("challan", "DC/46"), { seq: 46 });
  assert.equal(parseTypedNumber("po", "PO/2026x"), null);
  assert.equal(parseTypedNumber("po", "x');alert(1);('"), null);
  assert.equal(parseTypedNumber("po", "PO/99999999999"), null); // too long for the counter
});

test("tax invoice number uses the series of the address and the FY of the invoice date", async () => {
  const n = createNumbering(fakeSupabase());
  const r = await n.issue("invoice", { addressKey: "dwarka_delhi", date: "2026-03-31", payload: {} });
  assert.equal(r.docNumber, "S52/25-26/001");
  const r2 = await n.issue("invoice", { addressKey: "gurgaon_sec17c", date: "2026-04-02", payload: {} });
  assert.equal(r2.docNumber, "S51/26-27/001");
  assert.equal(await n.preview("invoice", { addressKey: "gurgaon_sec17c", date: "2026-04-10" }), "S51/26-27/002");
});

test("a typed number for another year moves that year's counter, not this year's", async () => {
  const sb = fakeSupabase();
  const n = createNumbering(sb);
  await n.issue("invoice", { docNumber: "S51/24-25/039", addressKey: "gurgaon_sec17c", date: "2026-05-01", payload: {} });
  assert.equal(sb.db.doc_number_sequences.find((r) => r.scope_key === "1:24-25").next_seq, 40);
  assert.equal(sb.db.doc_number_sequences.find((r) => r.scope_key === "1:26-27"), undefined);
});

test("duplicates are refused; badly formed typed numbers are refused before anything is recorded", async () => {
  const sb = fakeSupabase();
  const n = createNumbering(sb);
  await n.issue("po", { docNumber: "PO/5", payload: {} });
  await assert.rejects(n.issue("po", { docNumber: "PO/5", payload: {} }), { code: "DUPLICATE_NUMBER" });
  await assert.rejects(n.issue("po", { docNumber: "PO 5 extra", payload: {} }), { code: "INVALID_NUMBER" });
  assert.equal(sb.db.generated_documents.length, 1);
});

test("if the document cannot be built, an auto number is recorded as void with the reason (no silent gap)", async () => {
  const sb = fakeSupabase();
  const n = createNumbering(sb);
  await assert.rejects(n.issue("po", { payload: {}, build: () => { throw new Error("boom"); } }), /boom/);
  const row = sb.db.generated_documents[0];
  assert.equal(row.doc_number, "PO/1");
  assert.equal(row.status, "void");
  assert.match(row.void_reason, /could not be generated/);
  // and a typed number that fails to build is not recorded, so the person can retry with it
  await assert.rejects(n.issue("po", { docNumber: "PO/9", payload: {}, build: () => { throw new Error("boom"); } }));
  assert.equal(sb.db.generated_documents.length, 1);
});

test("without Supabase, numbering refuses instead of giving every document number 1", async () => {
  const n = createNumbering(null);
  await assert.rejects(n.issue("po", { payload: {} }), { code: "NOT_CONFIGURED" });
  await assert.rejects(n.preview("po", {}), { code: "NOT_CONFIGURED" });
});
