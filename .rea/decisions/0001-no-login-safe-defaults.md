# 0001 — No login; safe by default instead

Status: accepted (owner, 2026-11-15: "nothing, I am the only one who uses it")

The owner is the only user and wants no login. So the app stays login-free, but:
- the server listens on 127.0.0.1 (this PC only) unless HOST is set (Render sets RENDER, which opens it);
- only the app's own page may call the API (Origin check), so other websites the owner visits cannot drive it;
- an optional ACCESS_CODE env var turns on a one-time access code — off by default, recommended for any
  public deployment (Render), because without it a public URL lets anyone generate signed invoices;
- the server accepts only Studio5's own GSTINs and bank accounts on documents.
