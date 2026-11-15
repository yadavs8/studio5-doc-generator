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
  return ADDRESS_SERIES_CODE[addressKey] || "1";
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

function createNumbering(supabase) {
  const need = () => {
    if (!supabase) {
      throw err("NOT_CONFIGURED", "Document numbering is not set up on this server (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing), so no number can be issued safely.");
    }
  };
  const ctx = (docType, { addressKey, date }) => ({ fy: fyFromDate(date), series: seriesFor(addressKey) });

  /** What the next automatic number would be, without spending it. */
  async function preview(docType, opts = {}) {
    assertValidDocType(docType);
    need();
    const c = ctx(docType, opts);
    const { data, error } = await supabase.from("doc_number_sequences").select("next_seq")
      .eq("doc_type", docType).eq("scope_key", scopeKey(docType, c)).maybeSingle();
    if (error) throw error;
    return formatNumber(docType, data ? data.next_seq : 1, c);
  }

  async function record(row) {
    const { error } = await supabase.from("generated_documents").insert(row);
    if (error && error.code === "23505") throw err("DUPLICATE_NUMBER", `Document number "${row.doc_number}" has already been issued.`);
    if (error) throw error;
  }

  /**
   * Issues one document: picks (or checks) its number, builds the file with that number, then records it.
   *  - typed number: must match the format and be unused; it is recorded only once the file was built,
   *    and only then moves its own counter (its own FY / series) forward.
   *  - automatic number: allocated atomically; if the file cannot be built, the number is recorded as void
   *    with the reason, so the gap in the sequence is explained.
   * `build(docNumber)` returns the file (or nothing for record-only calls).
   */
  async function issue(docType, { docNumber, addressKey, date, payload, counterpartyName, totalAmount, build } = {}) {
    assertValidDocType(docType);
    const typed = docNumber && String(docNumber).trim();
    let parsed = null;
    if (typed) {
      parsed = parseTypedNumber(docType, typed);
      if (!parsed || parsed.seq < 1 || parsed.seq > MAX_SEQ) {
        throw err("INVALID_NUMBER", `"${typed}" is not a valid ${docType.toUpperCase()} number. Expected e.g. ${formatNumber(docType, 7, { fy: fyFromDate(date), series: seriesFor(addressKey) })}.`);
      }
    }
    need();
    const row = {
      doc_type: docType,
      issuing_address_key: addressKey || null,
      counterparty_name: counterpartyName || null,
      total_amount: totalAmount ?? null,
      payload: payload || {},
    };

    if (typed) {
      const { data: existing, error } = await supabase.from("generated_documents").select("id")
        .eq("doc_type", docType).eq("doc_number", typed).maybeSingle();
      if (error) throw error;
      if (existing) throw err("DUPLICATE_NUMBER", `Document number "${typed}" has already been issued.`);
      const file = build ? await build(typed) : undefined;
      await record({ ...row, doc_number: typed, status: "issued" });
      const c = { fy: parsed.fy || fyFromDate(date), series: parsed.series || seriesFor(addressKey) };
      const { error: bumpErr } = await supabase.rpc("fn_bump_document_sequence", {
        p_doc_type: docType, p_scope_key: scopeKey(docType, c), p_at_least: parsed.seq + 1,
      });
      if (bumpErr) console.error("[numbering] counter not advanced after a typed number:", bumpErr.message);
      return { docNumber: typed, file };
    }

    const c = ctx(docType, { addressKey, date });
    const { data: seq, error: seqErr } = await supabase.rpc("fn_allocate_document_number", {
      p_doc_type: docType, p_scope_key: scopeKey(docType, c),
    });
    if (seqErr) throw seqErr;
    const number = formatNumber(docType, seq, c);
    let file;
    try {
      file = build ? await build(number) : undefined;
    } catch (e) {
      await record({ ...row, doc_number: number, status: "void", void_reason: `Document could not be generated: ${String(e.message).slice(0, 200)}`, voided_at: new Date().toISOString() })
        .catch((re) => console.error("[numbering] could not record the failed number:", re.message));
      throw e;
    }
    await record({ ...row, doc_number: number, status: "issued" });
    return { docNumber: number, file };
  }

  async function voidDocument(docType, docNumber, reason) {
    assertValidDocType(docType);
    need();
    const { data, error } = await supabase.from("generated_documents")
      .update({ status: "void", void_reason: reason || null, voided_at: new Date().toISOString() })
      .eq("doc_type", docType).eq("doc_number", docNumber).eq("status", "issued").select().maybeSingle();
    if (error) throw error;
    if (!data) throw err("NOT_FOUND", `No issued ${docType} document "${docNumber}" (it may already be void).`);
    return data;
  }

  async function listDocuments(docType, limit = 25) {
    need();
    let q = supabase.from("generated_documents")
      .select("id, doc_type, doc_number, status, void_reason, counterparty_name, total_amount, created_at, voided_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (docType) q = q.eq("doc_type", docType);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  return { preview, issue, voidDocument, listDocuments };
}

module.exports = {
  ADDRESS_SERIES_CODE, VALID_DOC_TYPES,
  todayIST, fyFromDate, formatNumber, parseTypedNumber, createNumbering,
};
