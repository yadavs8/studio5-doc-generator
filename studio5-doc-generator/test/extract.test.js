const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractItems, parseModelJson } = require("../lib/extract.js");

test("model output wrapped in code fences or chatter is still read", () => {
  assert.deepEqual(parseModelJson('```json\n{"sections":[]}\n```'), { sections: [] });
  assert.deepEqual(parseModelJson('Here you go: {"sections":[]} thanks'), { sections: [] });
  assert.throws(() => parseModelJson("no json here"), { status: 502 });
});

test("the key travels in a header, unsupported files and missing keys are refused", async () => {
  let seen;
  const fake = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"sections":[{"section_name":"Hall","items":[{"particulars":"Ceiling","uom":"sqft","qty":"400","rate":null},{"particulars":""}]}]}' }] } }] }) }; };
  const out = await extractItems({ image: "aGVsbG8=", mimeType: "image/png" }, "KEY123", fake);
  assert.equal(seen.url.includes("KEY123"), false);
  assert.equal(seen.init.headers["x-goog-api-key"], "KEY123");
  assert.deepEqual(out, { sections: [{ section_name: "Hall", items: [{ particulars: "Ceiling", uom: "sqft", qty: 400, rate: null }] }] });
  await assert.rejects(extractItems({ image: "aGVsbG8=", mimeType: "text/html" }, "K", fake), { status: 400 });
  await assert.rejects(extractItems({ image: "aGVsbG8=" }, null, fake), { status: 400 });
});

test("no internet gives a clear message", async () => {
  const offline = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(extractItems({ image: "aGVsbG8=", mimeType: "image/png" }, "K", offline), (e) => e.status === 503 && /internet/.test(e.message));
});
