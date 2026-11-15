# 0003 — Invoice and PI totals rounded to the rupee

Status: accepted (owner, 2026-11-15)

Grand total = taxable + GST, rounded to the nearest rupee, with a visible "Round off" row; the amount in
words matches the rounded total exactly. All arithmetic in paise on the server (lib/money.js).
