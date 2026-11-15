// The number ledger kept on this PC, so documents can be numbered without the internet.
// A small JSON file: last-known counters, recent history, and a queue of changes made while offline
// that are uploaded to Supabase as soon as it can be reached (see documentNumbering.sync()).
// Only for a generator running on one PC — never on Render, whose disk is wiped on restart.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EMPTY = () => ({ version: 1, counters: {}, documents: [], queue: [], conflicts: [], nextId: 1, tracker: { sites: [], sitesAt: null, linked: {} } });
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
      // A unique mark, so an upload can tell "this very document is already there" from "someone else used the number".
      if (queued) doc.payload = { ...(doc.payload || {}), offline_ref: crypto.randomUUID() };
      data.documents.unshift(doc);
      data.documents = data.documents.slice(0, HISTORY_LIMIT);
      if (queued) data.queue.push({ id: data.nextId++, op: "insert", row: doc });
      save();
    },
    /** Mark void here, and queue it for the cloud if needed. */
    void(docType, docNumber, reason, { queued }) {
      const doc = data.documents.find((d) => d.doc_type === docType && d.doc_number === docNumber && d.status === "issued");
      if (doc) Object.assign(doc, { status: "void", void_reason: reason, voided_at: new Date().toISOString() });
      const pendingInsert = data.queue.find((q) => q.op === "insert" && q.row.doc_type === docType && q.row.doc_number === docNumber);
      if (pendingInsert) Object.assign(pendingInsert.row, { status: "void", void_reason: reason, voided_at: new Date().toISOString() });
      else if (queued && doc) data.queue.push({ id: data.nextId++, op: "void", doc_type: docType, doc_number: docNumber, reason, voided_at: new Date().toISOString() });
      save();
      return doc || null;
    },
    list(docType, limit) {
      return data.documents.filter((d) => !docType || d.doc_type === docType).slice(0, limit);
    },
    queue: () => data.queue.slice(),
    /** Remove this queue entry (after it was uploaded, or set aside as a conflict). Removes by id, so a
     *  second upload run can never remove a different, not-yet-uploaded entry. */
    done(item, { conflict } = {}) {
      const i = data.queue.findIndex((q) => q.id === item.id);
      if (i >= 0) data.queue.splice(i, 1);
      if (conflict) data.conflicts.push({ ...conflict, at: new Date().toISOString() });
      save();
    },
    /** Replace an entry (e.g. "insert" becomes "bump" once the row is uploaded but the counter is not). */
    replace(item, next) {
      const i = data.queue.findIndex((q) => q.id === item.id);
      if (i >= 0) { data.queue[i] = { ...next, id: item.id }; save(); }
    },
    /** Add any other queued job (the PO tracker's link / attach / cancel). */
    enqueue(job) {
      data.queue.push({ ...job, id: data.nextId++ });
      save();
    },
    /** The document's number is still waiting to be uploaded (made offline). */
    numberPending(docType, docNumber) {
      return data.queue.some((q) => (q.op === "insert" || q.op === "bump") && q.row.doc_type === docType && q.row.doc_number === docNumber);
    },
    /** The number clashed with one used elsewhere (not a tracker problem). */
    numberConflict(docType, docNumber) {
      return data.conflicts.some((c) => c.source !== "tracker" && c.doc_type === docType && c.doc_number === docNumber);
    },
    /** Tracker work for this document must wait: its number or its tracker record is still queued. */
    trackerWaiting(docType, docNumber) {
      return this.numberPending(docType, docNumber)
        || data.queue.some((q) => q.op === "tracker.link" && q.doc_type === docType && q.doc_number === docNumber);
    },
    // The tracker's site list (for the picker when offline) and which documents are linked to it.
    trackerSites: () => data.tracker.sites.slice(),
    setTrackerSites(list) { data.tracker.sites = list; data.tracker.sitesAt = new Date().toISOString(); save(); },
    trackerRemember(ref, siteId) { data.tracker.linked[ref] = siteId; save(); },
    trackerForget(ref) { delete data.tracker.linked[ref]; save(); },
    trackerKnows: (ref) => Object.prototype.hasOwnProperty.call(data.tracker.linked, ref),
    pendingCount: () => data.queue.length,
    status: () => ({ pending: data.queue.length, conflicts: data.conflicts.slice(-20) }),
  };
}

module.exports = { createLocalLedger };
