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

## Proforma Invoices: draft, final, revise

`POST /generate/proforma-invoice` takes a `mode` in the body:

| mode | What happens |
|---|---|
| `draft` | A `DRAFT`-numbered .docx to download. No number used, nothing saved. |
| `final` | Needs `site_id` (and optionally `po_id`, `work_status`). Takes the next number, saves the file to the po-tracker's `studio5-documents` storage, and creates the PI in the tracker — so it shows on that site's statement. |
| `revise` | Needs `revise_of: "<PI number>"` and `site_id`. Same number, next revision (`_r2`, `_r3`…). The tracker's PI is updated to the new amount and file; earlier revisions stay downloadable. A PI already converted to a tax invoice can't be revised. |
| *(none)* | The original behaviour, kept until the page sends a mode. |

A typed number more than 5 ahead of the next one is refused unless the body
says `confirm_far_ahead: true` — a slip like 1102 for 112 would otherwise push
every later number past 1102.

**If saving fails** after a number is taken (storage down, tracker refuses),
the answer is `502` with `code: "SAVED_AS_PENDING"` and a `ledger_id`. The
entry stays **pending** — never falsely "issued" — and can be finished or
dropped:
- `POST /api/documents/:ledgerId/retry` — rebuild the .docx and save it
- `POST /api/documents/:ledgerId/abandon` `{ reason }` — void it (a pending revision leaves the live one untouched)

**PDF made in the browser:** call generate with `?format=json` (reserves the
number as pending), then send the PDF to `POST /api/documents/:ledgerId/file`
(multipart, field `file`).

`GET /api/documents/:ledgerId/download` returns a 5-minute link to any saved revision.

**Lookups for the page's pickers** (read from the po-tracker's tables):
- `GET /api/sites` — clients → open sites → sub-projects and open POs. Each
  client carries its legal name, GSTIN and billing address for the buyer block.
  Inactive clients, closed/completed sites and completed POs are left out.
- `GET /api/pis?site_id=<uuid>` — every PI on that site, newest first, with
  `can_revise` and, when not, `why_not` (already a tax invoice, or a revision
  still pending). `source: "generator"` PIs have a `ledger_id` whose saved
  form loads back for **Revise**. `source: "tracker"` PIs were typed into the
  tracker by hand: generate a **Final** with that same number and it links to
  them instead of adding a second PI.
- `GET /api/pis/unlinked` — PIs issued before PIs were tied to a site.
  Revising one with a `site_id` links it from then on.
- `GET /api/documents/:ledgerId` — one entry with the form details it was made from.

## Sign-in

Everything except the page itself, `/assets`, `/manifest.json`, `/health`,
`/api/auth-config`, `/api/config-status` and the three sign-in steps below
needs a signed-in user. Accounts are the **same people as studio5-po-tracker**
(same Supabase project).

**How people sign in**
1. **First time on a phone/PC:** enter email → a one-time code arrives by
   email → enter it. Only accounts that already exist get a code.
2. **Set a 4-digit MPIN** for that device (easy ones like 1111 or 1234 are refused).
3. **Every time after that:** just the MPIN.
4. **5 wrong MPINs** lock that device; it then needs a new email code.
   **Forgot MPIN?** on the MPIN screen does the same.
5. **Lost phone:** bottom-left **Devices** → **Remove**. Its MPIN stops working
   at once. **Lock** closes the session on the current device.

The MPIN only works together with a secret stored in that browser, so it is
useless on another phone. Clearing the browser's data, or using a different
browser, counts as a new device. "Add to Home Screen" makes it feel like an app.

**One-time setup on Render** (add next to the two Supabase variables above):
- `DEVICE_TOKEN_KEY` — a random 32-byte key that encrypts each device's saved
  sign-in. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  Keep it secret; **changing it signs every device out** (they re-do the email code).
- `SUPABASE_PUBLISHABLE_KEY` (recommended) — Supabase **Settings → API →
  publishable (anon) key**, used for the sign-in calls.
- `CORS_ORIGINS` (optional) — comma-separated list of *other* websites allowed
  to call this API from a browser, e.g. `https://yadavs8.github.io`. The tool
  itself is served by this server, so it never needs listing.

**One-time setup in Supabase:**
1. Run `supabase/migration_003_trusted_devices.sql` in the SQL editor (after 002).
2. **Authentication → Sign In / Providers:** turn **off** "Allow new users to
   sign up". Add people yourself under **Authentication → Users → Add user**
   (email only is enough — they never need a password).
3. **Authentication → Emails → Templates → Magic Link:** make the email show
   the code by including `{{ .Token }}`, e.g. *"Your Studio5 sign-in code is
   {{ .Token }}"*. Without it the email contains only a link and no code.
4. **Authentication → Emails → SMTP Settings:** set up your own SMTP (e.g.
   Brevo, Resend or a Gmail app password). Supabase's built-in mailer only
   delivers to your Supabase team's own addresses and only a few emails an
   hour, so codes to anyone else would never arrive.
5. *(Optional)* **Settings → JWT → access token expiry:** a session lasts this
   long (default 1 hour) before the MPIN is asked again in an open tab.

**Running on your PC without Supabase:** if `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` are not set, the server still answers requests
from this same computer (localhost) with no sign-in — and refuses everyone
else. A cloud deploy with missing variables therefore fails closed.

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
