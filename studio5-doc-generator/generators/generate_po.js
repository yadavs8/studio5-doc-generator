const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, HeadingLevel,
  ImageRun, PageBorderDisplay, PageBorderOffsetFrom, PageBorderZOrder
} = require("docx");

async function generatePO(payload, logoBuffer, stampBuffer) {

const TERMS = [
["1. Payment Terms", true],
["1.1 Payment shall be released strictly as per the schedule mentioned in the Purchase Order (e.g., 50% advance along with PO confirmation, balance 50% against delivery/before dispatch), unless otherwise agreed in writing.", false],
["1.2 All payments shall be made only against a valid GST tax invoice raised in the name of the Buyer, bearing correct HSN codes, GSTIN, and PO reference number.", false],
["1.3 Any advance paid shall be treated strictly as an advance against supply and shall be adjusted in the final invoice; it does not constitute part-payment for any other order.", false],
["1.4 In case of rejection of material due to quality/quantity mismatch, the Buyer reserves the right to withhold payment to the extent of the value of rejected goods until replacement/credit note is issued.", false],
["1.5 No price escalation shall be payable by the Buyer unless specifically agreed in writing prior to dispatch.", false],
["1.6 TDS, if applicable, shall be deducted at source as per prevailing Income Tax provisions.", false],
["2. Quality", true],
["2.1 All material supplied must strictly conform to the specifications, brand, grade, thickness, finish, and make mentioned in the Purchase Order/approved sample/BOQ.", false],
["2.2 Plywood, MDF, and board material must carry valid ISI/BIS marking and moisture-resistance grade (e.g., BWP/BWR) as specified, along with the manufacturer's warranty card.", false],
["2.3 Laminates, hardware fittings (hinges, channels, handles), and accessories shall match the approved sample/catalogue code; no substitution of brand or grade is permitted without prior written approval from the Buyer.", false],
["2.4 The Buyer/its quality team reserves the right to inspect the material at the vendor's premises before dispatch and/or at the site upon delivery, and to reject any material not conforming to the agreed quality standard.", false],
["2.5 Any material rejected on account of quality shall be replaced by the Supplier at its own cost within the timeline specified by the Buyer, without any additional charge or price revision.", false],
["2.6 The Supplier shall provide a standard manufacturer's warranty (as applicable to the product category) against manufacturing defects.", false],
["3. Quantity", true],
["3.1 The Supplier shall deliver the exact quantity mentioned in the Purchase Order. No excess or short supply is permitted without prior written consent of the Buyer.", false],
["3.2 A tolerance of up to \u00b12% (or as mutually agreed) may be accepted only for bulk/running-length items (e.g., laminate sheets, edge banding rolls); this tolerance does not apply to counted items such as hardware, hinges, or fixed units.", false],
["3.3 In case of short supply, the value of the short-supplied quantity shall be deducted from the invoice/payment, and the balance quantity shall be supplied within the agreed delivery period at no extra freight cost to the Buyer.", false],
["3.4 In case of excess supply without prior approval, the Buyer reserves the right to return the excess quantity at the Supplier's cost.", false],
["4. Delivery Time", true],
["4.1 Delivery shall be made strictly within the timeline mentioned in the Purchase Order. Time is the essence of this contract.", false],
["4.2 The Supplier shall promptly intimate the Buyer in case of any anticipated delay, along with reasons, at least 3 days in advance.", false],
["4.3 In case of delay attributable to the Supplier, the Buyer reserves the right to: a) levy a delay/liquidated damages charge of 0.5% of the PO value per week of delay (subject to a maximum cap of 5%), and/or b) cancel the undelivered portion of the order and procure the same from an alternate source, with any resulting price difference recoverable from the Supplier.", false],
["4.4 Delay caused by Force Majeure events (natural calamity, strike, lockdown, government restriction, etc.) shall be excluded, provided the Supplier notifies the Buyer in writing within 3 working days of such event.", false],
["5. Freight & Transit", true],
["5.1 Unless otherwise specified in the PO, all deliveries shall be made on a Freight-On-Road (FOR) Site/Warehouse basis, i.e., freight, loading, and unloading charges shall be borne by the Supplier and included in the quoted price.", false],
["5.2 The Supplier shall ensure adequate packaging (corner protection, water-proof wrapping, edge protection for boards/laminates) suitable for safe transit; any damage in transit due to improper packing shall be the Supplier's responsibility.", false],
["5.3 Risk in the goods shall pass to the Buyer only upon acceptance of material in good condition at the delivery site, duly verified against the delivery challan.", false],
["5.4 The Supplier shall provide a proper delivery challan/e-way bill (wherever applicable) mentioning PO number, item description, and quantity, along with each dispatch.", false],
["5.5 Any transit damage or shortage must be reported by the Buyer within 48 hours of delivery, and the Supplier shall replace the damaged/short material at no extra cost, including freight.", false],
["6. General", true],
["6.1 This Purchase Order is governed by the laws of India, and any dispute shall be subject to the exclusive jurisdiction of courts at Gurugram, Haryana.", false],
["6.2 The Supplier shall not sub-contract the order, in part or full, without prior written consent of the Buyer.", false],
["6.3 The Buyer reserves the right to cancel the Purchase Order, wholly or partly, at any time before dispatch by giving written notice, without any liability other than payment for goods already dispatched/received.", false],
];

function fmt(n) {
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 1000, type: WidthType.DXA },
    shading: opts.header ? { fill: "D6E9F8", type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: !!opts.bold, size: opts.size || 20 })]
    })]
  });
}

const colWidths = [500, 3200, 900, 700, 700, 900, 1200]; // Sr, Particulars, HSN, UOM, Qty, Rate, Amount
const totalWidth = colWidths.reduce((a, b) => a + b, 0);

function totalsRow(label, value, bold = false) {
  return new TableRow({
    children: [
      new TableCell({
        columnSpan: 6, width: { size: colWidths.slice(0, 6).reduce((a, b) => a + b, 0), type: WidthType.DXA },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: label, bold })] })]
      }),
      cell(fmt(value), { width: colWidths[6], align: AlignmentType.RIGHT, bold })
    ]
  });
}

const tableBlocks = [];

if (payload.sections && Array.isArray(payload.sections) && payload.sections.length > 0) {
  payload.sections.forEach((sec, si) => {
    const secHeaderRow = new TableRow({
      children: ["Sr. No.", "Particulars", "HSN/SAC", "UOM", "Qty", "Rate", "Amount"].map((h, i) =>
        cell(h, { header: true, bold: true, width: colWidths[i], align: AlignmentType.CENTER })
      )
    });

    const secRows = [secHeaderRow];
    const hasName = sec.name && sec.name.trim();

    if (hasName) {
      // Section header row spanning columns
      secRows.push(new TableRow({
        children: [
          cell(si + 1, { width: colWidths[0], align: AlignmentType.CENTER, bold: true }),
          new TableCell({
            columnSpan: 6,
            width: { size: colWidths.slice(1).reduce((a, b) => a + b, 0), type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: sec.name, bold: true, size: 20 })] })]
          })
        ]
      }));

      (sec.items || []).forEach((it, i) => {
        const letter = String.fromCharCode(97 + i);
        secRows.push(new TableRow({
          children: [
            cell(letter, { width: colWidths[0], align: AlignmentType.CENTER }),
            cell(it.particulars, { width: colWidths[1] }),
            cell(it.hsn || "9403", { width: colWidths[2], align: AlignmentType.CENTER }),
            cell(it.uom || "nos", { width: colWidths[3], align: AlignmentType.CENTER }),
            cell(it.qty, { width: colWidths[4], align: AlignmentType.CENTER }),
            cell(fmt(it.rate), { width: colWidths[5], align: AlignmentType.RIGHT }),
            cell(fmt(it.amount), { width: colWidths[6], align: AlignmentType.RIGHT }),
          ]
        }));
      });

      const secTotal = (sec.items || []).reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
      secRows.push(new TableRow({
        children: [
          new TableCell({
            columnSpan: 6,
            width: { size: colWidths.slice(0, 6).reduce((a, b) => a + b, 0), type: WidthType.DXA },
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Sub-Total (${sec.name})`, bold: true, size: 20 })] })]
          }),
          cell(fmt(secTotal), { width: colWidths[6], align: AlignmentType.RIGHT, bold: true })
        ]
      }));
    } else {
      (sec.items || []).forEach((it, i) => {
        secRows.push(new TableRow({
          children: [
            cell(i + 1, { width: colWidths[0], align: AlignmentType.CENTER }),
            cell(it.particulars, { width: colWidths[1] }),
            cell(it.hsn || "9403", { width: colWidths[2], align: AlignmentType.CENTER }),
            cell(it.uom || "nos", { width: colWidths[3], align: AlignmentType.CENTER }),
            cell(it.qty, { width: colWidths[4], align: AlignmentType.CENTER }),
            cell(fmt(it.rate), { width: colWidths[5], align: AlignmentType.RIGHT }),
            cell(fmt(it.amount), { width: colWidths[6], align: AlignmentType.RIGHT }),
          ]
        }));
      });
    }

    tableBlocks.push(new Table({
      width: { size: 10306, type: WidthType.DXA },
      columnWidths: colWidths,
      rows: secRows
    }));
    tableBlocks.push(new Paragraph({ text: "" }));
  });

  tableBlocks.push(new Table({
    width: { size: 10306, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      totalsRow("Sub-Total", payload.sub_total, true),
      totalsRow(`Add: GST @ ${payload.gst_pct}%`, payload.gst_amt, false),
      totalsRow("GRAND TOTAL", payload.grand_total, true),
    ]
  }));
} else {
  const headerRow = new TableRow({
    children: ["Sr. No.", "Particulars", "HSN/SAC", "UOM", "Qty", "Rate", "Amount"].map((h, i) =>
      cell(h, { header: true, bold: true, width: colWidths[i], align: AlignmentType.CENTER })
    )
  });

  const itemRows = (payload.items || []).map((it, i) => new TableRow({
    children: [
      cell(i + 1, { width: colWidths[0], align: AlignmentType.CENTER }),
      cell(it.particulars, { width: colWidths[1] }),
      cell(it.hsn || "9403", { width: colWidths[2], align: AlignmentType.CENTER }),
      cell(it.uom || "nos", { width: colWidths[3], align: AlignmentType.CENTER }),
      cell(it.qty, { width: colWidths[4], align: AlignmentType.CENTER }),
      cell(fmt(it.rate), { width: colWidths[5], align: AlignmentType.RIGHT }),
      cell(fmt(it.amount), { width: colWidths[6], align: AlignmentType.RIGHT }),
    ]
  }));

  tableBlocks.push(new Table({
    width: { size: 10306, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      headerRow,
      ...itemRows,
      totalsRow("Sub-Total", payload.sub_total, true),
      totalsRow(`Add: GST @ ${payload.gst_pct}%`, payload.gst_amt, false),
      totalsRow("GRAND TOTAL", payload.grand_total, true),
    ]
  }));
}

const addr = payload.issuing_address;

const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 720, bottom: 720, left: 900, right: 900 },
        borders: {
          pageBorders: {
            display: PageBorderDisplay.ALL_PAGES,
            offsetFrom: PageBorderOffsetFrom.PAGE,
            zOrder: PageBorderZOrder.FRONT,
          },
          pageBorderTop: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
          pageBorderBottom: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
          pageBorderLeft: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
          pageBorderRight: { style: BorderStyle.SINGLE, size: 18, color: "000000", space: 24 },
        },
      }
    },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "PURCHASE ORDER", bold: true, size: 32 })] }),
      new Paragraph({ text: "" }),
      new Table({
        width: { size: 10306, type: WidthType.DXA },
        borders: { top: {style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE}, left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE}, insideHorizontal:{style:BorderStyle.NONE}, insideVertical:{style:BorderStyle.NONE} },
        rows: [
          new TableRow({ children: [
            new TableCell({ width: { size: 6000, type: WidthType.DXA }, children: [
              logoBuffer
                ? new Paragraph({ children: [new ImageRun({ data: logoBuffer, type: "png", transformation: { width: 60, height: 60 } })] })
                : new Paragraph({ text: "" }),
            ]}),
            new TableCell({ width: { size: 4306, type: WidthType.DXA }, children: [
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `PO No.: ${payload.po_no || "-"}`, bold: true, size: 20 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `PO Date: ${payload.po_date || "-"}`, size: 20 })] }),
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
      new Paragraph({ children: [new TextRun({ text: "VENDOR / SUPPLIER DETAILS", bold: true, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `Vendor Name: ${payload.vendor.name}`, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `Address: ${payload.vendor.address}`, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `GSTIN: ${payload.vendor.gstin}`, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `Contact Person / Mobile: ${payload.vendor.contact}`, size: 20 })] }),
      new Paragraph({ text: "" }),
      ...(payload.subject ? [
        new Paragraph({ children: [new TextRun({ text: "SUBJECT", bold: true, size: 20 })] }),
        new Paragraph({ children: [new TextRun({ text: payload.subject, bold: true, size: 20 })] }),
        new Paragraph({ text: "" }),
      ] : []),
      new Paragraph({ children: [new TextRun({ text: "DELIVER TO (SITE ADDRESS)", bold: true, size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: `Site / Project: ${payload.site}`, size: 20 })] }),
      ...tableBlocks,
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: `Amount in words: ${payload.amount_in_words}`, italics: true, size: 20 })] }),
      new Paragraph({ text: "" }),
      new Paragraph({ children: [new TextRun({ text: "TERMS & CONDITIONS", bold: true, size: 22 })] }),
      ...TERMS.map(([t, bold]) => new Paragraph({ children: [new TextRun({ text: t, bold, size: 18 })], spacing: { after: 60 } })),
      new Paragraph({ text: "" }),
      new Table({
        width: { size: 10306, type: WidthType.DXA },
        borders: { top: {style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE}, left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE}, insideHorizontal:{style:BorderStyle.NONE}, insideVertical:{style:BorderStyle.NONE} },
        rows: [ new TableRow({ children: [
          new TableCell({ width: { size: 5153, type: WidthType.DXA }, children: [
            new Paragraph({ children: [new TextRun({ text: `For ${addr.name}`, size: 20 })] }),
            stampBuffer
              ? new Paragraph({
                  children: [
                    new ImageRun({
                      data: stampBuffer,
                      type: "png",
                      transformation: { width: 90, height: 84 }
                    })
                  ]
                })
              : new Paragraph({ text: "" }),
            new Paragraph({ children: [new TextRun({ text: "(Authorized Signatory)", size: 18 })] }),
          ]}),
          new TableCell({ width: { size: 5153, type: WidthType.DXA }, children: [
            new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Accepted by Supplier", size: 20 })] }),
            new Paragraph({ text: "" }), new Paragraph({ text: "" }),
            new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "(Signature & Stamp)", size: 18 })] }),
          ]}),
        ]})]
      }),
    ]
  }]
});

return await Packer.toBuffer(doc);
}

module.exports = generatePO;