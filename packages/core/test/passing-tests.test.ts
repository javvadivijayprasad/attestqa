import { describe, it, expect } from "vitest";
import { makeStoryRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

// 20261018T223256Z: AC-1 and AC-2 passed on the first run; repairing the other
// two, the agent rewrote them and broke both.
let id = 0;
function pair(server: string, toolName: string, args: Record<string, unknown>, result: unknown) {
  const c = ++id;
  return [
    {
      tool: "attestqa",
      runId: "r",
      eventId: c,
      timestamp: 1,
      kind: "call",
      payload: { server, toolName, args, startedAt: 0 },
    },
    {
      tool: "attestqa",
      runId: "r",
      eventId: ++id,
      timestamp: 1,
      kind: "observation",
      payload: { eventIdOfCall: c, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as unknown as AnyRunEvent[];
}
const PATH = "tests/epic.spec.ts";
const spec = (ac1: string, ac3: string) =>
  [
    'import { test, expect } from "@playwright/test";',
    'test("AC-1 lists products", async ({ page }) => {',
    `  await expect(${ac1}).toBeVisible();`,
    "});",
    'test("AC-3 marks the current page", async ({ page }) => {',
    `  await expect(${ac3}).toHaveClass(/active/);`,
    "});",
  ].join("\n");
const ORIGINAL = spec(
  'page.getByTestId("product-price").first()',
  'page.getByRole("button", { name: "Page-2" })',
);
const events = [
  {
    tool: "attestqa",
    runId: "r",
    eventId: 0,
    timestamp: 1,
    kind: "route",
    payload: { path: "A", reason: "", because: {}, denied: [] },
  },
  ...pair(
    "bdd2pw",
    "scaffold",
    { feature: "features/e.feature", url: "http://x" },
    { exitCode: 0 },
  ),
  ...pair("fs", "read_file", { path: PATH }, { path: PATH, content: ORIGINAL }),
  ...pair(
    "pw",
    "run_tests",
    { spec: PATH },
    {
      passed: 1,
      failed: 1,
      skipped: 0,
      green: false,
      tests: [
        { title: "AC-1 lists products", status: "passed" },
        { title: "AC-3 marks the current page", status: "failed" },
      ],
      failures: [],
    },
  ),
] as unknown as AnyRunEvent[];
const write = (content: string) =>
  makeStoryRefusal({})({ toolName: "fs.write_file", args: { path: PATH, content } }, events);

describe("a passing test is left alone while the failing ones are fixed", () => {
  it("refuses a write that changes the test that passed", () => {
    const why = write(
      spec(
        'page.locator(".card .price").first()',
        'page.getByRole("button", { name: "Page-2" }).locator("..")',
      ),
    );
    expect(why).toContain('"AC-1 lists products" passed in the last full run');
    expect(why).toContain('"AC-3 marks the current page"');
  });

  it("allows a write that changes only the failing test", () => {
    const why = write(
      spec(
        'page.getByTestId("product-price").first()',
        'page.getByRole("button", { name: "Page-2" }).locator("..")',
      ),
    );
    expect(why ?? "").not.toContain("passed in the last full run");
  });
});

describe("a failing test gets a fixed number of repairs, then goes to the reviewer", () => {
  const red = () =>
    pair(
      "pw",
      "run_tests",
      { spec: PATH },
      {
        passed: 1,
        failed: 1,
        skipped: 0,
        green: false,
        tests: [
          { title: "AC-1 lists products", status: "passed" },
          { title: "AC-3 marks the current page", status: "failed" },
        ],
        failures: [],
      },
    );
  const base = [
    {
      tool: "attestqa",
      runId: "r",
      eventId: 0,
      timestamp: 1,
      kind: "route",
      payload: { path: "A", reason: "", because: {}, denied: [] },
    },
    ...pair(
      "bdd2pw",
      "scaffold",
      { feature: "features/e.feature", url: "http://x" },
      { exitCode: 0 },
    ),
    ...pair("fs", "read_file", { path: PATH }, { path: PATH, content: ORIGINAL }),
  ] as unknown as AnyRunEvent[];
  const changeAc3 = spec(
    'page.getByTestId("product-price").first()',
    'page.locator("li.page-item").filter({ has: page.getByRole("button", { name: "Page-2" }) })',
  );

  // Each repair is a real change to AC-3's body, written as the fs adapter
  // records it (with `changedTests`) or, as in older ledgers, without.
  let k = 0;
  const repair = (recorded = true) => {
    k++;
    const content = spec(
      'page.getByTestId("product-price").first()',
      `page.locator("li.page-item").nth(${k})`,
    );
    return pair(
      "fs",
      "write_file",
      { path: PATH, content },
      { path: PATH, ...(recorded ? { changedTests: ["AC-3 marks the current page"] } : {}) },
    );
  };
  const unrelated = () =>
    pair(
      "fs",
      "replace_in_file",
      { path: "pages/catalogue.page.ts", old: "x", new: "y" },
      { path: "pages/catalogue.page.ts", replaced: 1 },
    );

  it("still allows a repair after two failed repairs", async () => {
    const { exhaustedTests } = await import("../src/triage/quarantine.js");
    const events = [...base, ...red(), ...repair(), ...red(), ...repair(false), ...red()];
    expect(exhaustedTests(events).size).toBe(0);
    const why = makeStoryRefusal({})(
      { toolName: "fs.write_file", args: { path: PATH, content: changeAc3 } },
      events,
    );
    expect(why ?? "").not.toContain("repairs. Stop changing it");
  });

  it("does not count runs set off by changes elsewhere (20261019T144404Z)", async () => {
    const { exhaustedTests } = await import("../src/triage/quarantine.js");
    const events = [
      ...base,
      ...red(),
      ...unrelated(),
      ...red(),
      ...unrelated(),
      ...red(),
      ...red(),
    ];
    expect(exhaustedTests(events).size).toBe(0);
  });

  it("refuses a fourth guess after three failed repairs", () => {
    const events = [
      ...base,
      ...red(),
      ...repair(),
      ...red(),
      ...repair(false),
      ...red(),
      ...repair(),
      ...red(),
    ];
    const why = makeStoryRefusal({})(
      { toolName: "fs.write_file", args: { path: PATH, content: changeAc3 } },
      events,
    );
    expect(why).toContain('"AC-3 marks the current page" still failed after each of 3 repairs');
  });
});

describe("a check the design never asked for is refused (item 5)", () => {
  const designed = [
    {
      tool: "attestqa",
      runId: "r",
      eventId: 0,
      timestamp: 1,
      kind: "route",
      payload: { path: "A", reason: "", because: {}, denied: [] },
    },
    ...pair(
      "aqa",
      "story_context",
      {},
      {
        kind: "preflight",
        summary: {},
        text: "",
        facts: {
          acceptanceCriteria: ["AC-1", "AC-2"],
          bugs: [],
          tasks: [],
          story: { id: "TOOL-6", title: "x" },
          epic: { id: "TOOL-1", title: "Product catalogue" },
        },
      },
    ),
    ...pair(
      "aqa",
      "test_design",
      {
        items: [
          {
            id: "D2",
            covers: "AC-2",
            type: "functional",
            technique: "state-transition",
            conditions: ["user navigates to page 2"],
            expected: "a different set of products is displayed",
            source: "AC-2",
          },
        ],
      },
      { recorded: true, items: 1 },
    ),
  ] as unknown as AnyRunEvent[];
  const feature = (then: string) =>
    [
      "Feature: Product catalogue",
      "",
      "  @story:TOOL-6 @ac:2 @design:D2",
      "  Scenario: AC-2 page 2 shows other products",
      '    When I click "Page-2"',
      `    Then ${then}`,
    ].join("\n");
  const refuse = (content: string) =>
    makeStoryRefusal({})(
      {
        toolName: "fs.write_file",
        args: { path: "features/epic-tool-1-product-catalogue.feature", content },
      },
      designed,
    );

  it("refuses an address check the design does not mention", () => {
    expect(refuse(feature('the URL contains "?page=2"'))).toContain("checks the page address");
  });

  it("allows the check the design asks for", () => {
    expect(refuse(feature("a different set of products is displayed")) ?? "").not.toContain(
      "page address",
    );
  });
});
