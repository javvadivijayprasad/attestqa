// Runs against the compiled output: `npm test` compiles first.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseStoryRef, requestFor } = require("../out/story.js");

test("a Jira key means Jira, upper-cased", () => {
  assert.deepEqual(parseStoryRef(" scrum-6 "), { tracker: "jira", key: "SCRUM-6", label: "SCRUM-6" });
  assert.equal(requestFor(parseStoryRef("SHOP-12")), "Write tests for SHOP-12");
});

test("a number means Azure DevOps, in the forms aqa accepts", () => {
  for (const raw of ["123", "#123", "AB#123", "ab#123"])
    assert.deepEqual(parseStoryRef(raw), { tracker: "ado", id: 123, label: "AB#123" });
  assert.equal(requestFor(parseStoryRef("123")), "Write tests for AB#123");
});

test("anything else is refused before aqa is started", () => {
  for (const raw of ["", "SHOP", "12-SHOP", "write tests", "SHOP-12; rm -rf /"])
    assert.equal(parseStoryRef(raw), undefined);
});
