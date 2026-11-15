// The link to the Studio5 PO tracker (same Supabase project). A PI or tax invoice made here with a
// tracker site picked is recorded there under that site, with its Word/PDF file; voiding it here
// cancels it there. Decision 0005 (here) and the tracker's decision 0011 / migration_017.
//
// Everything goes through three database functions only the service-role key may call. Without the
// internet the work is queued in this PC's ledger and done by sync(), after the document's own number
// has been uploaded (a number that turned out to clash is never added to the tracker).
const crypto = require("crypto");
const { isNetworkError } = require("./documentNumbering.js");

const BUCKET = "studio5-documents";
const KINDS = ["pi", "invoice"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const err = (code, message) => Object.assign(new Error(message), { code });
// Answers the tracker gives on purpose (its rules, a bad value, not found) — final, not worth retrying.
// Anything else (no internet, 5xx, timeouts) is retried later.
const REFUSAL_CODES = new Set(["22023", "23505", "23514", "P0001", "P0002", "42501", "22P02", "22007", "22008"]);
const isRefusal = (e) => !!e && REFUSAL_CODES.has(String(e.code || ""));
const sourceRef = (docType, docNumber) => `docgen:${docType}:${docNumber}`;
const isUuid = (v) => typeof v === "string" && UUID.test(v);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const cleanName = (name) => String(name || "file").replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "_").slice(-120) || "file";

/** What the tracker stores for a PI / tax invoice made here (the server's own figures, lib/money.js). */
function linkParams(docType, docNumber, siteId, p, piId) {
  const date = docType === "pi" ? p.pi_date : p.invoice_date;
  const base = { kind: docType, source_ref: sourceRef(docType, docNumber), site_id: siteId, number: docNumber, date };
  if (docType === "pi") return { ...base, amount: r2(p.grand_total), subject: String(p.subject || "").slice(0, 500) };
  const gst = r2(p.gst_amt);
  return {
    ...base,
    taxable: r2(p.project_total),
    gst,
    gst_type: Number(p.igst_amt || 0) > 0 ? "igst" : Number(p.cgst_amt || 0) + Number(p.sgst_amt || 0) > 0 ? "cgst_sgst" : null,
    gst_rate: Number(p.gst_pct || 0),
    round_off: r2(p.round_off),
    gross: r2(p.grand_total),
    pi_id: piId || null,
  };
}

function createTracker(supabase, { local = null } = {}) {
  const check = ({ data, error }) => { if (error) throw error; return data; };
  const available = () => !!supabase;
  const refused = (e) => err("TRACKER_REFUSED", String((e && e.message) || e).slice(0, 300));
  const rpc = async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw isRefusal(error) ? refused(error) : error;
    return data;
  };
  const TABLE = { pi: "proforma_invoice", invoice: "tax_invoice" };
  /** Is this document recorded in the tracker? (When this PC has no note of it: another PC, a server copy.) */
  async function inTracker(docType, ref) {
    const { data, error } = await supabase.from(TABLE[docType]).select("source_ref").eq("source_ref", ref).maybeSingle();
    return !error && !!data;
  }

  /** The tracker's sites (with their client), newest list remembered on this PC for offline use. */
  async function sites() {
    if (!supabase) return { sites: local ? local.trackerSites() : [], offline: true };
    try {
      const rows = check(await supabase.from("site")
        .select("site_id, site_name, site_address, status, client:client_id(client_id, display_name, legal_name, gstin, billing_address, state)")
        .neq("status", "closed").order("site_name"));
      const list = (rows || []).map((s) => ({
        site_id: s.site_id, site_name: s.site_name, site_address: s.site_address || "", status: s.status,
        client: s.client ? { name: s.client.legal_name || s.client.display_name, display_name: s.client.display_name, gstin: s.client.gstin || "", address: s.client.billing_address || "", state: s.client.state || "" } : null,
      }));
      if (local) local.setTrackerSites(list);
      return { sites: list, offline: false };
    } catch (e) {
      if (!local || !isNetworkError(e)) throw e;
      return { sites: local.trackerSites(), offline: true };
    }
  }

  /** PIs of a site still waiting for a tax invoice (to make the invoice from). Needs the internet. */
  async function openPis(siteId) {
    if (!isUuid(siteId)) throw err("INVALID_PAYLOAD", "Pick a site from the PO tracker first.");
    if (!supabase) return [];
    return check(await supabase.from("proforma_invoice").select("pi_id, pi_number, pi_date, amount, subject, status")
      .eq("site_id", siteId).in("status", ["draft", "sent", "revision_requested", "approved"]).order("pi_date", { ascending: false }));
  }

  // ── The three operations, online ────────────────────────────────────────
  const linkNow = (params) => rpc("link_generated_document", { p: params });
  async function attachNow({ ref, path, filename, buffer }) {
    const ext = (filename.match(/\.[a-z]+$/i) || [""])[0].toLowerCase();
    const up = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: MIME[ext] || "application/octet-stream", upsert: false });
    if (up.error) {
      const status = String(up.error.statusCode || up.error.status || "");
      const duplicate = status === "409" || up.error.error === "Duplicate"; // uploaded before; only the answer was lost
      if (!duplicate) throw /^4\d\d$/.test(status) ? refused(up.error) : up.error;
    }
    await rpc("attach_generated_file", { p_source_ref: ref, p_file_url: path, p_file_name: filename });
  }
  const cancelNow = (ref, reason) => rpc("cancel_generated_document", { p_source_ref: ref, p_reason: reason || null });

  /**
   * After a PI / invoice is numbered. Never throws for tracker problems — the document is already made:
   * returns { status: "linked" | "queued" | "failed", message? }.
   * `docQueued`: the number itself is still waiting to be uploaded (made offline) → queue behind it.
   */
  async function record({ docType, docNumber, siteId, payload, piId = null, docQueued = false }) {
    if (!KINDS.includes(docType) || !siteId) return null;
    if (!isUuid(siteId)) return { status: "failed", message: "The tracker site was not recognised; pick it again." };
    if (piId && !isUuid(piId)) piId = null;
    if (!supabase) return { status: "failed", message: "The PO tracker is not connected on this server (Supabase is not set up)." };
    const params = linkParams(docType, docNumber, siteId, payload, piId);
    if (local) local.trackerRemember(params.source_ref, siteId);
    const queue = () => { local.enqueue({ op: "tracker.link", doc_type: docType, doc_number: docNumber, params }); return { status: "queued" }; };
    if (docQueued && local) return queue();
    try {
      await linkNow(params);
      return { status: "linked" };
    } catch (e) {
      if (e.code !== "TRACKER_REFUSED" && local) return queue();
      if (local) local.trackerForget(params.source_ref);
      return { status: "failed", message: e.code === "TRACKER_REFUSED" ? e.message : "The PO tracker could not be reached." };
    }
  }

  /** Files a saved Word/PDF against the tracker record, if this document is linked. Same promise as record(). */
  async function attach({ docType, docNumber, buffer, filename, filePath = null }) {
    const ref = sourceRef(docType, docNumber);
    if (!KINDS.includes(docType) || !supabase) return null;
    // Only documents in the tracker get a file there (no stray uploads for unlinked ones).
    if (!(local && local.trackerKnows(ref)) && !(await inTracker(docType, ref))) return null;
    const job = { ref, path: `${docType}/${crypto.randomUUID()}_${cleanName(filename)}`, filename: cleanName(filename) };
    const queue = () => {
      if (!filePath || !local) return { status: "failed", message: "The file could not be sent to the PO tracker; attach it there by hand." };
      local.enqueue({ op: "tracker.attach", doc_type: docType, doc_number: docNumber, ...job, file_path: filePath });
      return { status: "queued" };
    };
    if (local && local.trackerWaiting(docType, docNumber)) return queue();
    try {
      await attachNow({ ...job, buffer });
      return { status: "linked" };
    } catch (e) {
      if (e.code !== "TRACKER_REFUSED") return queue();
      return { status: "failed", message: e.code === "TRACKER_REFUSED" ? e.message : "The file could not be sent to the PO tracker." };
    }
  }

  /** After a void here. Returns null (not linked), or { status, message? }; a refusal is explained, not thrown. */
  async function cancel(docType, docNumber, reason) {
    const ref = sourceRef(docType, docNumber);
    if (!KINDS.includes(docType) || !supabase) return null;
    // Asked even when this PC has no note of the link (voided from another PC, ledger lost): the tracker
    // answers "not in tracker" for documents it never had.
    const queue = () => {
      if (!local) return { status: "failed", message: "The PO tracker could not be reached; cancel it there by hand." };
      local.enqueue({ op: "tracker.cancel", doc_type: docType, doc_number: docNumber, ref, reason: reason || null });
      return { status: "queued" };
    };
    if (local && local.trackerWaiting(docType, docNumber)) return queue();
    try {
      const result = await cancelNow(ref, reason);
      return result === "not in tracker" ? null : { status: "cancelled" };
    } catch (e) {
      if (e.code !== "TRACKER_REFUSED") return queue();
      return { status: "failed", message: e.code === "TRACKER_REFUSED" ? e.message : "The PO tracker could not be reached." };
    }
  }

  /** Does the queued tracker work. One run at a time; stops quietly while offline. Call after numbering.sync(). */
  let running = null;
  function sync() {
    if (!running) running = syncOnce().finally(() => { running = null; });
    return running;
  }
  async function syncOnce() {
    if (!local || !supabase) return { tracker_done: 0, tracker_set_aside: 0 };
    let done = 0, aside = 0;
    const setAside = (item, message) => { local.done(item, { conflict: { doc_type: item.doc_type, doc_number: item.doc_number, message, source: "tracker" } }); aside++; };
    for (const item of local.queue()) {
      if (!String(item.op).startsWith("tracker.")) continue;
      // The number goes first: wait while it is still queued; never add a number that clashed.
      if (local.numberPending(item.doc_type, item.doc_number)) continue;
      if (local.numberConflict(item.doc_type, item.doc_number)) {
        setAside(item, `${item.doc_number} was not added to the PO tracker because its number clashed.`);
        continue;
      }
      try {
        if (item.op === "tracker.link") await linkNow(item.params);
        else if (item.op === "tracker.attach") {
          let buffer;
          try { buffer = require("fs").readFileSync(item.file_path); } catch {
            setAside(item, `The file for ${item.doc_number} is no longer on this PC; attach it in the PO tracker by hand.`);
            continue;
          }
          await attachNow({ ...item, buffer });
        } else if (item.op === "tracker.cancel") await cancelNow(item.ref, item.reason);
        local.done(item);
        done++;
      } catch (e) {
        if (e.code !== "TRACKER_REFUSED") break; // offline or a passing server problem — try again later
        setAside(item, `PO tracker: ${item.doc_number} — ${String(e.message || e).slice(0, 200)}`);
      }
    }
    return { tracker_done: done, tracker_set_aside: aside };
  }

  return { available, sites, openPis, record, attach, cancel, sync, sourceRef };
}

module.exports = { createTracker, linkParams, sourceRef, isUuid };
