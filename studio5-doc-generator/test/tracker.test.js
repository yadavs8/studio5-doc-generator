// The link to the PO tracker (lib/tracker.js, decision 0005): PIs and tax invoices made here appear there.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app.js");
const { createLocalLedger } = require("../lib/localLedger.js");
const { linkParams } = require("../lib/tracker.js");
const { validateAndPrice } = require("../lib/validate.js");
const { fakeSupabase } = require("./fakeSupabase.js");

const SITE = "51111111-0000-0000-0000-000000000001";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const issuer = { name: "STUDIO5 INTERIORS PRIVATE LIMITED", line1: "a", line2: "b", gstin: "06ABICS6962P1ZG" };
const bank = { name: "HDFC BANK LIMITED", account: "50200120135932" };
const pi = (over = {}) => ({
  pi_date: "2026-10-02", issuing_address_key: "gurgaon_sec17c", issuing_address: issuer, bank,
  buyer: { name: "Test Hotels Pvt Ltd", gstin: "06AAACL1234A1Z5" }, subject: "Lobby fit-out", gst_pct: 18,
  sections: [{ name: "Lobby", items: [{ particulars: "Ceiling", qty: 10, rate: 1000 }] }], tracker_site_id: SITE, ...over,
});
const inv = (over = {}) => ({
  invoice_date: "2026-10-20", issuing_address_key: "gurgaon_sec17c", issuing_address: issuer, bank,
  buyer: { name: "Test Hotels Pvt Ltd", gstin: "06AAACL1234A1Z5" }, gst_pct: 18,
  sections: [{ name: "Lobby", items: [{ particulars: "Ceiling", qty: 1, rate: 1000.4 }] }], tracker_site_id: SITE, ...over,
});

async function start() {
  const sb = fakeSupabase();
  sb.db.site.push({ site_id: SITE, site_name: "Test Hotels - Pune", site_address: "Pune", status: "active",
    client: { display_name: "Test Hotels", legal_name: "Test Hotels Pvt Ltd", gstin: "27AAACT1234A1Z5", billing_address: "Pune", state: "Maharashtra" } });
  const local = createLocalLedger(path.join(tmp("s5ledger-"), "ledger.json"));
  const app = createApp({ supabase: sb, local, env: { STUDIO5_DOCS_DIR: tmp("s5docs-") } });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, q = "") => fetch(base + p + q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { sb, local, app, base, post, stop: () => new Promise((r) => server.close(r)) };
}

test("the tracker gets the server's figures: PI amount; invoice taxable, GST split, round off, total", () => {
  const p = validateAndPrice("invoice", inv());
  const params = linkParams("invoice", "S51/26-27/007", SITE, p, null);
  assert.equal(params.source_ref, "docgen:invoice:S51/26-27/007");
  assert.equal(params.taxable, 1000.4);
  assert.equal(params.gst, 180.07);
  assert.equal(params.gst_type, "cgst_sgst");
  assert.equal(params.round_off, -0.47);
  assert.equal(params.gross, 1180);
  assert.ok(Math.abs(params.taxable + params.gst + params.round_off - params.gross) < 0.005, "parts add up (tracker check)");
  const inter = linkParams("invoice", "S51/26-27/008", SITE, validateAndPrice("invoice", inv({ buyer: { name: "X", gstin: "27AAACT1234A1Z5" } })), null);
  assert.equal(inter.gst_type, "igst");
  const pp = linkParams("pi", "26-27/41", SITE, validateAndPrice("pi", pi()), null);
  assert.deepEqual([pp.kind, pp.amount, pp.subject, pp.date], ["pi", 11800, "Lobby fit-out", "2026-10-02"]);
});

test("online: a PI with a site picked is recorded in the tracker with its Word file", async () => {
  const t = await start();
  try {
    const r = await t.post("/generate/proforma-invoice", pi());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-tracker"), "linked");
    assert.equal(t.sb.db.tracker.length, 1);
    const rec = t.sb.db.tracker[0];
    assert.deepEqual([rec.kind, rec.site_id, rec.number, rec.amount], ["pi", SITE, r.headers.get("x-document-number"), 11800]);
    assert.match(rec.file_url, /^pi\/[0-9a-f-]{36}_PI_.*\.docx$/);
    assert.ok(t.sb.db.files[rec.file_url], "file uploaded to the tracker's storage");
  } finally { await t.stop(); }
});

test("no site picked: nothing is sent to the tracker (POs, challans and unlinked PIs stay here)", async () => {
  const t = await start();
  try {
    const r = await t.post("/generate/proforma-invoice", pi({ tracker_site_id: undefined }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-tracker"), null);
    assert.equal(t.sb.db.tracker.length, 0);
    assert.equal(Object.keys(t.sb.db.files).length, 0);
  } finally { await t.stop(); }
});

test("a bad site id is refused before a number is used", async () => {
  const t = await start();
  try {
    const r = await t.post("/generate/proforma-invoice", pi({ tracker_site_id: "x' or 1=1" }));
    assert.equal(r.status, 400);
    assert.equal(t.sb.db.generated_documents.length, 0);
  } finally { await t.stop(); }
});

test("the tracker refusing (e.g. number typed in by hand there) never fails the document; the reason is shown", async () => {
  const t = await start();
  try {
    t.sb.state.trackerRefuse = "PI 26-27/1 is already in the PO tracker for this site (entered by hand).";
    const r = await t.post("/generate/proforma-invoice", pi());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-tracker"), "failed");
    assert.match(decodeURIComponent(r.headers.get("x-tracker-message")), /already in the PO tracker/);
    assert.equal(Object.keys(t.sb.db.files).length, 0, "no orphan file in the tracker's storage");
  } finally { await t.stop(); }
});

test("PDF flow: the record is made at numbering, the PDF is filed when it is saved", async () => {
  const t = await start();
  try {
    const r = await t.post("/generate/invoice", inv(), "?format=json");
    const body = await r.json();
    assert.equal(body.tracker.status, "linked");
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from("%PDF-1.4 test")], { type: "application/pdf" }), "Invoice.pdf");
    fd.append("docType", "inv");
    fd.append("docDate", "2026-10-20");
    fd.append("docNumber", body.docNumber);
    fd.append("filename", "Invoice.pdf");
    const saved = await (await fetch(t.base + "/api/save-generated-doc", { method: "POST", body: fd })).json();
    assert.equal(saved.tracker.status, "linked");
    assert.match(t.sb.db.tracker[0].file_url, /^invoice\/.*_Invoice\.pdf$/);
    // a PDF of an unlinked document is not sent anywhere
    const fd2 = new FormData();
    fd2.append("file", new Blob([Buffer.from("%PDF")]), "Other.pdf");
    fd2.append("docType", "pi"); fd2.append("docNumber", "26-27/999"); fd2.append("filename", "Other.pdf");
    const other = await (await fetch(t.base + "/api/save-generated-doc", { method: "POST", body: fd2 })).json();
    assert.equal(other.tracker, null);
  } finally { await t.stop(); }
});

test("offline: the tracker work waits behind the number and is done once online", async () => {
  const t = await start();
  try {
    t.sb.state.offline = true;
    const r = await t.post("/generate/proforma-invoice", pi());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-offline"), "1");
    assert.equal(r.headers.get("x-tracker"), "queued");
    assert.deepEqual(t.local.queue().map((q) => q.op), ["insert", "tracker.link", "tracker.attach"]);
    // the tracker part alone cannot jump ahead of the number
    t.sb.state.offline = false;
    assert.deepEqual(await t.app.locals.tracker.sync(), { tracker_done: 0, tracker_set_aside: 0 });
    // the normal order: numbers, then the tracker
    const s = await (await t.post("/api/sync", {})).json();
    assert.equal(s.uploaded, 1);
    assert.equal(s.tracker_done, 2);
    assert.equal(t.local.pendingCount(), 0);
    assert.equal(t.sb.db.tracker.length, 1);
    assert.ok(t.sb.db.tracker[0].file_url, "file attached after the record");
    // running it again changes nothing
    await t.post("/api/sync", {});
    assert.equal(t.sb.db.tracker.length, 1);
  } finally { await t.stop(); }
});

test("offline: a number that clashed elsewhere is never added to the tracker", async () => {
  const t = await start();
  try {
    t.sb.state.offline = true;
    const r = await t.post("/generate/proforma-invoice", pi());
    const num = r.headers.get("x-document-number");
    t.sb.state.offline = false;
    t.sb.db.generated_documents.push({ doc_type: "pi", doc_number: num, payload: {} }); // used by another PC meanwhile
    const s = await (await t.post("/api/sync", {})).json();
    assert.equal(s.conflicts.filter((c) => !c.source).length, 1, "the number clash");
    assert.equal(s.tracker_set_aside, 2);
    assert.ok(s.conflicts.some((c) => c.source === "tracker" && /not added to the PO tracker/.test(c.message)), "explained to the person");
    assert.equal(t.sb.db.tracker.length, 0);
    assert.equal(t.local.pendingCount(), 0, "nothing left to block the queue");
  } finally { await t.stop(); }
});

test("void here cancels it in the tracker; a refusal there is explained, the void here stands", async () => {
  const t = await start();
  try {
    const a = (await t.post("/generate/proforma-invoice", pi())).headers.get("x-document-number");
    const v = await (await t.post("/void-document", { doc_type: "pi", doc_number: a, reason: "client dropped it" })).json();
    assert.equal(v.tracker.status, "cancelled");
    assert.equal(t.sb.db.tracker[0].status, "cancelled");

    const b = (await t.post("/generate/proforma-invoice", pi())).headers.get("x-document-number");
    t.sb.db.tracker[1].converted = true;
    const res = await t.post("/void-document", { doc_type: "pi", doc_number: b, reason: "typo" });
    assert.equal(res.status, 200);
    const w = await res.json();
    assert.equal(w.status, "void");
    assert.equal(w.tracker.status, "failed");
    assert.match(w.tracker.message, /already become a tax invoice/);

    // offline void: queued and done later
    const c = (await t.post("/generate/proforma-invoice", pi())).headers.get("x-document-number");
    t.sb.state.offline = true;
    const q = await (await t.post("/void-document", { doc_type: "pi", doc_number: c, reason: "later" })).json();
    assert.equal(q.tracker.status, "queued");
    t.sb.state.offline = false;
    await t.post("/api/sync", {});
    assert.equal(t.sb.db.tracker[2].status, "cancelled");
  } finally { await t.stop(); }
});

test("site picker: the tracker's sites, remembered for use without the internet", async () => {
  const t = await start();
  try {
    const on = await (await fetch(t.base + "/api/tracker/sites")).json();
    assert.equal(on.offline, false);
    assert.deepEqual(on.sites.map((s) => [s.site_id, s.site_name, s.client.name, s.client.gstin]), [[SITE, "Test Hotels - Pune", "Test Hotels Pvt Ltd", "27AAACT1234A1Z5"]]);
    t.sb.state.offline = true;
    const off = await (await fetch(t.base + "/api/tracker/sites")).json();
    assert.equal(off.offline, true);
    assert.equal(off.sites.length, 1);
    assert.deepEqual(await (await fetch(t.base + "/api/tracker/open-pis?site=" + SITE)).json(), []);
  } finally { await t.stop(); }
});

test("a passing server problem (5xx) is retried later, not treated as a refusal", async () => {
  const t = await start();
  try {
    t.sb.state.trackerDown = true;
    const r = await t.post("/generate/proforma-invoice", pi());
    assert.equal(r.headers.get("x-tracker"), "queued");
    await t.post("/api/sync", {});
    assert.equal(t.sb.db.tracker.length, 0, "still down: kept in the queue");
    assert.ok(t.local.queue().some((q) => q.op === "tracker.link"));
    t.sb.state.trackerDown = false;
    await t.post("/api/sync", {});
    assert.equal(t.sb.db.tracker.length, 1);
    assert.equal(t.local.pendingCount(), 0);
  } finally { await t.stop(); }
});

test("a server copy without a PC ledger (or another PC) still files and cancels linked documents", async () => {
  const sb = fakeSupabase();
  sb.db.site.push({ site_id: SITE, site_name: "Pune", status: "active", client: null });
  const app = createApp({ supabase: sb, local: null, env: { STUDIO5_DOCS_DIR: tmp("s5docs-") } });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const r = await post("/generate/proforma-invoice", pi());
    assert.equal(r.headers.get("x-tracker"), "linked");
    assert.ok(sb.db.tracker[0].file_url, "file attached without a ledger");
    const v = await (await post("/void-document", { doc_type: "pi", doc_number: r.headers.get("x-document-number"), reason: "x" })).json();
    assert.equal(v.tracker.status, "cancelled");
    assert.equal(sb.db.tracker[0].status, "cancelled");
    // a document the tracker never had: no tracker note on void
    const u = await post("/generate/proforma-invoice", pi({ tracker_site_id: undefined }));
    const w = await (await post("/void-document", { doc_type: "pi", doc_number: u.headers.get("x-document-number"), reason: "x" })).json();
    assert.equal(w.tracker, undefined);
  } finally { await new Promise((r) => server.close(r)); }
});
