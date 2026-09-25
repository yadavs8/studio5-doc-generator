# Studio5 Document Generator — Backend

This is the instant document-generation API for Studio5's Purchase Orders, Proforma
Invoices, Invoices, and Delivery Challans. It's a small Node.js/Express app — same style
as your bill-tracking backend, deployed the same way (Render, free tier).

## What it does

Exposes endpoints for generating documents and for the number ledger behind them.
Each `/generate/*` endpoint accepts a JSON payload (the same structure the document
generator tool builds) and returns a ready-to-download `.docx` file, after allocating
and permanently recording its document number:

- `POST /generate/purchase-order`
- `POST /generate/proforma-invoice`
- `POST /generate/invoice`
- `POST /generate/challan`
- `GET /next-number/:docType?address=<key>` — preview of the next number, without
  spending it (used to autofill the form)
- `GET /documents?type=<docType>&limit=<n>` — recent generated-document history
- `POST /void-document` `{ doc_type, doc_number, reason }` — marks a rejected
  document void, so the next number issued continues cleanly and the reason for
  the gap stays on record
- `GET /health` — for checking the server is alive

## Document numbering &amp; the "gets saved somewhere" ledger

Every document number is now allocated and recorded server-side in Supabase —
**the same Supabase project studio5-po-tracker already uses** — instead of a
counter living in one browser's `localStorage`. See `supabase/migration_001_document_ledger.sql`.

**One-time setup (do this before deploying the updated backend):**

1. Open the Supabase SQL editor for the **studio5-po-tracker** project (the same
   one from that repo's README) and run `supabase/migration_001_document_ledger.sql`
   from this repo. It only adds two new tables (`doc_number_sequences`,
   `generated_documents`) — it does not touch or rename anything from
   studio5-po-tracker's own schema.
2. In that Supabase project, go to **Settings → API** and copy the **Project URL**
   and the **service_role key** (not the anon/publishable key — this backend needs
   write access and bypasses Row Level Security by design, exactly like
   studio5-po-tracker's own server actions do for its Supabase project).
3. On Render, add two environment variables to this service:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Redeploy. Without these two variables set, the server still works (documents still
   generate) but numbers are neither remembered nor checked for duplicates — you'll see
   a warning in the Render logs.

**Number formats** (matched to Studio5's real documents/Tally ledger, not invented):

| Type | Format | Resets | Example |
|---|---|---|---|
| Purchase Order | `PO/{seq}` | never | `PO/14` |
| Proforma Invoice | `{FY}/{seq}` | never | `26-27/1102` |
| Tax Invoice | `S5{addressCode}/{FY}/{seq, 3-digit}` | every financial year | `S51/26-27/001` |
| Delivery Challan | `DC/{seq}` | never | `DC/46` |

The Tax Invoice address code is a fixed digit per saved issuing address
(`ADDRESS_SERIES_CODE` in `lib/documentNumbering.js`) — edit that map if you add a
new issuing address or a real invoice ever shows a different code.

**Handling a rejection:** generate the document as normal (it consumes a number),
then open the **Library** tab's "Recent Generated Documents" panel and click
**Mark void** on it, giving a reason. The next document generated continues the
sequence normally — the gap is explained on record instead of being silently
irregular.

**Manual overrides:** you can still type a number by hand into any of the four
number fields instead of using the autofilled one. The server checks it isn't a
duplicate and, if it isn't, advances the counter past it so future autofilled
numbers never collide with it.

## Deploy to Render (10 minutes, one-time)

1. **Push this folder to a new GitHub repo** (e.g. `studio5-doc-generator`) — same as you
   did for `Studio5-bill-backened`.
2. Go to [render.com](https://render.com) → **New +** → **Web Service**.
3. Connect the GitHub repo you just created.
4. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
5. Click **Create Web Service**. Render will give you a URL like
   `https://studio5-doc-generator.onrender.com` — this may take 2-5 minutes on first deploy.
6. Once live, open `https://your-url.onrender.com/health` in a browser — you should see
   `{"status":"ok"}`.

## Connect it to the document generator tool

1. Open `studio5_doc_generator.html`.
2. Go to the **Library** tab → **⚙️ Generator Backend** card at the top.
3. Paste your Render URL (e.g. `https://studio5-doc-generator.onrender.com`) and click
   **Save**, then **Test connection** to confirm it says "✓ Connected".
4. That's it — every "Generate" button now produces the file instantly, no copy-paste,
   no waiting on an AI chat.

## Important note on Render's free tier

Same as your bill-tracking backend: the free tier spins down after ~15 minutes of no
traffic, and the next request takes 30-60 seconds to wake it up. If speed matters for
"on the go" requests, either:
- Upgrade to Render's paid tier (~$7/month) to keep it always-on, or
- Ping the `/health` endpoint from your phone right before you know you'll need it, so
  it's already awake.

## Updating the format later

If you want to change any document's layout (columns, wording, styling), just edit the
matching file in `generators/` (they're the exact scripts we built and tested — nothing
changed except how they're called) and redeploy. Render auto-redeploys on every git push.

## Files in this package

```
backend/
  server.js                          — the Express API
  package.json                       — dependencies (express, docx, @supabase/supabase-js)
  lib/
    supabase.js                       — Supabase service-role client (server-side only)
    documentNumbering.js               — number formats, allocation, void, history
  generators/
    generate_po.js                     — Purchase Order
    generate_pi.js                      — Proforma Invoice
    generate_invoice.js                 — Invoice
    generate_challan.js                 — Delivery Challan
  supabase/
    migration_001_document_ledger.sql   — run once in the po-tracker's Supabase project
  assets/
    logo.png                            — Studio5 logo (used on PO/PI/Invoice)
    stamp.png                           — signature/stamp (available if you want to wire up
                                           auto-signing later — not yet connected to the endpoints)
```
