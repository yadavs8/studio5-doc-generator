const supabase = require("./supabase");

// Read-only lookups into the po-tracker's tables (same Supabase project), for
// the page's "which site / PO is this PI for?" and "which PI am I revising?"
// pickers. Plain queries joined here rather than PostgREST embedding, so the
// shape doesn't depend on how the tracker's foreign keys are named.

function notConfigured() {
  const err = new Error("The PO tracker link needs Supabase, which is not configured on this server.");
  err.code = "NOT_CONFIGURED";
  return err;
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Clients -> their sites -> each site's sub-projects and POs. Closed sites,
// inactive clients and completed POs are left out: a new PI never goes there.
async function listSites() {
  if (!supabase) throw notConfigured();
  const [clients, sites, subs, pos] = await Promise.all([
    rows(supabase.from("client").select("client_id, legal_name, display_name, gstin, billing_address, state, contact_person, status")),
    rows(supabase.from("site").select("site_id, client_id, site_name, site_address, status")),
    rows(supabase.from("sub_project").select("sub_project_id, site_id, name, status")),
    rows(supabase.from("purchase_order").select("po_id, site_id, sub_project_id, po_number, po_date, scope_description, total_value_with_gst, status")),
  ]);

  const openSite = s => !["completed", "closed"].includes(s.status);
  const byName = (a, b, k) => String(a[k] || "").localeCompare(String(b[k] || ""));

  return clients
    .filter(c => c.status !== "inactive")
    .map(c => ({
      client_id: c.client_id,
      name: c.display_name,
      legal_name: c.legal_name,
      gstin: c.gstin,
      billing_address: c.billing_address,
      state: c.state,
      contact_person: c.contact_person,
      sites: sites
        .filter(s => s.client_id === c.client_id && openSite(s))
        .map(s => ({
          site_id: s.site_id,
          name: s.site_name,
          address: s.site_address,
          status: s.status,
          sub_projects: subs
            .filter(sp => sp.site_id === s.site_id && sp.status !== "completed")
            .map(sp => ({ sub_project_id: sp.sub_project_id, name: sp.name }))
            .sort((a, b) => byName(a, b, "name")),
          pos: pos
            .filter(p => p.site_id === s.site_id && p.status !== "completed")
            .map(p => ({
              po_id: p.po_id,
              po_number: p.po_number,
              po_date: p.po_date,
              scope: p.scope_description,
              sub_project_id: p.sub_project_id,
              value: p.total_value_with_gst,
            }))
            .sort((a, b) => String(b.po_date).localeCompare(String(a.po_date))),
        }))
        .sort((a, b) => byName(a, b, "name")),
    }))
    .filter(c => c.sites.length)
    .sort((a, b) => byName(a, b, "name"));
}

// Every PI on a site, as the Revise picker needs it. Two kinds:
//   source "generator" — made here; its form details are saved, so the form
//                         can be reloaded and revised (mode "revise").
//   source "tracker"   — typed into the tracker by hand; no saved form. To
//                         re-issue it, generate a Final with this same number:
//                         fn_finalize_pi links to this row instead of adding one.
async function listPisForSite(siteId) {
  if (!supabase) throw notConfigured();
  const [trackerPis, ledger, pending] = await Promise.all([
    rows(supabase.from("proforma_invoice")
      .select("pi_id, pi_number, pi_date, amount, remarks, status, po_id, sub_project_id, document_id")
      .eq("site_id", siteId)),
    rows(supabase.from("generated_documents")
      .select("id, doc_number, revision, pi_id, total_amount, created_at, finalized_at")
      .eq("doc_type", "pi").eq("site_id", siteId).eq("status", "issued")),
    rows(supabase.from("generated_documents")
      .select("id, doc_number, revision, created_at")
      .eq("doc_type", "pi").eq("site_id", siteId).eq("status", "pending")),
  ]);

  const ledgerByPi = new Map(ledger.filter(l => l.pi_id).map(l => [l.pi_id, l]));
  const pendingByNumber = new Map(pending.map(p => [p.doc_number, p]));

  return trackerPis
    .map(pi => {
      const live = ledgerByPi.get(pi.pi_id) || null;
      const converted = pi.status === "converted_to_invoice";
      const inFlight = pendingByNumber.get(pi.pi_number) || null;
      return {
        pi_id: pi.pi_id,
        pi_number: pi.pi_number,
        pi_date: pi.pi_date,
        amount: pi.amount,
        work_status: pi.remarks,
        status: pi.status,
        po_id: pi.po_id,
        sub_project_id: pi.sub_project_id,
        source: live ? "generator" : "tracker",
        ledger_id: live ? live.id : null,
        revision: live ? live.revision : null,
        can_revise: !converted && !inFlight,
        why_not: converted
          ? "Already converted to a tax invoice — raise a credit/debit note instead."
          : inFlight
            ? `Revision ${inFlight.revision} is pending — retry or discard it first.`
            : null,
        pending_ledger_id: inFlight ? inFlight.id : null,
      };
    })
    .sort((a, b) => String(b.pi_date).localeCompare(String(a.pi_date)) || String(b.pi_number).localeCompare(String(a.pi_number)));
}

// PIs issued by the page before PIs were linked to sites. They can be revised
// onto a site (mode "revise" with site_id), which links them from then on.
async function listUnlinkedPis(limit = 50) {
  if (!supabase) throw notConfigured();
  const data = await rows(supabase.from("generated_documents")
    .select("id, doc_number, revision, counterparty_name, total_amount, created_at")
    .eq("doc_type", "pi").eq("status", "issued").is("site_id", null)
    .order("created_at", { ascending: false })
    .limit(limit));
  return data.map(d => ({
    ledger_id: d.id,
    pi_number: d.doc_number,
    revision: d.revision,
    buyer: d.counterparty_name,
    amount: d.total_amount,
    created_at: d.created_at,
  }));
}

module.exports = { listSites, listPisForSite, listUnlinkedPis };
