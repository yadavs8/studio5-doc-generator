const { TableCell, Paragraph, WidthType } = require("docx");

const EXTRA_COL_WIDTH = 900;

// Keep in sync with layoutColumnIds in studio5_doc_generator.html so the screen and the .docx agree.
// `after` is a base column id, another extra column's key, "start" (before Particulars),
// "end" (just before Amount, or last when there is no Amount) or "last" (after everything).
// An anchor that isn't in this table (e.g. Rooms in a section without rooms) falls back to "end".
function layoutColumnIds(baseIds, extraColumns) {
  const ids = baseIds.slice();
  const lastAt = {};
  (extraColumns || []).forEach(x => {
    let anchor = x.after || "end";
    if (!["start", "end", "last"].includes(anchor) && !ids.includes(anchor)) anchor = "end";
    let pos;
    if (lastAt[anchor]) pos = ids.indexOf(lastAt[anchor]) + 1;
    else if (anchor === "start") pos = Math.max(0, ids.indexOf("part"));
    else if (anchor === "end") pos = ids.includes("amount") ? ids.indexOf("amount") : ids.length;
    else if (anchor === "last") pos = ids.length;
    else pos = ids.indexOf(anchor) + 1;
    ids.splice(pos, 0, x.key);
    lastAt[anchor] = x.key;
  });
  return ids;
}

function layoutColumns(baseCols, extraColumns, { shrinkId = "part", minWidth = 1400 } = {}) {
  const extras = Array.isArray(extraColumns) ? extraColumns : [];
  const byId = {};
  baseCols.forEach(c => { byId[c.id] = { ...c }; });
  if (byId[shrinkId]) {
    byId[shrinkId].width = Math.max(minWidth, byId[shrinkId].width - extras.length * EXTRA_COL_WIDTH);
  }
  extras.forEach(x => {
    byId[x.key] = {
      id: x.key,
      label: x.label,
      width: EXTRA_COL_WIDTH,
      extra: true,
      value: it => {
        const v = it && it.extra ? it.extra[x.key] : "";
        return v == null ? "" : v;
      },
    };
  });
  return layoutColumnIds(baseCols.map(c => c.id), extras).map(id => byId[id]);
}

function spanWidth(cols, from, to) {
  return cols.slice(from, to).reduce((a, c) => a + c.width, 0);
}

function blankCells(cols, from) {
  if (from >= cols.length) return [];
  return [new TableCell({
    columnSpan: cols.length - from,
    width: { size: spanWidth(cols, from), type: WidthType.DXA },
    children: [new Paragraph({ text: "" })],
  })];
}

module.exports = { EXTRA_COL_WIDTH, layoutColumnIds, layoutColumns, spanWidth, blankCells };
