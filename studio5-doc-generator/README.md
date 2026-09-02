# Studio5 Document Generator — Backend

This is the instant document-generation API for Studio5's Purchase Orders, Proforma
Invoices, Invoices, and Delivery Challans. It's a small Node.js/Express app — same style
as your bill-tracking backend, deployed the same way (Render, free tier).

## What it does

Exposes 4 endpoints. Each accepts a JSON payload (the same structure the document
generator tool builds) and returns a ready-to-download `.docx` file:

- `POST /generate/purchase-order`
- `POST /generate/proforma-invoice`
- `POST /generate/invoice`
- `POST /generate/challan`
- `GET /health` — for checking the server is alive

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
  server.js              — the Express API
  package.json           — dependencies (express, docx)
  generators/
    generate_po.js        — Purchase Order
    generate_pi.js         — Proforma Invoice
    generate_invoice.js    — Invoice
    generate_challan.js    — Delivery Challan
  assets/
    logo.png               — Studio5 logo (used on PO/PI/Invoice)
    stamp.png               — signature/stamp (available if you want to wire up
                               auto-signing later — not yet connected to the endpoints)
```
