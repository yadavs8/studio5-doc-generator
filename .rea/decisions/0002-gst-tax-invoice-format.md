# 0002 — GST-compliant tax invoice

Status: accepted (owner, 2026-11-15)

Tax invoices are titled "TAX INVOICE", show the place of supply, and split GST: CGST + SGST (half each)
when the place of supply is the issuer's state, otherwise IGST. Place of supply = the state entered on the
form, else the first two digits of the buyer's GSTIN, else the issuer's state. An optional SAC code is printed
when entered. The server computes the split; the browser's figures are only checked against it.
