const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, ImageRun
} = require("docx");
const { layoutColumns, spanWidth } = require("../lib/columnLayout.js");

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
const cols = layoutColumns([
  { id: "sr", label: "S.NO.", width: 900, align: AlignmentType.CENTER },
  { id: "part", label: "PARTICULARS", width: 3706, value: it => it.particulars },
  { id: "length", label: "LENGTH (mm)", width: 1200, align: AlignmentType.CENTER, value: it => it.length || "" },
  { id: "breadth", label: "BREADTH (mm)", width: 1200, align: AlignmentType.CENTER, value: it => it.breadth || "" },
  { id: "height", label: "HEIGHT (mm)", width: 1200, align: AlignmentType.CENTER, value: it => it.height || "" },
  { id: "qty", label: "QTY", width: 900, align: AlignmentType.CENTER, value: it => it.qty || "" },
  { id: "unit", label: "UNIT", width: 1200, align: AlignmentType.CENTER, value: it => it.unit || "" },
], payload.extra_columns, { minWidth: 1600 });
const colWidths = cols.map(c => c.width);
const qtyIdx = cols.findIndex(c => c.id === "qty");

const headerRow = new TableRow({
  children: cols.map(c => cell(c.label, { header: true, bold: true, width: c.width, align: AlignmentType.CENTER }))
});

const itemRows = payload.items.map((it, i) => new TableRow({
  children: cols.map(c => cell(c.id === "sr" ? i + 1 : c.value(it), {
    width: c.width,
    align: c.extra ? AlignmentType.CENTER : c.align,
  }))
}));

const totalRow = new TableRow({
  children: [
    new TableCell({
      columnSpan: qtyIdx, width: { size: spanWidth(cols, 0, qtyIdx), type: WidthType.DXA },
      children: [new Paragraph({ children: [new TextRun({ text: "TOTAL QUANTITY", bold: true })] })]
    }),
    ...cols.slice(qtyIdx).map(c => {
      if (c.id === "qty") return cell(payload.total_qty, { width: c.width, align: AlignmentType.CENTER, bold: true });
      if (c.id === "unit") return cell(payload.unit_label || "PCS / SET", { width: c.width, align: AlignmentType.CENTER, bold: true });
      return cell("", { width: c.width });
    }),
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