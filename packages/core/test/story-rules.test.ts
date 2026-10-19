import { describe, it, expect } from "vitest";
import { storyRefusal, coveredCriteria } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
let n = 0;
function pair(
  server: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): AnyRunEvent[] {
  const callId = ++n;
  return [
    { ...base, eventId: callId, kind: "call", payload: { server, toolName, args, startedAt: 0 } },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: { eventIdOfCall: callId, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as AnyRunEvent[];
}

/** The preflight's read of the story's existing test cases. */
const existingCases = pair(
  "ado",
  "wit_work_item",
  { action: "get_batch", ids: [65, 66] },
  {
    value: [
      { id: 65, fields: { "System.WorkItemType": "Test Case", "System.Title": "AC-1: signs in" } },
      {
        id: 66,
        fields: { "System.WorkItemType": "Test Case", "System.Title": "AC-2: wrong password" },
      },
    ],
  },
);

// Tagged, because an untagged case is refused on its own account (see
// tags.test.ts); these tests are about the duplicate rule.
const create = (title: string) => ({
  toolName: "ado.testplan_test_case_write",
  args: { action: "create", title, testsWorkItemId: 1, tags: "agentic-qa" },
});

describe("one test case per acceptance criterion — enforced on state", () => {
  it("refuses a case for a criterion that already has one", () => {
    // Four criteria collected 35-38, 59-62, 65-68 and then 69-72: the
    // verifier checked that existing cases were READ, never that they were not
    // duplicated.
    const reason = storyRefusal(
      create("AC-2: wrong password keeps user on login page"),
      existingCases,
    );
    expect(reason).toContain("AC-2 already has test case #66");
  });

  it("allows a case for a criterion nobody has covered yet", () => {
    expect(
      storyRefusal(create("AC-3: button disabled while empty"), existingCases),
    ).toBeUndefined();
  });

  it("counts cases created earlier in the same run", () => {
    const events = pair(
      "ado",
      "testplan_test_case_write",
      { action: "create", title: "AC-4: unknown email" },
      { id: 72 },
    );
    expect(storyRefusal(create("AC-4: unregistered email"), events)).toContain("#72");
  });

  it("does not refuse a case whose title names no criterion", () => {
    expect(storyRefusal(create("Smoke: login page loads"), existingCases)).toBeUndefined();
  });

  it("reads coverage from what the run saw, and ignores non-test-case items", () => {
    const withBug = [
      ...existingCases,
      ...pair(
        "ado",
        "wit_work_item",
        { action: "get_batch", ids: [48] },
        {
          value: [
            {
              id: 48,
              fields: { "System.WorkItemType": "Bug", "System.Title": "AC-3: error persists" },
            },
          ],
        },
      ),
    ];
    expect([...coveredCriteria(withBug).keys()].sort()).toEqual(["AC-1", "AC-2"]);
  });
});

describe("the run report is the runtime's to post", () => {
  it("refuses a run report the agent tries to post itself", () => {
    // Observed in 20260921T192908Z: the agent's report went up mid-run, the
    // verifier sent it back for another attempt, and the story carried a
    // report of a run that had not finished.
    const reason = storyRefusal(
      {
        toolName: "ado.wit_work_item_comment_write",
        args: { action: "add", workItemId: 1, text: "## agentic-qa run `x`\n..." },
      },
      [],
    );
    expect(reason).toContain("the runtime posts the run report itself");
  });

  it("leaves any other comment to the gate", () => {
    expect(
      storyRefusal(
        {
          toolName: "ado.wit_work_item_comment_write",
          args: { action: "add", workItemId: 1, text: "Question for the PO" },
        },
        [],
      ),
    ).toBeUndefined();
  });
});

describe("spec provenance and known-bug markers — enforced before the write", () => {
  const write = (content: string) => ({
    toolName: "fs.write_file",
    args: { path: "tests/login.spec.ts", content },
  });

  it("refuses a hand-written spec before anything was scaffolded", () => {
    expect(storyRefusal(write("test('x', () => {})"), [])).toContain("bdd2pw.scaffold first");
  });

  it("allows the spec write once bdd2pw has scaffolded", () => {
    const events = pair(
      "bdd2pw",
      "scaffold",
      { feature: "features/login.feature" },
      { exitCode: 0 },
    );
    expect(storyRefusal(write("test('x', () => {})"), events)).toBeUndefined();
  });

  it("does not touch writes that are not specs", () => {
    expect(
      storyRefusal(
        { toolName: "fs.write_file", args: { path: "pages/login.page.ts", content: "" } },
        [],
      ),
    ).toBeUndefined();
  });

  it("refuses a write that removes test.fail from a known bug's test", () => {
    const events = [
      ...pair("bdd2pw", "scaffold", { feature: "f" }, { exitCode: 0 }),
      ...pair(
        "fs",
        "read_file",
        { path: "tests/login.spec.ts" },
        {
          path: "tests/login.spec.ts",
          content: 'test("AC-2b", () => { test.fail(true, "Bug #48"); });',
        },
      ),
    ];
    expect(storyRefusal(write('test("AC-2b", () => {});'), events)).toContain(
      "expected-to-fail marker",
    );
    expect(
      storyRefusal(
        write('test("AC-2b", () => { test.fail(true, "Bug #48"); /* edited */ });'),
        events,
      ),
    ).toBeUndefined();
  });

  it("does not compare against content a later scaffold replaced", () => {
    const events = [
      ...pair(
        "fs",
        "read_file",
        { path: "tests/login.spec.ts" },
        {
          path: "tests/login.spec.ts",
          content: 'test.fail(true, "x");',
        },
      ),
      ...pair("bdd2pw", "scaffold", { feature: "f" }, { exitCode: 0 }),
    ];
    expect(storyRefusal(write("test('x', () => {})"), events)).toBeUndefined();
  });
});

describe("a file is read once", () => {
  const read = (path: string) => ({ toolName: "fs.read_file", args: { path } });

  it("refuses a second read of an unchanged file — the loop that ate a run", () => {
    const events = pair(
      "fs",
      "read_file",
      { path: "tests/login.spec.ts" },
      { path: "tests/login.spec.ts", content: "x" },
    );
    expect(storyRefusal(read("tests/login.spec.ts"), events)).toContain("already read");
    expect(storyRefusal(read("pages/login.page.ts"), events)).toBeUndefined();
  });

  it("allows it again once something changed the file", () => {
    const written = [
      ...pair("fs", "read_file", { path: "a.ts" }, { path: "a.ts", content: "x" }),
      ...pair("fs", "write_file", { path: "a.ts", content: "y" }, { path: "a.ts", bytes: 1 }),
    ];
    expect(storyRefusal(read("a.ts"), written)).toBeUndefined();
    const scaffolded = [
      ...pair("fs", "read_file", { path: "b.spec.ts" }, { path: "b.spec.ts", content: "x" }),
      ...pair("bdd2pw", "scaffold", { feature: "f" }, { exitCode: 0 }),
    ];
    expect(storyRefusal(read("b.spec.ts"), scaffolded)).toBeUndefined();
  });
});

describe("a file is written, then run — not rewritten", () => {
  const write = (path: string, content: string) => ({
    toolName: "fs.write_file",
    args: { path, content },
  });
  const wrote = (path: string, content: string) =>
    pair("fs", "write_file", { path, content }, { path, bytes: content.length });

  it("refuses a write that changes nothing", () => {
    const events = wrote("pages/login.page.ts", "same");
    expect(storyRefusal(write("pages/login.page.ts", "same"), events)).toContain(
      "exactly as it already is",
    );
  });

  it("refuses the fourth write of one file with nothing run in between", () => {
    // 20260922T232710Z: 45 writes of one page object, the suite never ran.
    const events = [1, 2, 3].flatMap((i) => wrote("pages/login.page.ts", `v${i}`));
    expect(storyRefusal(write("pages/login.page.ts", "v4"), events)).toContain(
      "without running anything",
    );
    // Another file is untouched by this rule.
    expect(storyRefusal(write("pages/other.page.ts", "v1"), events)).toBeUndefined();
  });

  it("starts counting again once the suite has run", () => {
    const events = [
      ...[1, 2, 3].flatMap((i) => wrote("a.ts", `v${i}`)),
      ...pair("pw", "run_tests", {}, { passed: 1, failed: 1, green: false }),
    ];
    expect(storyRefusal(write("a.ts", "v4"), events)).toBeUndefined();
  });
});

describe("one feature file per epic, shared by its stories", () => {
  const FACTS = {
    acceptanceCriteria: ["AC-1"],
    bugs: [],
    tasks: [],
    story: { id: 1, title: "Login with valid credentials" },
    epic: { id: 42, title: "Customer account access" },
  };
  const context = pair(
    "aqa",
    "story_context",
    {},
    { kind: "preflight", summary: {}, text: "", facts: FACTS },
  );
  const design = pair("aqa", "test_design", { items: [] }, { recorded: true });
  const base = [...context, ...design];
  const FEATURE = "features/epic-42-customer-account-access.feature";
  const SPEC = "tests/epic-42-customer-account-access.spec.ts";
  const scenario = (story: number, name: string) =>
    `  @story:${story} @ac:1\n  Scenario: ${name}\n    When x\n`;

  it("refuses a feature or spec written anywhere else", () => {
    expect(
      storyRefusal(
        { toolName: "fs.write_file", args: { path: "features/login.feature", content: "" } },
        base,
      ),
    ).toContain(FEATURE);
    expect(
      storyRefusal(
        { toolName: "bdd2pw.scaffold", args: { feature: "features/login.feature" } },
        base,
      ),
    ).toContain(FEATURE);
    expect(
      storyRefusal(
        {
          toolName: "fs.write_file",
          args: { path: FEATURE, content: scenario(1, "AC-1 signs in") },
        },
        base,
      ),
    ).toBeUndefined();
  });

  it("refuses a write that drops another story's scenarios", () => {
    const before = "Feature: x\n" + scenario(1, "AC-1 signs in") + scenario(44, "AC-1 logs out");
    const events = [
      ...base,
      ...pair("fs", "write_file", { path: FEATURE, content: before }, { path: FEATURE, bytes: 1 }),
    ];
    const without44 =
      "Feature: x\n" + scenario(1, "AC-1 signs in") + scenario(1, "AC-2 wrong password");
    expect(
      storyRefusal(
        { toolName: "fs.write_file", args: { path: FEATURE, content: without44 } },
        events,
      ),
    ).toContain("belonging to another story");
    const keeps44 = before + scenario(1, "AC-2 wrong password");
    expect(
      storyRefusal(
        { toolName: "fs.write_file", args: { path: FEATURE, content: keeps44 } },
        events,
      ),
    ).toBeUndefined();
  });

  it("refuses a scenario with no @story tag", () => {
    const content = "Feature: x\n  @ac:1\n  Scenario: AC-1 signs in\n    When x\n";
    expect(
      storyRefusal({ toolName: "fs.write_file", args: { path: FEATURE, content } }, base),
    ).toContain("no @story tag");
  });

  it("makes the run execute the epic's spec, not everything", () => {
    expect(storyRefusal({ toolName: "pw.run_tests", args: {} }, base)).toContain(SPEC);
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: "tests/login.spec.ts" } }, base),
    ).toContain(SPEC);
    expect(storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC } }, base)).toBeUndefined();
  });
});

describe("the feature file comes first", () => {
  const FACTS = {
    acceptanceCriteria: ["AC-1"],
    bugs: [],
    tasks: [],
    story: { id: 1, title: "Login" },
    epic: { id: 42, title: "Customer account access" },
  };
  const base = pair(
    "aqa",
    "story_context",
    {},
    { kind: "preflight", summary: {}, text: "", facts: FACTS },
  );
  const FEATURE = "features/epic-42-customer-account-access.feature";

  it("refuses a page object written before anything was scaffolded", () => {
    // 20260923T001438Z: a page object left by a killed run had empty locators,
    // and the agent mended it instead of writing the scenarios.
    const r = storyRefusal(
      { toolName: "fs.write_file", args: { path: "pages/login.page.ts", content: "x" } },
      base,
    );
    expect(r).toContain(FEATURE);
    expect(r).toContain("about to be overwritten");
  });

  it("allows the feature file itself, and everything once the scaffold has run", () => {
    const content = "Feature: x\n  @story:1 @ac:1\n  Scenario: AC-1 signs in\n    When x\n";
    expect(
      storyRefusal({ toolName: "fs.write_file", args: { path: FEATURE, content } }, base),
    ).toBeUndefined();
    const after = [...base, ...pair("bdd2pw", "scaffold", { feature: FEATURE }, { exitCode: 0 })];
    expect(
      storyRefusal(
        { toolName: "fs.write_file", args: { path: "pages/login.page.ts", content: "x" } },
        after,
      ),
    ).toBeUndefined();
  });
});

describe("a bug is linked and tagged before anyone is asked", () => {
  const FACTS = {
    acceptanceCriteria: ["AC-1"],
    bugs: [],
    tasks: [],
    story: { id: 1, title: "Login" },
    epic: { id: 42, title: "Customer account access" },
  };
  const events = pair(
    "aqa",
    "story_context",
    {},
    { kind: "preflight", summary: {}, text: "", facts: FACTS },
  );
  const propose = (
    fields: Array<{ name: string; value: string }>,
    extra: Record<string, unknown> = {},
  ) => ({
    toolName: "ado.wit_work_item_write",
    args: { action: "create", workItemType: "Bug", fields, ...extra },
  });
  const titleAndTag = [
    { name: "System.Title", value: "Login form inputs lack labels" },
    { name: "System.Tags", value: "agentic-qa" },
  ];

  it("refuses a bug with no link to the story — 20260923T230833Z lost one that way", () => {
    const r = storyRefusal(propose(titleAndTag), events);
    expect(r).toContain("parentId: 1");
  });

  it("refuses a bug with no agent tag", () => {
    const r = storyRefusal(
      propose([{ name: "System.Title", value: "x" }], { parentId: 1 }),
      events,
    );
    expect(r).toContain("agentic-qa");
  });

  it("lets a linked, tagged bug through", () => {
    expect(storyRefusal(propose(titleAndTag, { parentId: 1 }), events)).toBeUndefined();
  });
});

describe("the run that finishes the job is the whole suite", () => {
  const FACTS = {
    acceptanceCriteria: ["AC-1"],
    bugs: [],
    tasks: [],
    story: { id: 44, title: "Log out" },
    epic: { id: 42, title: "Customer account access" },
  };
  const events = [
    ...pair("aqa", "story_context", {}, { kind: "preflight", summary: {}, text: "", facts: FACTS }),
    ...pair("aqa", "test_design", { items: [] }, { recorded: true }),
  ];
  const SPEC = "tests/epic-42-customer-account-access.spec.ts";

  it("allows a filtered run while working — it is simply never the finishing one", () => {
    // Rerunning the one test you just repaired is sensible. What changed is
    // that the report and the bug decision use the last UNFILTERED run.
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC, grep: "Story-a" } }, events),
    ).toBeUndefined();
  });

  it("allows the unfiltered suite", () => {
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC } }, events),
    ).toBeUndefined();
  });
});

describe("a heal changes the locator, not the claim", () => {
  const quarantine = (title: string): AnyRunEvent[] =>
    [
      {
        tool: "agentic-qa" as const,
        runId: "r",
        timestamp: 1,
        eventId: 900,
        kind: "triage",
        payload: {
          attempt: 1,
          reportFingerprint: "f",
          runLevel: null,
          verdicts: [
            {
              test: `l.spec.ts › suite › ${title}`,
              category: "real-defect",
              confidence: 0.6,
              evidence: "x",
              rationale: "y",
            },
          ],
          quarantined: [`l.spec.ts › suite › ${title}`],
        },
      },
    ] as AnyRunEvent[];

  const specWith = (locator: string, assertion: string) =>
    `// @story:44\ntest("Story-a — logout", async ({ page }) => {\n  await page.locator("${locator}").click();\n  expect(token, "msg").${assertion};\n});\n`;

  const write = (content: string) => ({
    toolName: "fs.write_file",
    args: { path: "tests/l.spec.ts", content },
  });

  const scaffolded = pair("bdd2pw", "scaffold", { feature: "f" }, { exitCode: 0 });

  it("allows the selector to change", () => {
    const events = [
      ...scaffolded,
      ...pair(
        "fs",
        "write_file",
        { path: "tests/l.spec.ts", content: specWith("a[href='#/logout']", "toBeNull()") },
        { path: "tests/l.spec.ts", bytes: 1 },
      ),
      ...quarantine("Story-a — logout"),
    ];
    expect(
      storyRefusal(write(specWith("role=menuitem[name='Logout']", "toBeNull()")), events),
    ).toBeUndefined();
  });

  it("refuses a changed assertion on a quarantined test", () => {
    const events = [
      ...scaffolded,
      ...pair(
        "fs",
        "write_file",
        { path: "tests/l.spec.ts", content: specWith("x", "toBeNull()") },
        { path: "tests/l.spec.ts", bytes: 1 },
      ),
      ...quarantine("Story-a — logout"),
    ];
    const r = storyRefusal(write(specWith("x", "toBeTruthy()")), events);
    expect(r).toContain("not yours to soften");
  });

  it("refuses deleting a quarantined test", () => {
    const events = [
      ...scaffolded,
      ...pair(
        "fs",
        "write_file",
        { path: "tests/l.spec.ts", content: specWith("x", "toBeNull()") },
        { path: "tests/l.spec.ts", bytes: 1 },
      ),
      ...quarantine("Story-a — logout"),
    ];
    expect(storyRefusal(write("// nothing left\n"), events)).toContain("this write removes it");
  });
});
