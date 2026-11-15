# 0005 — PIs and tax invoices are recorded in the PO tracker

Status: accepted (2026-11-15). Tracker side: studio5-po-tracker decision 0011 / migration_017.

- A **PO tracker site** picker on the PI and invoice forms (the tracker's client/site list is the master; picking a
  site fills the buyer). With a site picked, the document is recorded there under that site with its Word/PDF file;
  an invoice can be marked as made from one of the site's open PIs. Without a site nothing is sent.
- **Never fails a document:** a tracker refusal (e.g. the number was typed in there by hand) or outage is shown as a
  note after generating; the document and its number stand.
- **Offline:** link / file / cancel jobs join the ledger queue and run after the document's own number is uploaded;
  if the number clashed, they are set aside (never added to the tracker). Retries are safe (source_ref).
- **Void here** cancels it there; when the tracker refuses (PI converted or linked to a PO, invoice paid or in
  Tally) the void here stands and the reason is shown.
- **Not linked:** purchase orders to vendors and delivery challans.
