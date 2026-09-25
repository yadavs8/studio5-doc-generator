const supabase = require("./supabase");

// Each saved issuing address gets a fixed one-character series code, used
// only in the Tax Invoice number (matches the real S51/24-25/039 style
// numbers found in Studio5's own Tally ledger). The two Haryana addresses
// share GSTIN 06ABICS6962P1ZG and share code "1"; the Delhi address has
// its own GSTIN (07ABICS6962P1ZE) and its own code. Adjust here if a real
// invoice ever shows a different mapping.
const ADDRESS_SERIES_CODE = {
  gurgaon_sec17c: "1",
  manesar: "1",
  dwarka_delhi: "2",
};

const VALID_DOC_TYPES = ["po", "pi", "invoice", "challan"];

function getFinancialYear(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1-12
  const startYear = m >= 4 ? y : y - 1;
  const startShort = String(startYear % 100).padStart(2, "0");
  const endShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startShort}-${endShort}`;
}

function addressSeriesCode(addressKey) {
  return ADDRESS_SERIES_CODE[addressKey] || "1";
}

// Formats match the real documents in Studio5's own records, not an
// invented scheme: PI is "{FY}/{seq}" with no prefix (matches a real PI:
// 23-24/1101); Tax Invoice is "S5{addressCode}/{FY}/{seq, 3-digit}"
// (matches real ledger entries: S51/24-25/039, S51/25-26/001).
function formatNumber(docType, seq, opts = {}) {
  const fy = opts.fy || getFinancialYear();
  switch (docType) {
    case "po":
      return `PO/${seq}`;
    case "pi":
      return `${fy}/${seq}`;
    case "invoice":
      return `S5${addressSeriesCode(opts.addressKey)}/${fy}/${String(seq).padStart(3, "0")}`;
    case "challan":
      return `DC/${seq}`;
    default:
      throw new Error(`Unknown document type: ${docType}`);
  }
}

// PO, PI and Challan never reset — one running counter forever. Tax
// Invoice resets every financial year per GST's sequential numbering
// rule, and is scoped per issuing-address series code since each address
// has its own GSTIN.
function scopeKeyFor(docType, opts = {}) {
  if (docType === "invoice") {
    return `${addressSeriesCode(opts.addressKey)}:${opts.fy || getFinancialYear()}`;
  }
  return "GLOBAL";
}

// Pulls the trailing digits out of a document number so a manually typed
// number can self-heal the counter forward (see fn_bump_document_sequence).
function parseSeqFromNumber(docNumber) {
  const m = String(docNumber || "").match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

function assertValidDocType(docType) {
  if (!VALID_DOC_TYPES.includes(docType)) {
    const err = new Error(`Unknown document type: ${docType}`);
    err.code = "INVALID_DOC_TYPE";
    throw err;
  }
}

// Read-only: what the next number WOULD be, without allocating it. Used to
// autofill the form field so opening a tab and never clicking Generate
// never burns a number.
async function previewNextNumber(docType, opts = {}) {
  assertValidDocType(docType);
  if (!supabase) return formatNumber(docType, 1, opts);
  const scopeKey = scopeKeyFor(docType, opts);
  const { data, error } = await supabase
    .from("doc_number_sequences")
    .select("next_seq")
    .eq("doc_type", docType)
    .eq("scope_key", scopeKey)
    .maybeSingle();
  if (error) throw error;
  const seq = data ? data.next_seq : 1;
  return formatNumber(docType, seq, opts);
}

// The only place a number is actually spent. If the caller supplies a
// number (the user typed/edited it), that number is honored as-is, checked
// for a duplicate, and used to self-heal the counter forward. If not, the
// next number is atomically allocated server-side. Either way the document
// is then permanently recorded.
async function allocateAndRecord(docType, params) {
  assertValidDocType(docType);
  const { docNumber, opts = {}, counterpartyName, totalAmount, issuingAddressKey, payload } = params;

  if (!supabase) {
    return {
      docNumber: docNumber || formatNumber(docType, 1, opts),
      warning: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — document was generated but not recorded.",
    };
  }

  const scopeKey = scopeKeyFor(docType, opts);
  let finalNumber = docNumber && docNumber.trim();

  if (!finalNumber) {
    const { data: seq, error: seqErr } = await supabase.rpc("fn_allocate_document_number", {
      p_doc_type: docType,
      p_scope_key: scopeKey,
    });
    if (seqErr) throw seqErr;
    finalNumber = formatNumber(docType, seq, opts);
  } else {
    const { data: existing, error: existErr } = await supabase
      .from("generated_documents")
      .select("id")
      .eq("doc_type", docType)
      .eq("doc_number", finalNumber)
      .maybeSingle();
    if (existErr) throw existErr;
    if (existing) {
      const err = new Error(`Document number "${finalNumber}" has already been issued for ${docType}.`);
      err.code = "DUPLICATE_NUMBER";
      throw err;
    }
    const seqFromNumber = parseSeqFromNumber(finalNumber);
    if (seqFromNumber != null) {
      const { error: bumpErr } = await supabase.rpc("fn_bump_document_sequence", {
        p_doc_type: docType,
        p_scope_key: scopeKey,
        p_at_least: seqFromNumber + 1,
      });
      if (bumpErr) throw bumpErr;
    }
  }

  const { error: insertErr } = await supabase.from("generated_documents").insert({
    doc_type: docType,
    doc_number: finalNumber,
    status: "issued",
    issuing_address_key: issuingAddressKey || null,
    counterparty_name: counterpartyName || null,
    total_amount: totalAmount ?? null,
    payload,
  });
  if (insertErr) {
    if (insertErr.code === "23505") {
      const err = new Error(`Document number "${finalNumber}" has already been issued for ${docType}.`);
      err.code = "DUPLICATE_NUMBER";
      throw err;
    }
    throw insertErr;
  }

  return { docNumber: finalNumber };
}

async function voidDocument(docType, docNumber, reason) {
  assertValidDocType(docType);
  if (!supabase) {
    const err = new Error("Supabase is not configured on this server.");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  const { data, error } = await supabase
    .from("generated_documents")
    .update({ status: "void", void_reason: reason || null, voided_at: new Date().toISOString() })
    .eq("doc_type", docType)
    .eq("doc_number", docNumber)
    .eq("status", "issued")
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error(`No issued ${docType} document found with number "${docNumber}".`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return data;
}

async function listDocuments(docType, limit = 25) {
  if (!supabase) return [];
  let query = supabase
    .from("generated_documents")
    .select("id, doc_type, doc_number, status, void_reason, counterparty_name, total_amount, created_at, voided_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (docType) query = query.eq("doc_type", docType);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

module.exports = {
  getFinancialYear,
  formatNumber,
  previewNextNumber,
  allocateAndRecord,
  voidDocument,
  listDocuments,
  ADDRESS_SERIES_CODE,
};
