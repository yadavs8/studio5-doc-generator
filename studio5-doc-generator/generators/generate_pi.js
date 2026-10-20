const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType,
  ImageRun, PageBorderDisplay, PageBorderOffsetFrom, PageBorderZOrder
} = require("docx");
const { layoutColumns, spanWidth, blankCells } = require("../lib/columnLayout.js");

async function generatePI(payload, logoBuffer, stampBuffer) {

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
const extraColumns = Array.isArray(payload.extra_columns) ? payload.extra_columns : [];

// Build section tables
const sectionBlocks = [];
payload.sections.forEach((sec, si) => {
  const hasRooms = sec.has_rooms;
  const baseCols = hasRooms
    ? [
        { id: "sr", label: "Sr. No.", width: 500, align: AlignmentType.CENTER },
        { id: "part", label: "Particulars", width: 3400, value: it => it.particulars },
        { id: "qty", label: "Qty/Area", width: 1000, align: AlignmentType.CENTER, value: it => it.qty },
        { id: "uom", label: "UOM", width: 900, align: AlignmentType.CENTER, value: it => it.uom },
        { id: "rate", label: "Rate", width: 1000, align: AlignmentType.RIGHT, value: it => fmt(it.rate) },
        { id: "rooms", label: "No. of Rooms", width: 1100, align: AlignmentType.CENTER, value: it => it.rooms },
        { id: "amount", label: "Amount", width: 1406, align: AlignmentType.RIGHT, value: it => fmt(it.amount) },
      ]
    : [
        { id: "sr", label: "Sr. No.", width: 500, align: AlignmentType.CENTER },
        { id: "part", label: "Particulars", width: 4900, value: it => it.particulars },
        { id: "qty", label: "Qty", width: 1300, align: AlignmentType.CENTER, value: it => it.qty },
        { id: "uom", label: "UOM", width: 1000, align: AlignmentType.CENTER, value: it => it.uom },
        { id: "rate", label: "Rate", width: 1300, align: AlignmentType.RIGHT, value: it => fmt(it.rate) },
        { id: "amount", label: "Amount", width: 1306, align: AlignmentType.RIGHT, value: it => fmt(it.amount) },
      ];
  const cols = layoutColumns(baseCols, extraColumns);
  const colWidths = cols.map(c => c.width);
  const amountIdx = cols.findIndex(c => c.id === "amount");
  const rateIdx = cols.findIndex(c => c.id === "rate");

  const headerRow = new TableRow({
    children: cols.map(c => cell(c.label, { header: true, bold: true, width: c.width, align: AlignmentType.CENTER }))
  });

  function itemRow(it, srText) {
    return new TableRow({
      children: cols.map(c => cell(c.id === "sr" ? srText : c.value(it), {
        width: c.width,
        align: c.extra ? AlignmentType.CENTER : c.align,
      }))
    });
  }

  const itemRows = [];
  const useNamedHeaderMode = !!(sec.name && sec.name.trim());

  if (useNamedHeaderMode) {
    // Row "1" = the section name itself, spanning the full width (bold)
    itemRows.push(new TableRow({
      children: [
        cell(1, { width: colWidths[0], align: AlignmentType.CENTER }),
        new TableCell({
          columnSpan: cols.length - 1,
          width: { size: spanWidth(cols, 1), type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: sec.name, bold: true, size: 20 })] })]
        }),
      ]
    }));
    // Items become lettered sub-rows: a, b, c, d...
    sec.items.forEach((it, i) => itemRows.push(itemRow(it, String.fromCharCode(97 + i))));
    // Total Rate per Room row (sum of the lettered items' rates)
    const totalRate = sec.items.reduce((sum, it) => sum + (Number(it.rate) || 0), 0);
    itemRows.push(new TableRow({
      children: [
        new TableCell({
          columnSpan: rateIdx, width: { size: spanWidth(cols, 0, rateIdx), type: WidthType.DXA },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Total Rate per Room", bold: true, size: 20 })] })]
        }),
        cell(fmt(totalRate), { width: colWidths[rateIdx], align: AlignmentType.RIGHT, bold: true }),
        ...blankCells(cols, rateIdx + 1),
      ]
    }));
  } else {
    // No section name — plain flat numbering, no header row, no Total Rate row
    sec.items.forEach((it, i) => itemRows.push(itemRow(it, i + 1)));
  }

  function makeTotalRow(label, value, bold = false, size) {
    return new TableRow({
      children: [
        new TableCell({
          columnSpan: amountIdx,
          width: { size: spanWidth(cols, 0, amountIdx), type: WidthType.DXA },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: label, bold, size })] })]
        }),
        cell(fmt(value), { width: colWidths[amountIdx], align: AlignmentType.RIGHT, bold }),
        ...blankCells(cols, amountIdx + 1),
      ]
    });
  }

  const totalRow = makeTotalRow("Sub-Total", sec.subtotal, true);

  const isLastSection = si === payload.sections.length - 1;
  const attachedTotals = [];
  if (isLastSection) {
    attachedTotals.push(makeTotalRow("Project Total (before GST)", payload.project_total, true, 20));
    attachedTotals.push(makeTotalRow(`Add: GST @ ${payload.gst_pct}%`, payload.gst_amt, false, 20));
    if (payload.round_off) {
      attachedTotals.push(makeTotalRow("Round off", Math.abs(payload.round_off), false, 20));
    }
    attachedTotals.push(makeTotalRow("GRAND TOTAL", payload.grand_total, true, 20));
  }

  // No separate heading paragraph above the table — the name (if any) is now row "1" itself.
  sectionBlocks.push(new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...itemRows, totalRow, ...attachedTotals]
  }));
});

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
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "PROFORMA INVOICE", bold: true, size: 32 })] }),
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
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `P.I. No.: ${payload.pi_no || "-"}`, bold: true, size: 20 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `P.I. Date: ${payload.pi_date || "-"}`, size: 20 })] }),
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
      new Paragraph({ children: [new TextRun({ text: `Amount in words: ${payload.amount_in_words}`, italics: true, size: 20 })] }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: "OUR BANK ACCOUNT DETAILS", bold: true, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `Name: STUDIO5 INTERIORS PRIVATE LIMITED`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Bank's Name: ${payload.bank.name}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Account No.: ${payload.bank.account}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `IFSC Code: ${payload.bank.ifsc}`, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: `Branch: ${payload.bank.branch}`, size: 18 })] }),
      new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "For STUDIO5 INTERIORS PRIVATE LIMITED", size: 20 })] }),
      stampBuffer
        ? new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new ImageRun({
                data: stampBuffer,
                type: "png",
                transformation: { width: 90, height: 84 }
              })
            ]
          })
        : new Paragraph({ text: "" }),
      new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "(Authorized Signatory)", size: 18 })] }),
      new Paragraph({ text: "" }),
      ...(payload.payment_terms ? [new Paragraph({ children: [new TextRun({ text: `Payment Terms: ${payload.payment_terms}`, size: 18 })] })] : []),
      new Paragraph({ children: [new TextRun({ text: "Declaration: We declare that this Proforma Invoice shows the actual price of the goods described and that all particulars are true & correct.", size: 18 })] }),
    ]
  }]
});

return await Packer.toBuffer(doc);
}

module.exports = generatePI;
