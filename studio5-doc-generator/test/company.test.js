const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isStudio5Gstin, findBank, stateName } = require("../lib/company.js");

test("only Studio5's own GSTINs are accepted as issuer", () => {
  assert.equal(isStudio5Gstin("06ABICS6962P1ZG"), true);
  assert.equal(isStudio5Gstin(" 07abics6962p1ze "), true);
  assert.equal(isStudio5Gstin("06XXXXX0000X1Z5"), false);
});

test("only Studio5's own bank accounts can be printed", () => {
  assert.equal(findBank({ account: "50200120135932" }).ifsc, "HDFC0003676");
  assert.equal(findBank({ account: "99999999" }), null);
  assert.equal(findBank(null), null);
});

test("state names for place of supply", () => {
  assert.equal(stateName("06"), "Haryana");
  assert.equal(stateName("07"), "Delhi");
});
