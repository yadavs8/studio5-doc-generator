# Studio5 Doc Generator — production-readiness audit

Audit date: 15 Nov 2026 · Branch `rea-production-audit` · Base `dfd34c3`
Sources: code reading (server.js, lib/, generators/, HTML), REA `security-scanner` + `bug-scanner`, live Supabase (read-only), `npm install` + `npm audit` (0 known vulnerabilities), smoke start.
What it is: Node/Express app (`studio5-doc-generator/server.js`) that serves the one-page tool `studio5_doc_generator.html` and generates Word POs, PIs, tax invoices and challans, allocating numbers in the shared `studio5-portal` Supabase project with the **service-role key**. Runs on the owner's Windows PC (`start_app.bat`) and/or Render (README). No tests, no CI.
Status: OPEN until fixed.

## Critical
| ID | Issue | Where | Fix |
|---|---|---|---|
| C1 | **No authentication on any endpoint, CORS `*`, listens on all network interfaces.** Anyone who can reach the server (Render URL, same Wi-Fi, or any website the owner visits, via the browser) can generate signed documents, burn or void numbers, read the client list and amounts, and spend the Gemini key. | server.js:14-20, 626 | Access check on every route except /health; same-origin only; bind 127.0.0.1 unless configured for a server. |
| C2 | **Arbitrary file write** via `filename` in `POST /api/save-generated-doc` (`../` escapes the folder: overwrite server.js on Render, drop a file in the Windows Startup folder locally). | server.js:509-515 | basename + containment check + .pdf/.docx only. |
| C3 | **Signed invoices with any bank account:** every invoice carries the company stamp/signature, and bank details, issuing address and totals come from the request as-is. Combined with C1 this is an invoice-fraud tool. | generate_invoice.js, server.js | C1 + server-side checks (H5, H6). |

## High
| ID | Issue | Where | Fix |
|---|---|---|---|
| H1 | `express.static(__dirname)` serves the whole folder: every generated document under `generated_docs/`, source, SQL. | server.js:22 | Serve only the page and `assets/`. |
| H2 | **Stored XSS**: `doc_number` is HTML-escaped but placed in an `onclick` JS string (`&#039;` decodes back). Steals the Gemini key, drives the API. | html:948 (also check 1302, 1318) | Event listeners + data attributes; validate number format server-side. |
| H3 | `/extract-items` spends the server's Gemini key for anyone; 25 MB bodies; tries up to 9 models; echoes upstream errors. | server.js:128-219 | Behind C1; size cap; type allow-list. |
| H4 | **Tax-invoice financial year from the server clock, not the invoice date** (UTC on Render; back-dated invoices get the wrong FY and series). | documentNumbering.js:17-57 | FY from the document date (Asia/Kolkata). |
| H5 | **Totals trusted from the browser** (line amounts, subtotals, GST, grand total, words, ledger amount). Blank-particulars rows are dropped from the document but counted in its subtotal. | server.js generate routes, html:3134-3171 | Recompute in paise on the server; refuse a mismatch. |
| H6 | **Number burnt and user stuck when generation fails**: number recorded before the docx is built; retry with the same number gets 409. | server.js:408-419 etc. | Validate + build first, record last. |
| H7 | **Without Supabase env every document is number 1** (PO/1, S51/26-27/001…) and nothing is recorded, silently. | documentNumbering.js:81,103 | 503 instead. |
| H8 | Migration does not revoke EXECUTE on the two SECURITY DEFINER functions (anyone with the public key could burn numbers on a fresh project; live DB already revoked by hand). | migration_001 | New migration_002 with revokes. |

## Medium
| ID | Issue | Fix |
|---|---|---|
| M1 | Manual numbers corrupt counters: trailing-digits parse (`PO/2026` → 2027), other-FY/other-series numbers bump the current scope, >10 digits → 500. | Parse FY + series from the typed number; cap; strict format check. |
| M2 | Counter bumped before the insert; a failed insert leaves a gap. | Insert first, bump after (inside one call). |
| M3 | Header/filename built from raw payload; bad chars → 500 *after* allocation. | Validate numbers; `res.attachment`. |
| M4 | Amount in words rounds to whole rupees (₹1000.60 → "One Thousand One"); no round-off line; generators print `Math.abs(round_off)`. | Decision D3. |
| M5 | Dates default to UTC "yesterday" before 05:30 IST (form, file names, folders). | IST dates. |
| M6 | `/api/open-folder` uses `exec()` with a built path and is open to anyone. | `execFile` + C1. |
| M7 | `/api/generated-docs` leaks absolute server paths and every client document name. | C1; return relative names. |
| M8 | Gemini output parsed without guarding; errors return 500 with upstream text. | Parse defensively; friendly errors. |
| M9 | Errors return raw `err.message` (Supabase internals, paths). | Generic messages, log details. |

## Low
| ID | Issue |
|---|---|
| L1 | `package-lock.json` gitignored → unreproducible installs on Render. |
| L2 | No tests, no CI. |
| L3 | Gemini key stored in browser localStorage. |
| L4 | `GET /` registered twice; unknown issuing-address key silently uses series "1"; `fmt(undefined)` prints NaN; voiding an already-void doc says "not found". |
| L5 | `start_app.bat` / `launch_app.vbs` hard-code `C:\Users\dell\...` paths. |
| L6 | 25 MB JSON / 50 MB upload limits held in memory. |

## NEEDS DECISION (owner)
| # | Question |
|---|---|
| D1 | Access: a shared access code (simple) or the same Supabase login + staff list as the PO tracker? |
| D2 | GST tax invoice format: split CGST+SGST (same state) / IGST (other state) by the buyer's GSTIN, title "TAX INVOICE", place of supply, SAC code? Today it prints one "GST @ x%" line and the title "INVOICE". |
| D3 | Rounding: round the invoice total to the rupee with a "Round off" line, or keep paise and add "and N paise" in words? |
| D4 | Where does it run today: your PC, Render, or both? |
