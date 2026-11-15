# 0004 — Financial year comes from the document date (IST)

Status: accepted (technical; GST sequential numbering is per financial year of the invoice)

A tax invoice's FY (and so its number series) is the FY of its invoice date, Apr–Mar, read as an Indian
calendar date — never the server clock (Render runs in UTC).
