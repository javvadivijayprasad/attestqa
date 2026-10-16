// The Copilot relay's translation, without VS Code: what the engine sends in,
// what goes back, and that the token check holds.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toPrompt, toResponse, sameToken, estimateTokens } = require("../out/copilotWire.js");

const engineRequest = {
  model: "gpt-4.1",
  messages: [
    { role: "system", content: "You are the attestqa runtime." },
    { role: "user", content: "# Request\n\nWrite tests for SHOP-1" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "fs__read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    },
  ],
  tool_choice: "auto",
};

test("one message to Copilot, system text first; tools passed through", () => {
  const p = toPrompt(engineRequest);
  assert.equal(p.family, "gpt-4.1");
  assert.equal(p.text, "You are the attestqa runtime.\n\n# Request\n\nWrite tests for SHOP-1");
  assert.deepEqual(p.tools, [
    { name: "fs__read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ]);
  assert.equal(p.requireTool, false);
  assert.equal(toPrompt({ ...engineRequest, model: "auto" }).family, undefined);
  assert.throws(() => toPrompt({ messages: [] }), /no message text/);
});

test("Copilot's tool calls come back as the engine reads them, usage marked estimated", () => {
  const r = toResponse("gpt-4.1", "Reading the story.", [{ callId: "c1", name: "fs__read_file", input: { path: "a.feature" } }], 400);
  const msg = r.choices[0].message;
  assert.equal(msg.content, "Reading the story.");
  assert.deepEqual(msg.tool_calls, [{ id: "c1", type: "function", function: { name: "fs__read_file", arguments: '{"path":"a.feature"}' } }]);
  assert.equal(r.choices[0].finish_reason, "tool_calls");
  assert.equal(r.usage.estimated, true);
  assert.equal(r.usage.prompt_tokens, estimateTokens(400));
  assert.equal(toResponse("gpt-4.1", "Done.", [], 10).choices[0].finish_reason, "stop");
});

test("only this run's token is accepted", () => {
  assert.equal(sameToken("Bearer abc123", "abc123"), true);
  assert.equal(sameToken("Bearer abc124", "abc123"), false);
  assert.equal(sameToken("abc123", "abc123"), false);
  assert.equal(sameToken(undefined, "abc123"), false);
});
