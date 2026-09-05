const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, ImageRun
} = require("docx");

async function generateChallan(payload, logoBuffer, stampBuffer) {

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
const colWidths = [900, 3706, 1200, 1200, 1200, 900, 1200]; // Sr, Particulars, L, B, H, Qty, Unit

const headerRow = new TableRow({
  children: ["S.NO.", "PARTICULARS", "LENGTH (mm)", "BREADTH (mm)", "HEIGHT (mm)", "QTY", "UNIT"].map((h, i) =>
    cell(h, { header: true, bold: true, width: colWidths[i], align: AlignmentType.CENTER })
  )
});

const itemRows = payload.items.map((it, i) => new TableRow({
  children: [
    cell(i + 1, { width: colWidths[0], align: AlignmentType.CENTER }),
    cell(it.particulars, { width: colWidths[1] }),
    cell(it.length || "", { width: colWidths[2], align: AlignmentType.CENTER }),
    cell(it.breadth || "", { width: colWidths[3], align: AlignmentType.CENTER }),
    cell(it.height || "", { width: colWidths[4], align: AlignmentType.CENTER }),
    cell(it.qty || "", { width: colWidths[5], align: AlignmentType.CENTER }),
    cell(it.unit || "", { width: colWidths[6], align: AlignmentType.CENTER }),
  ]
}));

const totalRow = new TableRow({
  children: [
    new TableCell({
      columnSpan: 5, width: { size: colWidths.slice(0,5).reduce((a,b)=>a+b,0), type: WidthType.DXA },
      children: [new Paragraph({ children: [new TextRun({ text: "TOTAL QUANTITY", bold: true })] })]
    }),
    cell(payload.total_qty, { width: colWidths[5], align: AlignmentType.CENTER, bold: true }),
    cell(payload.unit_label || "PCS / SET", { width: colWidths[6], align: AlignmentType.CENTER, bold: true }),
  ]
});

const materialLines = (payload.material_info || "").split(/\r?\n/).filter(l => l.trim());

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, bottom: 720, left: 900, right: 900 } } },
    children: [
      new Table({
        width: { size: totalWidth, type: WidthType.DXA },
        borders: { top: {style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE}, left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE}, insideHorizontal:{style:BorderStyle.NONE}, insideVertical:{style:BorderStyle.NONE} },
        rows: [
          new TableRow({ children: [
            new TableCell({ width: { size: 6000, type: WidthType.DXA }, children: [
              new Paragraph({ children: [new TextRun({ text: addr.name, bold: true, size: 22 })] }),
              new Paragraph({ children: [new TextRun({ text: addr.line1, size: 20 })] }),
              new Paragraph({ children: [new TextRun({ text: addr.line2, size: 20 })] }),
            ]}),
            new TableCell({ width: { size: 4306, type: WidthType.DXA }, children: [
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Challan No.: ${payload.challan_no || "-"}`, bold: true, size: 20 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Date: ${payload.challan_date || "-"}`, size: 20 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Vehicle No.: ${payload.vehicle_no || "-"}`, size: 20 })] }),
            ]}),
          ]})
        ]
      }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: "RECEIVER DETAILS", bold: true, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: payload.receiver_name, size: 20 })] }),
      ...payload.site_address.split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun({ text: line, size: 20 })] })),
      new Paragraph({ text: "" }),
      ...(payload.subject ? [
        new Paragraph({ children: [
          new TextRun({ text: "SUBJECT   ", bold: true, size: 20 }),
          new TextRun({ text: payload.subject, bold: true, size: 20 })
        ]}),
        new Paragraph({ text: "" }),
      ] : []),
      ...(materialLines.length ? [
        new Paragraph({ children: [new TextRun({ text: "MATERIAL INFORMATION", bold: true, size: 20 })] }),
        ...materialLines.map(line => new Paragraph({ children: [new TextRun({ text: line, size: 18 })] })),
        new Paragraph({ text: "" }),
      ] : []),
      new Table({ width: { size: totalWidth, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...itemRows, totalRow] }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: `FOR ${addr.name}`, bold: true, size: 20 })] }),
      new Paragraph({ text: "" }),
      new Table({
        width: { size: totalWidth, type: WidthType.DXA },
        borders: { top: {style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE}, left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE}, insideHorizontal:{style:BorderStyle.NONE}, insideVertical:{style:BorderStyle.NONE} },
        rows: [
          new TableRow({ children: [
            cell("CHECKED BY", { bold: true, width: 3435 }),
            cell("RECEIVED BY", { bold: true, width: 3435 }),
            cell("AUTHORIZED SIGNATORY", { bold: true, width: 3436 }),
          ]}),
          new TableRow({ children: [
            cell("Name / Signature: __________________", { width: 3435, size: 18 }),
            cell("Name / Signature: __________________", { width: 3435, size: 18 }),
            stampBuffer
              ? new TableCell({
                  width: { size: 3436, type: WidthType.DXA },
                  children: [
                    new Paragraph({
                      children: [
                        new ImageRun({
                          data: stampBuffer,
                          type: "png",
                          transformation: { width: 85, height: 79 }
                        })
                      ]
                    })
                  ]
                })
              : cell("Name / Signature: __________________", { width: 3436, size: 18 }),
          ]}),
          new TableRow({ children: [
            cell("Date: __________________", { width: 3435, size: 18 }),
            cell("Date: __________________", { width: 3435, size: 18 }),
            cell("Date: __________________", { width: 3436, size: 18 }),
          ]}),
        ]
      }),
    ]
  }]
});

return await Packer.toBuffer(doc);
}

module.exports = generateChallan;