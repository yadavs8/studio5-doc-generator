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

// A typed number this far past the next auto-number needs confirmation.
const FAR_AHEAD_LIMIT = 5;

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
//
// status "pending" reserves the number before the file exists; the caller
// then builds + uploads the file and finalizes it (finalizePi), or the row
// stays pending — visible, retryable, voidable — instead of claiming a
// document was issued that never got saved.
async function allocateAndRecord(docType, params) {
  assertValidDocType(docType);
  const {
    docNumber, opts = {}, counterpartyName, totalAmount, issuingAddressKey, payload,
    status = "issued", siteId = null, poId = null, createdBy = null, confirmFarAhead = false,
  } = params;

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
    // A number can have several rows (one per revision), so look for any.
    const { data: existing, error: existErr } = await supabase
      .from("generated_documents")
      .select("id")
      .eq("doc_type", docType)
      .eq("doc_number", finalNumber)
      .limit(1);
    if (existErr) throw existErr;
    if (existing.length) {
      const err = new Error(`Document number "${finalNumber}" has already been issued for ${docType}. To change that document, revise it instead.`);
      err.code = "DUPLICATE_NUMBER";
      throw err;
    }
    const seqFromNumber = parseSeqFromNumber(finalNumber);
    if (seqFromNumber != null && !confirmFarAhead) {
      // A slip like 1102 for 112 would push every later auto-number past
      // 1102 for good, so a big jump needs an explicit confirmation.
      const { data: seqRow, error: seqErr } = await supabase
        .from("doc_number_sequences")
        .select("next_seq")
        .eq("doc_type", docType)
        .eq("scope_key", scopeKey)
        .maybeSingle();
      if (seqErr) throw seqErr;
      const nextSeq = seqRow ? seqRow.next_seq : 1;
      if (seqFromNumber > nextSeq + FAR_AHEAD_LIMIT) {
        const err = new Error(
          `"${finalNumber}" is ${seqFromNumber - nextSeq} ahead of the next number (${formatNumber(docType, nextSeq, opts)}). ` +
          `Using it moves every later number past it. Is that intended?`
        );
        err.code = "NUMBER_FAR_AHEAD";
        throw err;
      }
    }
    if (seqFromNumber != null) {
      const { error: bumpErr } = await supabase.rpc("fn_bump_document_sequence", {
        p_doc_type: docType,
        p_scope_key: scopeKey,
        p_at_least: seqFromNumber + 1,
      });
      if (bumpErr) throw bumpErr;
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("generated_documents")
    .insert({
      doc_type: docType,
      doc_number: finalNumber,
      status,
      issuing_address_key: issuingAddressKey || null,
      counterparty_name: counterpartyName || null,
      total_amount: totalAmount ?? null,
      payload,
      site_id: siteId,
      po_id: poId,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (insertErr) {
    if (insertErr.code === "23505") {
      const err = new Error(`Document number "${finalNumber}" has already been issued for ${docType}.`);
      err.code = "DUPLICATE_NUMBER";
      throw err;
    }
    throw insertErr;
  }

  return { docNumber: finalNumber, ledgerId: inserted.id, revision: 1 };
}

// Starts the next revision of an issued document (migration 002). The new
// revision is pending until finalizePi; the live one is untouched till then.
async function beginRevision(docType, docNumber, params) {
  assertValidDocType(docType);
  const { payload, totalAmount, counterpartyName, issuingAddressKey, createdBy, siteId, poId } = params;
  const { data, error } = await supabase.rpc("fn_begin_revision", {
    p_doc_type: docType,
    p_doc_number: String(docNumber).trim(),
    p_payload: payload,
    p_total_amount: totalAmount ?? null,
    p_counterparty_name: counterpartyName || null,
    p_issuing_address_key: issuingAddressKey || null,
    p_user_id: createdBy || null,
  });
  if (error) {
    const err = new Error(
      error.code === "23505"
        ? `"${docNumber}" is already being revised. Finish or discard that revision first (Library → pending).`
        : error.message
    );
    err.code = error.code === "23505" ? "REVISION_IN_PROGRESS" : /no issued/i.test(error.message) ? "NOT_FOUND" : error.code;
    throw err;
  }
  const row = data[0];
  // Documents issued before migration 002 have no site on record; the
  // revision carries the site picked now.
  if (siteId || poId) {
    const patch = {};
    if (siteId) patch.site_id = siteId;
    if (poId) patch.po_id = poId;
    const { error: upErr } = await supabase.from("generated_documents").update(patch).eq("id", row.ledger_id);
    if (upErr) throw upErr;
  }
  return { docNumber: String(docNumber).trim(), ledgerId: row.ledger_id, revision: row.revision };
}

async function finalizePi(params) {
  const { ledgerId, siteId, poId, subProjectId, piDate, amount, remarks, subject, storagePath, userId } = params;
  const { data, error } = await supabase.rpc("fn_finalize_pi", {
    p_ledger_id: ledgerId,
    p_site_id: siteId,
    p_po_id: poId || null,
    p_sub_project_id: subProjectId || null,
    p_pi_date: piDate,
    p_amount: amount,
    p_remarks: remarks || null,
    p_storage_path: storagePath,
    p_user_id: userId || null,
    p_subject: subject || null,
  });
  if (error) {
    const err = new Error(error.message);
    err.code = "FINALIZE_FAILED";
    throw err;
  }
  return data; // pi_id in the po-tracker
}

async function abandonPending(ledgerId, reason) {
  const { error } = await supabase.rpc("fn_abandon_pending", { p_ledger_id: ledgerId, p_reason: reason || null });
  if (error) {
    const err = new Error(error.message);
    err.code = "NOT_FOUND";
    throw err;
  }
}

async function getLedgerRow(ledgerId) {
  const { data, error } = await supabase.from("generated_documents").select("*").eq("id", ledgerId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getIssued(docType, docNumber) {
  const { data, error } = await supabase
    .from("generated_documents")
    .select("*")
    .eq("doc_type", docType)
    .eq("doc_number", String(docNumber).trim())
    .eq("status", "issued")
    .maybeSingle();
  if (error) throw error;
  return data;
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
    .select("id, doc_type, doc_number, revision, status, void_reason, counterparty_name, total_amount, site_id, po_id, pi_id, storage_path, created_at, finalized_at, voided_at")
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
  beginRevision,
  finalizePi,
  abandonPending,
  getLedgerRow,
  getIssued,
  voidDocument,
  listDocuments,
  ADDRESS_SERIES_CODE,
};
