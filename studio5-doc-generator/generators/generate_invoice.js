const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType,
  ImageRun, PageBorderDisplay, PageBorderOffsetFrom, PageBorderZOrder
} = require("docx");

async function generateInvoice(payload, logoBuffer) {

function fmt(n) {
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 1000, type: WidthType.DXA },
    columnSpan: opts.span || undefined,
    shading: opts.header ? { fill: "D6E9F8", type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: !!opts.bold, size: opts.size || 20 })]
    })]
  });
}

const addr = payload.issuing_address;
const totalWidth = 10306;

// Build section tables
const sectionBlocks = [];
payload.sections.forEach((sec, si) => {
  const hasRooms = sec.has_rooms;
  const colWidths = hasRooms
    ? [500, 3400, 900, 1000, 1000, 1100, 1406]   // Sr, Particulars, UOM, Qty/Area, Rate, No.Rooms, Amount
    : [500, 4900, 1000, 1300, 1300, 1306];       // Sr, Particulars, UOM, Qty, Rate, Amount

  const headers = hasRooms
    ? ["Sr. No.", "Particulars", "UOM", "Qty/Area", "Rate", "No. of Rooms", "Amount"]
    : ["Sr. No.", "Particulars", "UOM", "Qty", "Rate", "Amount"];

  const headerRow = new TableRow({
    children: headers.map((h, i) => cell(h, { header: true, bold: true, width: colWidths[i], align: AlignmentType.CENTER }))
  });

  const itemRows = [];
  const totalCols = hasRooms ? 7 : 6;
  const fullSpanWidth = colWidths.reduce((a, b) => a + b, 0);
  const useNamedHeaderMode = !!(sec.name && sec.name.trim());

  if (useNamedHeaderMode) {
    const remainingWidth = fullSpanWidth - colWidths[0];
    itemRows.push(new TableRow({
      children: [
        cell(1, { width: colWidths[0], align: AlignmentType.CENTER }),
        new TableCell({
          columnSpan: totalCols - 1,
          width: { size: remainingWidth, type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: sec.name, bold: true, size: 20 })] })]
        }),
      ]
    }));
    sec.items.forEach((it, i) => {
      const letter = String.fromCharCode(97 + i);
      const cells = [
        cell(letter, { width: colWidths[0], align: AlignmentType.CENTER }),
        cell(it.particulars, { width: colWidths[1] }),
        cell(it.uom, { width: colWidths[2], align: AlignmentType.CENTER }),
        cell(it.qty, { width: colWidths[3], align: AlignmentType.CENTER }),
        cell(fmt(it.rate), { width: colWidths[4], align: AlignmentType.RIGHT }),
      ];
      if (hasRooms) cells.push(cell(it.rooms, { width: colWidths[5], align: AlignmentType.CENTER }));
      cells.push(cell(fmt(it.amount), { width: colWidths[hasRooms ? 6 : 5], align: AlignmentType.RIGHT }));
      itemRows.push(new TableRow({ children: cells }));
    });
    const totalRate = sec.items.reduce((sum, it) => sum + (Number(it.rate) || 0), 0);
    const preRateWidth = colWidths.slice(0, 4).reduce((a, b) => a + b, 0);
    const trailingWidth = hasRooms ? colWidths[5] + colWidths[6] : colWidths[5];
    itemRows.push(new TableRow({
      children: [
        new TableCell({
          columnSpan: 4, width: { size: preRateWidth, type: WidthType.DXA },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Total Rate per Room", bold: true, size: 20 })] })]
        }),
        cell(fmt(totalRate), { width: colWidths[4], align: AlignmentType.RIGHT, bold: true }),
        new TableCell({
          columnSpan: hasRooms ? 2 : 1, width: { size: trailingWidth, type: WidthType.DXA },
          children: [new Paragraph({ text: "" })]
        }),
      ]
    }));
  } else {
    sec.items.forEach((it, i) => {
      const cells = [
        cell(i + 1, { width: colWidths[0], align: AlignmentType.CENTER }),
        cell(it.particulars, { width: colWidths[1] }),
        cell(it.uom, { width: colWidths[2], align: AlignmentType.CENTER }),
        cell(it.qty, { width: colWidths[3], align: AlignmentType.CENTER }),
        cell(fmt(it.rate), { width: colWidths[4], align: AlignmentType.RIGHT }),
      ];
      if (hasRooms) cells.push(cell(it.rooms, { width: colWidths[5], align: AlignmentType.CENTER }));
      cells.push(cell(fmt(it.amount), { width: colWidths[hasRooms ? 6 : 5], align: AlignmentType.RIGHT }));
      itemRows.push(new TableRow({ children: cells }));
    });
  }

  const totalSpan = hasRooms ? 6 : 5;
  const totalRow = new TableRow({
    children: [
      new TableCell({
        columnSpan: totalSpan, width: { size: colWidths.slice(0, totalSpan).reduce((a,b)=>a+b,0), type: WidthType.DXA },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Sub-Total", bold: true })] })]
      }),
      cell(fmt(sec.subtotal), { width: colWidths[hasRooms ? 6 : 5], align: AlignmentType.RIGHT, bold: true })
    ]
  });

  sectionBlocks.push(new Table({ width: { size: totalWidth, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...itemRows, totalRow] }));
});

function overallTotalsRow(label, value, bold = false) {
  return new TableRow({
    children: [
      new TableCell({
        columnSpan: 1, width: { size: totalWidth - 1406, type: WidthType.DXA },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: label, bold })] })]
      }),
      cell(fmt(value), { width: 1406, align: AlignmentType.RIGHT, bold })
    ]
  });
}

const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 720, bottom: 720, left: 900, right: 900 },
        borders: {
          pageBorders: { display: PageBorderDisplay.ALL_PAGES, offsetFrom: PageBorderOffsetFrom.PAGE, zOrder: PageBorderZOrder.FRONT },
          pageBorderTop: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
          pageBorderBottom: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
          pageBorderLeft: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
          pageBorderRight: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
        }
      }
    },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "INVOICE", bold: true, size: 32 })] }),
      new Paragraph({ text: "" }),
      new Table({
        width: { size: totalWidth, type: WidthType.DXA },
        borders: { top: {style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE}, left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE}, insideHorizontal:{style:BorderStyle.NONE}, insideVertical:{style:BorderStyle.NONE} },
        rows: [
          new TableRow({ children: [
            new TableCell({ width: { size: 6000, type: WidthType.DXA }, children: [
              logoBuffer
                ? new Paragraph({ children: [new ImageRun({ data: logoBuffer, type: "png", transformation: { width: 60, height: 60 } })] })
                : new Paragraph({ text: "" }),
            ]}),
            new TableCell({ width: { size: 4306, type: WidthType.DXA }, children: [
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Invoice No.: ${payload.invoice_no || "-"}`, bold: true, size: 20 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Invoice Date: ${payload.invoice_date || "-"}`, size: 20 })] }),
            ]}),
          ]})
        ]
      }),
      new Paragraph({ children: [new TextRun({ text: addr.name, bold: true, size: 22 })] }),
      new Paragraph({ children: [new TextRun({ text: addr.line1, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: addr.line2, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `GSTIN: ${addr.gstin}   |   MSME Udyam Regn No.: ${addr.msme}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Email: ${addr.email}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Mobile: ${addr.mobile}`, size: 18 })] }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: "BUYER'S DETAILS", bold: true, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: payload.buyer.name, size: 20 })] }),
      ...payload.buyer.address.split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun({ text: line, size: 20 })] })),
      ...(payload.buyer.gstin ? [new Paragraph({ children: [new TextRun({ text: `GSTIN: ${payload.buyer.gstin}`, size: 20 })] })] : []),
      ...(payload.buyer.attn ? [new Paragraph({ children: [new TextRun({ text: `Kind Attn. ${payload.buyer.attn}`, size: 20 })] })] : []),
      new Paragraph({ text: "" }),
      ...(payload.subject ? [
        new Paragraph({ children: [new TextRun({ text: "SUBJECT", bold: true, size: 20 })] }),
        new Paragraph({ children: [new TextRun({ text: payload.subject, bold: true, size: 20 })] }),
        new Paragraph({ text: "" }),
      ] : []),
      ...sectionBlocks,
      new Paragraph({ text: "" }),
      new Table({
        width: { size: totalWidth, type: WidthType.DXA },
        borders: { top: {style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE}, left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE}, insideHorizontal:{style:BorderStyle.NONE}, insideVertical:{style:BorderStyle.NONE} },
        rows: [
          overallTotalsRow("Project Total (before GST)", payload.project_total, true),
          overallTotalsRow(`Add: GST @ ${payload.gst_pct}%`, payload.gst_amt, false),
          overallTotalsRow("GRAND TOTAL", payload.grand_total, true),
        ]
      }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: `Amount in words: ${payload.amount_in_words}`, italics: true, size: 20 })] }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: "OUR BANK ACCOUNT DETAILS", bold: true, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `Name: STUDIO5 INTERIORS PRIVATE LIMITED`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Bank's Name: ${payload.bank.name}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Account No.: ${payload.bank.account}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `IFSC Code: ${payload.bank.ifsc}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Branch: ${payload.bank.branch}`, size: 18 })] }),
      new Paragraph({ text: "" }),
      new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "For STUDIO5 INTERIORS PRIVATE LIMITED", size: 20 })] }),
      new Paragraph({ text: "" }), new Paragraph({ text: "" }),
      new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "(Authorized Signatory)", size: 18 })] }),
      new Paragraph({ text: "" }),
      ...(payload.payment_terms ? [new Paragraph({ children: [new TextRun({ text: `Payment Terms: ${payload.payment_terms}`, size: 18 })] })] : []),
      new Paragraph({ children: [new TextRun({ text: "Declaration: We declare that this Invoice shows the actual price of the goods described and that all particulars are true & correct.", size: 18 })] }),
    ]
  }]
});

return await Packer.toBuffer(doc);
}

module.exports = generateInvoice;
