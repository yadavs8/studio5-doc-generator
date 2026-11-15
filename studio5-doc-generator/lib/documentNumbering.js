// Document numbers and the permanent ledger of issued documents (Supabase tables from
// supabase/migration_001_document_ledger.sql). All writes go through issue().

// Each issuing address has a fixed series code used only in the Tax Invoice number (matches the real
// S51/24-25/039 style numbers in Studio5's Tally ledger). The two Haryana addresses share GSTIN
// 06ABICS6962P1ZG and code "1"; the Delhi address (07ABICS6962P1ZE) has its own code.
const ADDRESS_SERIES_CODE = {
  gurgaon_sec17c: "1",
  manesar: "1",
  dwarka_delhi: "2",
};

const VALID_DOC_TYPES = ["po", "pi", "invoice", "challan"];
const MAX_SEQ = 99999999; // fits the database's int counter with room to spare

const err = (code, message) => Object.assign(new Error(message), { code });

/** Today's date in India as YYYY-MM-DD (the server may run in UTC). */
function todayIST(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "26-27" for any date from 1 Apr 2026 to 31 Mar 2027 (decision 0004). */
function fyFromDate(ymd) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || "")) ? String(ymd) : todayIST();
  const y = Number(d.slice(0, 4));
  const start = Number(d.slice(5, 7)) >= 4 ? y : y - 1;
  const two = (n) => String(n % 100).padStart(2, "0");
  return `${two(start)}-${two(start + 1)}`;
}

function seriesFor(addressKey) {
  return Object.prototype.hasOwnProperty.call(ADDRESS_SERIES_CODE, addressKey) ? ADDRESS_SERIES_CODE[addressKey] : "1";
}

function formatNumber(docType, seq, { fy, series } = {}) {
  switch (docType) {
    case "po": return `PO/${seq}`;
    case "pi": return `${fy}/${seq}`;
    case "invoice": return `S5${series}/${fy}/${String(seq).padStart(3, "0")}`;
    case "challan": return `DC/${seq}`;
    default: throw err("INVALID_DOC_TYPE", `Unknown document type: ${docType}`);
  }
}

const PATTERNS = {
  po: /^PO\/(\d{1,8})$/i,
  pi: /^(\d{2}-\d{2})\/(\d{1,8})$/,
  invoice: /^S5(\d)\/(\d{2}-\d{2})\/(\d{1,8})$/i,
  challan: /^DC\/(\d{1,8})$/i,
};

/**
 * Reads a number someone typed by hand. Returns its sequence (and FY / series where the format has them),
 * or null if it does not match the document type's format. Only well-formed numbers are ever recorded, so a
 * number can never carry markup or move a counter by mistake (e.g. "PO/2026x").
 */
function parseTypedNumber(docType, text) {
  const m = PATTERNS[docType] && String(text || "").trim().match(PATTERNS[docType]);
  if (!m) return null;
  if (docType === "invoice") return { seq: Number(m[3]), fy: m[2], series: m[1] };
  if (docType === "pi") return { seq: Number(m[2]), fy: m[1] };
  return { seq: Number(m[1]) };
}

function scopeKey(docType, { fy, series }) {
  return docType === "invoice" ? `${series}:${fy}` : "GLOBAL";
}

function assertValidDocType(docType) {
  if (!VALID_DOC_TYPES.includes(docType)) throw err("INVALID_DOC_TYPE", `Unknown document type: ${docType}`);
}

/** True when Supabase could not be reached at all (no internet / DNS / timeout), as opposed to a real error. */
function isNetworkError(e) {
  const t = `${(e && e.message) || ""} ${(e && e.details) || ""} ${(e && e.code) || ""}`;
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up/i.test(t);
}

/**
 * Numbering backed by Supabase, with an optional ledger on this PC (`local`, see localLedger.js):
 *  - online: Supabase decides; this PC remembers counters and history;
 *  - offline (Supabase unreachable) or Supabase not configured: this PC's ledger decides, and every
 *    change is queued and uploaded by sync() once Supabase can be reached. A number that was meanwhile
 *    used elsewhere is reported as a conflict, never uploaded twice.
 * Without `local`, numbering refuses (503) when Supabase is missing, instead of guessing.
 */
function createNumbering(supabase, { local = null } = {}) {
  const ctx = (docType, { addressKey, date }) => ({ fy: fyFromDate(date), series: seriesFor(addressKey) });
  const notConfigured = () => err("NOT_CONFIGURED", "Document numbering is not set up on this server (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing), so no number can be issued safely.");

  /** Runs `online` against Supabase; on no-connection (or no Supabase) runs `offline` with the local ledger. */
  async function either(online, offline) {
    if (supabase) {
      try {
        return { value: await online(), offline: false };
      } catch (e) {
        if (!local || !isNetworkError(e)) throw e;
      }
    } else if (!local) {
      throw notConfigured();
    }
    return { value: await offline(), offline: true };
  }
  const check = ({ data, error }) => { if (error) throw error; return data; };

  async function preview(docType, opts = {}) {
    assertValidDocType(docType);
    const c = ctx(docType, opts);
    const scope = scopeKey(docType, c);
    const { value: seq } = await either(async () => {
      const row = check(await supabase.from("doc_number_sequences").select("next_seq")
        .eq("doc_type", docType).eq("scope_key", scope).maybeSingle());
      const next = row ? row.next_seq : 1;
      if (local) local.seen(docType, scope, next);
      return Math.max(next, local ? local.next(docType, scope) : 1);
    }, async () => local.next(docType, scope));
    return formatNumber(docType, seq, c);
  }

  async function recordRemote(row) {
    const { error } = await supabase.from("generated_documents").insert(row);
    if (error && error.code === "23505") throw err("DUPLICATE_NUMBER", `Document number "${row.doc_number}" has already been issued.`);
    if (error) throw error;
  }

  /** Records a finished document: in Supabase (and this PC's history), or queued here when offline. */
  async function record(row, offline) {
    if (!offline) {
      try {
        await recordRemote(row);
        if (local) local.add(row, { queued: false });
        return false;
      } catch (e) {
        if (!local || !isNetworkError(e)) throw e;
      }
    }
    local.add(row, { queued: true });
    return true;
  }

  async function issue(docType, { docNumber, addressKey, date, payload, counterpartyName, totalAmount, build } = {}) {
    assertValidDocType(docType);
    const typed = docNumber && String(docNumber).trim().toUpperCase();
    let parsed = null;
    if (typed) {
      parsed = parseTypedNumber(docType, typed);
      if (!parsed || parsed.seq < 1 || parsed.seq > MAX_SEQ) {
        throw err("INVALID_NUMBER", `"${typed}" is not a valid ${docType.toUpperCase()} number. Expected e.g. ${formatNumber(docType, 7, { fy: fyFromDate(date), series: seriesFor(addressKey) })}.`);
      }
    }
    if (!supabase && !local) throw notConfigured();
    const row = {
      doc_type: docType,
      issuing_address_key: addressKey || null,
      counterparty_name: counterpartyName || null,
      total_amount: totalAmount ?? null,
      payload: payload || {},
    };

    if (typed) {
      const c = { fy: parsed.fy || fyFromDate(date), series: parsed.series || seriesFor(addressKey) };
      const scope = scopeKey(docType, c);
      const { value: taken, offline } = await either(
        async () => !!check(await supabase.from("generated_documents").select("id").eq("doc_type", docType).eq("doc_number", typed).maybeSingle()),
        async () => false,
      );
      if (taken || (local && local.has(docType, typed))) throw err("DUPLICATE_NUMBER", `Document number "${typed}" has already been issued.`);
      const file = build ? await build(typed) : undefined;
      const queued = await record({ ...row, doc_number: typed, status: "issued" }, offline);
      if (local) local.seen(docType, scope, parsed.seq + 1);
      if (!queued) {
        const { error: bumpErr } = await supabase.rpc("fn_bump_document_sequence", { p_doc_type: docType, p_scope_key: scope, p_at_least: parsed.seq + 1 });
        if (bumpErr) console.error("[numbering] counter not advanced after a typed number:", bumpErr.message);
      }
      return { docNumber: typed, file, offline: queued };
    }

    const c = ctx(docType, { addressKey, date });
    const scope = scopeKey(docType, c);
    let { value: seq, offline } = await either(
      async () => check(await supabase.rpc("fn_allocate_document_number", { p_doc_type: docType, p_scope_key: scope })),
      async () => local.take(docType, scope),
    );
    // Online but this PC already used higher numbers offline (not yet uploaded): skip past them.
    if (!offline && local && seq < local.next(docType, scope) && local.pendingCount() > 0) {
      while (local.has(docType, formatNumber(docType, seq, c))) {
        seq = check(await supabase.rpc("fn_allocate_document_number", { p_doc_type: docType, p_scope_key: scope }));
      }
    }
    if (!offline && local) local.seen(docType, scope, seq + 1);
    const number = formatNumber(docType, seq, c);
    let file;
    try {
      file = build ? await build(number) : undefined;
    } catch (e) {
      await record({ ...row, doc_number: number, status: "void", void_reason: `Document could not be generated: ${String(e.message).slice(0, 200)}`, voided_at: new Date().toISOString() }, offline)
        .catch((re) => console.error("[numbering] could not record the failed number:", re.message));
      throw e;
    }
    const queued = await record({ ...row, doc_number: number, status: "issued" }, offline);
    return { docNumber: number, file, offline: queued };
  }

  async function voidDocument(docType, docNumber, reason) {
    assertValidDocType(docType);
    const { value } = await either(async () => {
      const data = check(await supabase.from("generated_documents")
        .update({ status: "void", void_reason: reason || null, voided_at: new Date().toISOString() })
        .eq("doc_type", docType).eq("doc_number", docNumber).eq("status", "issued").select().maybeSingle());
      if (local) local.void(docType, docNumber, reason || null, { queued: false });
      if (!data) {
        // It may only exist on this PC so far (made offline, not uploaded yet).
        const here = local && local.list(docType, 1000).find((d) => d.doc_number === docNumber);
        if (here) return here;
        throw err("NOT_FOUND", `No issued ${docType} document "${docNumber}" (it may already be void).`);
      }
      return data;
    }, async () => {
      const doc = local.void(docType, docNumber, reason || null, { queued: !!supabase });
      if (!doc) throw err("NOT_FOUND", `No issued ${docType} document "${docNumber}" on this PC (it may already be void).`);
      return doc;
    });
    return value;
  }

  async function listDocuments(docType, limit = 25) {
    const { value } = await either(async () => {
      let q = supabase.from("generated_documents")
        .select("id, doc_type, doc_number, status, void_reason, counterparty_name, total_amount, created_at, voided_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (docType) q = q.eq("doc_type", docType);
      const rows = check(await q);
      // Documents made offline and not uploaded yet are shown too, marked as waiting.
      const waiting = local ? local.queue().filter((x) => x.op === "insert" && (!docType || x.row.doc_type === docType)).map((x) => ({ ...x.row, pending_upload: true })) : [];
      return [...waiting, ...rows].slice(0, limit);
    }, async () => {
      const waiting = new Set(local.queue().filter((x) => x.op === "insert").map((x) => `${x.row.doc_type}|${x.row.doc_number}`));
      return local.list(docType, limit).map((d) => ({ ...d, pending_upload: waiting.has(`${d.doc_type}|${d.doc_number}`) }));
    });
    return value;
  }

  /** Uploads what was done offline. Safe to call any time; one run at a time; stops quietly while offline. */
  let running = null;
  function sync() {
    if (!running) running = syncOnce().finally(() => { running = null; });
    return running;
  }

  async function bump(row) {
    const parsed = parseTypedNumber(row.doc_type, row.doc_number);
    if (!parsed) return;
    const c = { fy: parsed.fy || fyFromDate(), series: parsed.series || seriesFor(row.issuing_address_key) };
    check(await supabase.rpc("fn_bump_document_sequence", { p_doc_type: row.doc_type, p_scope_key: scopeKey(row.doc_type, c), p_at_least: parsed.seq + 1 }));
  }

  async function syncOnce() {
    if (!local) return { uploaded: 0, conflicts: 0, pending: 0 };
    if (!supabase) return { uploaded: 0, conflicts: 0, pending: local.pendingCount() };
    let uploaded = 0, conflicts = 0;
    for (const item of local.queue()) {
      if (!["insert", "bump", "void"].includes(item.op)) continue; // other jobs (PO tracker) are done by their own sync
      try {
        if (item.op === "insert") {
          try {
            await recordRemote(item.row);
          } catch (e) {
            if (e.code !== "DUPLICATE_NUMBER") throw e;
            // Already there: is it this very document (uploaded before, answer lost) or someone else's?
            const existing = check(await supabase.from("generated_documents").select("payload")
              .eq("doc_type", item.row.doc_type).eq("doc_number", item.row.doc_number).maybeSingle());
            const ref = item.row.payload && item.row.payload.offline_ref;
            const same = !!ref && !!existing && existing.payload && existing.payload.offline_ref === ref;
            if (!same) {
              local.done(item, { conflict: { doc_type: item.row.doc_type, doc_number: item.row.doc_number, message: `Number ${item.row.doc_number} was already used elsewhere while this PC was offline. Issue this document again with a new number and void the old copy.` } });
              conflicts++;
              continue;
            }
          }
          // The row is in the cloud now; if moving the counter fails, retry only that.
          local.replace(item, { op: "bump", row: item.row });
          await bump(item.row);
        } else if (item.op === "bump") {
          await bump(item.row);
        } else if (item.op === "void") {
          check(await supabase.from("generated_documents")
            .update({ status: "void", void_reason: item.reason, voided_at: item.voided_at })
            .eq("doc_type", item.doc_type).eq("doc_number", item.doc_number).eq("status", "issued").select().maybeSingle());
        }
        local.done(item);
        uploaded += item.op === "bump" ? 0 : 1;
      } catch (e) {
        if (isNetworkError(e)) break; // still offline — try again later
        // Refused for good (e.g. a database rule): set it aside so it cannot block everything behind it.
        console.error("[sync] could not upload", item.op, item.row ? item.row.doc_number : item.doc_number, e.message || e);
        local.done(item, { conflict: { doc_type: (item.row || item).doc_type, doc_number: (item.row || item).doc_number, message: `${(item.row || item).doc_number} could not be uploaded: ${String(e.message || e).slice(0, 200)}` } });
        conflicts++;
      }
    }
    return { uploaded, conflicts, pending: local.pendingCount() };
  }

  const status = () => (local ? local.status() : { pending: 0, conflicts: [] });

  return { preview, issue, voidDocument, listDocuments, sync, status };
}

module.exports = {
  ADDRESS_SERIES_CODE, VALID_DOC_TYPES,
  todayIST, fyFromDate, formatNumber, parseTypedNumber, createNumbering, isNetworkError,
};
