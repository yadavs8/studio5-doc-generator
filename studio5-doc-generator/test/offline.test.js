const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNumbering } = require("../lib/documentNumbering.js");
const { createLocalLedger } = require("../lib/localLedger.js");
const { fakeSupabase } = require("./fakeSupabase.js");

const ledgerFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s5ledger-")), "ledger.json");

test("offline: numbers continue from the last known counter and are queued", async () => {
  const sb = fakeSupabase();
  const local = createLocalLedger(ledgerFile());
  const n = createNumbering(sb, { local });
  assert.equal((await n.issue("po", { payload: {} })).docNumber, "PO/1");   // online
  sb.state.offline = true;
  const r = await n.issue("po", { payload: {}, build: async (num) => Buffer.from(num) });
  assert.equal(r.docNumber, "PO/2");
  assert.equal(r.offline, true);
  assert.equal(await n.preview("po", {}), "PO/3");
  assert.equal(sb.db.generated_documents.length, 1);
  assert.equal(local.pendingCount(), 1);
  const hist = await n.listDocuments("po", 10);
  assert.deepEqual(hist.map((d) => d.doc_number), ["PO/2", "PO/1"]);
});

test("back online: the queue uploads and the cloud counter moves past it", async () => {
  const sb = fakeSupabase();
  const local = createLocalLedger(ledgerFile());
  const n = createNumbering(sb, { local });
  await n.issue("invoice", { addressKey: "manesar", date: "2026-09-01", payload: {} });  // S51/26-27/001 online
  sb.state.offline = true;
  await n.issue("invoice", { addressKey: "manesar", date: "2026-09-02", payload: {} });  // 002 offline
  await n.voidDocument("invoice", "S51/26-27/001", "client rejected");                // queued void
  sb.state.offline = false;
  const res = await n.sync();
  assert.deepEqual(res, { uploaded: 2, conflicts: 0, pending: 0 });
  assert.deepEqual(sb.db.generated_documents.map((d) => [d.doc_number, d.status]), [["S51/26-27/001", "void"], ["S51/26-27/002", "issued"]]);
  assert.equal((await n.issue("invoice", { addressKey: "manesar", date: "2026-09-03", payload: {} })).docNumber, "S51/26-27/003");
});

test("a number used elsewhere while offline is flagged as a conflict, never duplicated", async () => {
  const sb = fakeSupabase();
  const local = createLocalLedger(ledgerFile());
  const n = createNumbering(sb, { local });
  await n.issue("challan", { payload: {} });            // DC/1
  sb.state.offline = true;
  await n.issue("challan", { payload: {} });            // DC/2 here, offline
  sb.state.offline = false;
  await createNumbering(sb).issue("challan", { payload: {} });   // DC/2 issued from another place (e.g. Render)
  const res = await n.sync();
  assert.equal(res.conflicts, 1);
  assert.equal(sb.db.generated_documents.filter((d) => d.doc_number === "DC/2").length, 1);
  assert.match(local.status().conflicts[0].message, /already used/);
});

test("the ledger survives a restart (it is a file on this PC)", async () => {
  const file = ledgerFile();
  const sb = fakeSupabase();
  sb.state.offline = true;
  await createNumbering(sb, { local: createLocalLedger(file) }).issue("po", { payload: {} });
  const again = createNumbering(sb, { local: createLocalLedger(file) });
  assert.equal(await again.preview("po", {}), "PO/2");
});

test("never online and no Supabase settings: the local ledger numbers documents on its own", async () => {
  const n = createNumbering(null, { local: createLocalLedger(ledgerFile()) });
  assert.equal((await n.issue("pi", { date: "2026-09-01", payload: {} })).docNumber, "26-27/1");
  assert.equal((await n.issue("pi", { date: "2026-09-01", payload: {} })).docNumber, "26-27/2");
});
