// The number ledger kept on this PC, so documents can be numbered without the internet.
// A small JSON file: last-known counters, recent history, and a queue of changes made while offline
// that are uploaded to Supabase as soon as it can be reached (see documentNumbering.sync()).
// Only for a generator running on one PC — never on Render, whose disk is wiped on restart.
const fs = require("fs");
const path = require("path");

const EMPTY = () => ({ version: 1, counters: {}, documents: [], queue: [], conflicts: [] });
const HISTORY_LIMIT = 500;

function createLocalLedger(file) {
  let data = EMPTY();
  try {
    if (fs.existsSync(file)) data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    // Keep a copy of an unreadable file instead of silently starting from zero.
    const bad = `${file}.unreadable-${Date.now()}`;
    try { fs.renameSync(file, bad); } catch { /* nothing to keep */ }
    console.error(`[ledger] ${file} could not be read (${e.message}); kept as ${bad}`);
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file); // atomic replace: a crash never leaves half a ledger
  }
  const key = (docType, scope) => `${docType}|${scope}`;

  return {
    /** The next number this PC knows of for a counter (1 if never seen). */
    next(docType, scope) {
      return data.counters[key(docType, scope)] || 1;
    },
    /** Remember a counter value seen online; never moves backwards. */
    seen(docType, scope, nextSeq) {
      const k = key(docType, scope);
      if ((data.counters[k] || 1) < nextSeq) { data.counters[k] = nextSeq; save(); }
    },
    /** Take the next number offline. */
    take(docType, scope) {
      const k = key(docType, scope);
      const seq = data.counters[k] || 1;
      data.counters[k] = seq + 1;
      save();
      return seq;
    },
    has(docType, docNumber) {
      return data.documents.some((d) => d.doc_type === docType && d.doc_number === docNumber);
    },
    /** Add to the local history; `queued` means it still has to be uploaded. */
    add(row, { queued }) {
      const doc = { ...row, created_at: row.created_at || new Date().toISOString() };
      data.documents.unshift(doc);
      data.documents = data.documents.slice(0, HISTORY_LIMIT);
      if (queued) data.queue.push({ op: "insert", row: doc });
      save();
    },
    /** Mark void here, and queue it for the cloud if needed. */
    void(docType, docNumber, reason, { queued }) {
      const doc = data.documents.find((d) => d.doc_type === docType && d.doc_number === docNumber && d.status === "issued");
      if (doc) Object.assign(doc, { status: "void", void_reason: reason, voided_at: new Date().toISOString() });
      const pendingInsert = data.queue.find((q) => q.op === "insert" && q.row.doc_type === docType && q.row.doc_number === docNumber);
      if (pendingInsert) Object.assign(pendingInsert.row, { status: "void", void_reason: reason, voided_at: new Date().toISOString() });
      else if (queued) data.queue.push({ op: "void", doc_type: docType, doc_number: docNumber, reason, voided_at: new Date().toISOString() });
      save();
      return doc || null;
    },
    list(docType, limit) {
      return data.documents.filter((d) => !docType || d.doc_type === docType).slice(0, limit);
    },
    queue: () => data.queue.slice(),
    /** Remove the first queue entry (after it was uploaded or found to conflict). */
    shift({ conflict } = {}) {
      const item = data.queue.shift();
      if (conflict && item) data.conflicts.push({ ...conflict, at: new Date().toISOString() });
      save();
      return item;
    },
    pendingCount: () => data.queue.length,
    status: () => ({ pending: data.queue.length, conflicts: data.conflicts.slice(-20) }),
  };
}

module.exports = { createLocalLedger };
