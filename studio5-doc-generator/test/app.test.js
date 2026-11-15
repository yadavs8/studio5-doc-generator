const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app.js");
const { fakeSupabase } = require("./fakeSupabase.js");

const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "s5docs-"));
let server, base, sb;
async function start(env = {}) {
  sb = fakeSupabase();
  const app = createApp({ supabase: sb, env: { STUDIO5_DOCS_DIR: docsDir, ...env } });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
}
const stop = () => new Promise((r) => server.close(r));

const invoice = (over = {}) => ({
  invoice_date: "2026-09-01",
  issuing_address_key: "gurgaon_sec17c",
  issuing_address: { name: "STUDIO5 INTERIORS PRIVATE LIMITED", line1: "a", line2: "b", gstin: "06ABICS6962P1ZG", msme: "m", email: "e", mobile: "1" },
  buyer: { name: "Lemon Tree Hotels", address: "Gurgaon", gstin: "06AAACL1234A1Z5" },
  gst_pct: 18,
  sections: [{ name: "Kitchen", has_rooms: false, items: [{ particulars: "Ceiling", uom: "sqft", qty: 10, rate: 100 }] }],
  grand_total: 1180,
  bank: { name: "HDFC BANK LIMITED", account: "50200120135932", ifsc: "HDFC0003676", branch: "x" },
  ...over,
});
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

before(() => start());
after(() => stop());

test("health answers", async () => {
  assert.equal((await fetch(base + "/health")).status, 200);
});

test("only the page and its assets are served — not generated documents or source", async () => {
  fs.mkdirSync(path.join(__dirname, "..", "generated_docs"), { recursive: true });
  for (const p of ["/server.js", "/app.js", "/lib/supabase.js", "/package.json", "/supabase/migration_001_document_ledger.sql", "/generated_docs/"]) {
    assert.notEqual((await fetch(base + p)).status, 200, `${p} must not be served`);
  }
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/assets/logo.png")).status, 200);
});

test("other websites cannot call the API (no CORS *, cross-origin writes refused)", async () => {
  const r = await post("/void-document", { doc_type: "po", doc_number: "PO/1" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const r2 = await fetch(base + "/documents", { headers: { origin: "https://evil.example" } });
  assert.equal(r2.headers.get("access-control-allow-origin"), null);
});

test("a tax invoice is generated with the server's totals and a GST-year number", async () => {
  const r = await post("/generate/invoice", invoice());
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get("x-document-number"), "S51/26-27/001");
  const row = sb.db.generated_documents.at(-1);
  assert.equal(row.total_amount, 1180);
  assert.equal(row.payload.cgst_amt, 90);
  assert.equal(row.payload.sgst_amt, 90);
  assert.equal(row.payload.amount_in_words, "Rupees One Thousand One Hundred Eighty Only");
});

test("tampered or stale totals are refused", async () => {
  const r = await post("/generate/invoice", invoice({ grand_total: 99 }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /totals/i);
});

test("someone else's GSTIN or bank account cannot be put on a Studio5 document", async () => {
  const a = await post("/generate/invoice", invoice({ issuing_address: { ...invoice().issuing_address, gstin: "29AAAAA0000A1Z5" } }));
  assert.equal(a.status, 400);
  const b = await post("/generate/invoice", invoice({ bank: { name: "X", account: "123456789", ifsc: "X", branch: "x" } }));
  assert.equal(b.status, 400);
});

test("a malformed or script-carrying document number is refused before anything is recorded", async () => {
  const before = sb.db.generated_documents.length;
  const r = await post("/generate/purchase-order?format=json", { po_no: "x');alert(1);('", po_date: "2026-09-01", issuing_address: invoice().issuing_address, vendor: { name: "V", address: "a" }, gst_pct: 0, sections: [{ name: "", items: [{ particulars: "a", qty: 1, rate: 1 }] }], grand_total: 1 });
  assert.equal(r.status, 400);
  assert.equal(sb.db.generated_documents.length, before);
});

test("save-generated-doc cannot write outside the documents folder", async () => {
  const fd = new FormData();
  fd.append("docType", "pi");
  fd.append("docDate", "2026-09-01");
  fd.append("filename", "../../../../evil.js");
  fd.append("file", new Blob(["x"]), "a.pdf");
  const r = await fetch(base + "/api/save-generated-doc", { method: "POST", body: fd });
  assert.equal(r.status, 400);
  assert.equal(fs.existsSync(path.join(docsDir, "..", "evil.js")), false);
  const fd2 = new FormData();
  fd2.append("docType", "pi"); fd2.append("docDate", "2026-09-01"); fd2.append("filename", "PI_ok.pdf"); fd2.append("file", new Blob(["%PDF"]), "a.pdf");
  const ok = await fetch(base + "/api/save-generated-doc", { method: "POST", body: fd2 });
  assert.equal(ok.status, 200);
  assert.equal(fs.existsSync(path.join(docsDir, "proforma_invoices", "2026-09-01", "PI_ok.pdf")), true);
  const list = await (await fetch(base + "/api/generated-docs?docType=pi")).json();
  assert.equal(JSON.stringify(list).includes(docsDir), false, "absolute server paths must not be returned");
});

test("without Supabase the server refuses to number documents (no silent PO/1 duplicates)", async () => {
  await stop();
  const app = createApp({ supabase: null, env: { STUDIO5_DOCS_DIR: docsDir } });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await post("/generate/invoice", invoice());
  assert.equal(r.status, 503);
});

test("optional access code: off by default, required when ACCESS_CODE is set", async () => {
  await stop();
  await start({ ACCESS_CODE: "s3cret-code" });
  assert.equal((await fetch(base + "/documents")).status, 401);
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/documents", { headers: { "x-access-code": "s3cret-code" } })).status, 200);
  const unlock = await post("/api/unlock", { code: "s3cret-code" });
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(base + "/documents", { headers: { cookie } })).status, 200);
  assert.equal((await post("/api/unlock", { code: "wrong" })).status, 401);
});

test("DNS rebinding: requests for an unexpected host name are refused", async () => {
  // fetch() will not send a custom Host header, so use a raw request.
  const http = require("node:http");
  const status = (host) => new Promise((resolve, reject) => {
    const u = new URL(base + "/documents");
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(await status("evil.example:3000"), 421);
  assert.notEqual(await status(`localhost:${new URL(base).port}`), 421);
});

test("a mistyped buyer GSTIN or unknown state code is refused, not silently treated as same-state", async () => {
  await stop();
  await start();
  assert.equal((await post("/generate/invoice", invoice({ buyer: { name: "B", address: "a", gstin: "07AAACL12" } }))).status, 400);
  assert.equal((await post("/generate/invoice", invoice({ place_of_supply: "99" }))).status, 400);
});

test("same-origin works behind a proxy that changes the scheme (host compared, not http vs https)", async () => {
  const r = await post("/void-document", { doc_type: "po", doc_number: "PO/77" }, { origin: base.replace("http://", "https://") });
  assert.notEqual(r.status, 403);
});

test("locked mode hides the page assets (the stamp) and limits wrong codes", async () => {
  await stop();
  await start({ ACCESS_CODE: "s3cret-code" });
  assert.equal((await fetch(base + "/assets/stamp.png")).status, 401);
  assert.match(await (await fetch(base + "/")).text(), /Access code/);
  for (let i = 0; i < 5; i++) await post("/api/unlock", { code: "nope" });
  assert.equal((await post("/api/unlock", { code: "s3cret-code" })).status, 429);
  await stop();
  await start();
});

test("bad JSON gets a plain message, never a stack trace", async () => {
  const r = await fetch(base + "/void-document", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(r.status, 400);
  const t = await r.text();
  assert.doesNotMatch(t, /at |node_modules|\/home\//);
});
