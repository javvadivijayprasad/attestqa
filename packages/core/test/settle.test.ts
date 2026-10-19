import { describe, it, expect } from "vitest";
import { settleBugs, acLabels } from "../src/triage/settle.js";
import type { AnyRunEvent } from "../src/types.js";
import type { ProposedCall } from "../src/runtime/model.js";

const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };

/** A ledger whose last suite run had these per-test results. */
function finalRun(tests: Array<{ title: string; status: string }>): AnyRunEvent[] {
  const failed = tests.filter((t) => t.status === "failed").length;
  return [
    {
      ...base,
      eventId: 1,
      kind: "call",
      payload: { server: "pw", toolName: "run_tests", args: {}, startedAt: 0 },
    },
    {
      ...base,
      eventId: 2,
      kind: "observation",
      payload: {
        eventIdOfCall: 1,
        ok: true,
        result: {
          passed: tests.length - failed,
          failed,
          skipped: 0,
          green: failed === 0,
          tests,
          failures: [],
        },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as AnyRunEvent[];
}

function bug(title: string, extra: Record<string, unknown> = {}): ProposedCall {
  return {
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Bug",
      parentId: 1,
      fields: [
        { name: "System.Title", value: title },
        { name: "System.Tags", value: "agentic-qa" },
      ],
      ...extra,
    },
  };
}

let evId = 1000;
function pairEvents(
  server: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): AnyRunEvent[] {
  const id = ++evId;
  return [
    { ...base, eventId: id, kind: "call", payload: { server, toolName, args, startedAt: 0 } },
    {
      ...base,
      eventId: ++evId,
      kind: "observation",
      payload: { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as AnyRunEvent[];
}

function preflightWith(extra: Record<string, unknown>): AnyRunEvent[] {
  return pairEvents(
    "aqa",
    "story_context",
    {},
    {
      kind: "preflight",
      summary: {},
      text: "",
      facts: { acceptanceCriteria: [], bugs: [], tasks: [], ...extra },
    },
  );
}

function wroteSpec(path: string, content: string): AnyRunEvent[] {
  return pairEvents("fs", "write_file", { path, content }, { path, bytes: content.length });
}

describe("settleBugs — bugs are judged against the FINAL result", () => {
  it("drops every proposal when the suite finished green", () => {
    // Observed in 20260921T142549Z: four bugs proposed mid-run, four approved,
    // and the run finished 5/5 green. Not one should ever have been asked.
    const s = settleBugs(
      [bug("AC-1: login times out"), bug("AC-2: no error message"), bug("AC-4: no error message")],
      finalRun([
        { title: "AC-1 signs in", status: "passed" },
        { title: "AC-2 wrong password", status: "passed" },
        { title: "AC-4 unregistered", status: "passed" },
      ]),
      { workItem: "1", runLevel: null },
    );
    expect(s.keep).toHaveLength(0);
    expect(s.drop.every((d) => d.reason.includes("finished GREEN"))).toBe(true);
  });

  it("keeps a bug whose test is still failing, and drops one whose test recovered", () => {
    const s = settleBugs(
      [bug("AC-2: no error message"), bug("AC-3b: no validation message")],
      finalRun([
        { title: "AC-2 wrong password shows error", status: "failed" },
        { title: "AC-3b password touched and left empty", status: "passed" },
      ]),
      { workItem: "1", runLevel: null },
    );
    expect(s.keep.map((c) => (c.args["fields"] as Array<{ value: string }>)[0]?.value)).toEqual([
      "AC-2: no error message",
    ]);
    expect(s.drop[0]?.reason).toContain("AC-3B");
    expect(s.stillFailing).toEqual(["AC-2 wrong password shows error"]);
  });

  it("keeps a bug it cannot tie to a test, rather than claiming it recovered", () => {
    const s = settleBugs(
      [bug("Login page is slow")],
      finalRun([{ title: "AC-1 signs in", status: "failed" }]),
      { workItem: "1", runLevel: null },
    );
    expect(s.keep).toHaveLength(1);
  });

  it("drops everything when the final run measured nothing", () => {
    const s = settleBugs(
      [bug("AC-1: login broken")],
      finalRun([{ title: "AC-1 signs in", status: "failed" }]),
      { workItem: "1", runLevel: "environmental" },
    );
    expect(s.keep).toHaveLength(0);
    expect(s.drop[0]?.reason).toContain("environmental");
  });

  it("reads a Jira bug's link from storyKey, not parentId", () => {
    // 20261018T115605Z: every Jira bug was dropped as "not linked (parentId missing)".
    const failing = finalRun([{ title: "AC-1 lists products", status: "failed" }]);
    const jiraBug = (storyKey: string | undefined): ProposedCall => ({
      toolName: "jira.create_bug",
      args: {
        projectKey: "TOOL",
        summary: "AC-1: product names are empty",
        description: "x",
        ...(storyKey ? { storyKey } : {}),
      },
    });
    const linked = settleBugs([jiraBug("TOOL-6")], failing, { workItem: "TOOL-6", runLevel: null });
    expect(linked.drop.map((d) => d.reason).join(" ")).not.toContain("not linked");
    const unlinked = settleBugs([jiraBug(undefined)], failing, {
      workItem: "TOOL-6",
      runLevel: null,
    });
    expect(unlinked.drop[0]?.reason).toContain("storyKey missing");
  });

  it("refuses an unlinked or untagged bug before a human is asked", () => {
    const failing = finalRun([{ title: "AC-2 wrong password", status: "failed" }]);
    const unlinked = settleBugs([bug("AC-2: x", { parentId: undefined })], failing, {
      workItem: "1",
      runLevel: null,
    });
    expect(unlinked.drop[0]?.reason).toContain("not linked");
    const untagged = settleBugs(
      [
        {
          toolName: "ado.wit_work_item_write",
          args: {
            action: "create",
            workItemType: "Bug",
            parentId: 1,
            fields: [{ name: "System.Title", value: "AC-2: x" }],
          },
        },
      ],
      failing,
      { workItem: "1", runLevel: null },
    );
    expect(untagged.drop[0]?.reason).toContain("agentic-qa");
  });

  it("drops a proposal when the suite never finished a run", () => {
    const s = settleBugs([bug("AC-1: x")], [], { workItem: "1", runLevel: null });
    expect(s.drop[0]?.reason).toContain("never ran");
  });
});

describe("acLabels", () => {
  it("normalises the spellings the skill and the agent use", () => {
    expect(acLabels("AC-3b: thing, ac 2, AC4")).toEqual(["AC-3B", "AC-2", "AC-4"]);
    expect(acLabels("no labels here")).toEqual([]);
  });
});

describe("a bug is linked to its test by the TITLE, not by prose", () => {
  it("keeps a bug whose title names no criterion, even when the repro mentions several", () => {
    // 20260923T001438Z: the accessibility bug's "what was ruled out" paragraph
    // said AC-1 through AC-4 had passed. Reading labels out of that text made
    // the runtime think those were its tests, find them green, and drop a bug
    // whose own test was failing.
    const b: ProposedCall = {
      toolName: "ado.wit_work_item_write",
      args: {
        action: "create",
        workItemType: "Bug",
        parentId: 1,
        fields: [
          {
            name: "System.Title",
            value: "Login page fails WCAG 2 AA colour-contrast and label requirements",
          },
          { name: "System.Tags", value: "agentic-qa" },
          {
            name: "Microsoft.VSTS.TCM.ReproSteps",
            value:
              "<p>What was ruled out: all 7 other tests (AC-1 through AC-4, security) passed.</p>",
          },
        ],
      },
    };
    const events = finalRun([
      { title: "AC-1 signs in", status: "passed" },
      { title: "AC-4 unregistered email", status: "passed" },
      { title: "Accessibility — Login page has no WCAG A/AA violations", status: "failed" },
    ]);
    const s = settleBugs([b], events, { workItem: "1", runLevel: null });
    expect(s.drop).toEqual([]);
    expect(s.keep).toHaveLength(1);
  });

  it("still drops a bug whose title DOES name a criterion that passed", () => {
    const events = finalRun([
      { title: "AC-1 signs in", status: "passed" },
      { title: "AC-2 wrong password", status: "failed" },
    ]);
    const s = settleBugs([bug("AC-1: cannot sign in")], events, { workItem: "1", runLevel: null });
    expect(s.drop[0]?.reason).toContain("not failing in the final run");
  });
});

describe("a bug's account of its own test is checked against the file", () => {
  it("drops a bug that claims a scoped scan the spec does not have", () => {
    // 20260923T225303Z: the bug said the scan was "scoped to /#/login" and
    // asserted on "violations.map(v => v.id)". The spec did neither.
    const spec = [
      "  // @story:1 @design:D7",
      '  test("Accessibility", async ({ page }) => {',
      '    const results = await new AxeBuilder({ page }).withTags(["wcag2a"]).analyze();',
      "    expect(results.violations).toHaveLength(0);",
      "  });",
    ].join("\n");
    const events = [
      ...preflightWith({
        story: { id: 1, title: "L" },
        epic: { id: 42, title: "Customer account access" },
      }),
      ...wroteSpec("tests/epic-42-customer-account-access.spec.ts", spec),
      ...finalRun([{ title: "Accessibility", status: "failed" }]),
    ];
    const b = bug("Login page form elements are missing accessible labels", {
      fields: [
        { name: "System.Title", value: "Login page form elements are missing accessible labels" },
        { name: "System.Tags", value: "agentic-qa" },
        {
          name: "Microsoft.VSTS.TCM.ReproSteps",
          value:
            "<p>The scan is scoped to /#/login and the assertion is on violations.map(v =&gt; v.id).</p>",
        },
      ],
    });
    const s = settleBugs([b], events, { workItem: "1", runLevel: null });
    expect(s.keep).toHaveLength(0);
    expect(s.drop[0]?.reason).toContain("account of its own test is wrong");
  });

  it("keeps a bug whose claims the spec supports", () => {
    const spec = [
      "  // @story:1 @design:D7",
      '  test("Accessibility", async ({ page }) => {',
      '    const results = await new AxeBuilder({ page }).include("#login-form").withTags(["wcag2a"]).analyze();',
      "    expect(results.violations.map((v) => v.id)).toEqual([]);",
      "  });",
    ].join("\n");
    const events = [
      ...preflightWith({
        story: { id: 1, title: "L" },
        epic: { id: 42, title: "Customer account access" },
      }),
      ...wroteSpec("tests/epic-42-customer-account-access.spec.ts", spec),
      ...finalRun([{ title: "Accessibility", status: "failed" }]),
    ];
    const b = bug("Login form inputs lack accessible labels", {
      fields: [
        { name: "System.Title", value: "Login form inputs lack accessible labels" },
        { name: "System.Tags", value: "agentic-qa" },
        {
          name: "Microsoft.VSTS.TCM.ReproSteps",
          value: "<p>The scan is scoped and the assertion is on violations.map(v =&gt; v.id).</p>",
        },
      ],
    });
    expect(settleBugs([b], events, { workItem: "1", runLevel: null }).keep).toHaveLength(1);
  });
});

describe("one failing test, one bug — and no bug that doubts its own test", () => {
  const events = finalRun([
    { title: "Story-a — Signed-in user can log out via the account menu", status: "failed" },
    { title: "AC-1 signs in", status: "passed" },
  ]);
  const withRepro = (title: string, repro: string): ProposedCall => ({
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Bug",
      parentId: 1,
      fields: [
        { name: "System.Title", value: title },
        { name: "System.Tags", value: "agentic-qa" },
        { name: "Microsoft.VSTS.TCM.ReproSteps", value: repro },
      ],
    },
  });

  it("drops a bug whose reasoning says the locator may be wrong", () => {
    const b = withRepro(
      "Logout button not accessible in account menu",
      "<p>Confidence: Low-to-medium — the locator may not match the actual element.</p>",
    );
    const s = settleBugs([b], events, { workItem: "1", runLevel: null });
    expect(s.keep).toHaveLength(0);
    expect(s.drop[0]?.reason).toContain("doubts the test");
  });

  it("keeps one bug per failing test and drops the rest", () => {
    // 20260923T235843Z: four bugs, one failing test, all four filed.
    const three = [
      withRepro(
        "Logout option in account menu is not reachable after sign-in",
        "<p>Four selectors timed out.</p>",
      ),
      withRepro(
        "Logout option in account menu dropdown is not accessible",
        "<p>The dropdown did not expose the link.</p>",
      ),
      withRepro(
        "Logout menu item missing from account dropdown",
        "<p>No mat-menu-panel was rendered.</p>",
      ),
    ];
    const s = settleBugs(three, events, { workItem: "1", runLevel: null });
    expect(s.keep).toHaveLength(1);
    expect(s.drop).toHaveLength(2);
    expect(s.drop[0]?.reason).toContain("one bug per failing test");
  });
});

describe("bugs resting on a test this run broke (20261019T155404Z)", () => {
  const run = (tests: Array<{ title: string; status: string }>) =>
    pairEvents(
      "pw",
      "run_tests",
      { spec: "tests/e.spec.ts" },
      {
        passed: tests.filter((t) => t.status === "passed").length,
        failed: tests.filter((t) => t.status === "failed").length,
        skipped: 0,
        green: tests.every((t) => t.status === "passed"),
        tests,
        failures: tests
          .filter((t) => t.status === "failed")
          .map((t) => ({ title: t.title, message: "x" })),
      },
    );
  const T = "AC-2b Choosing page 2 shows a different set of products";
  const edit = pairEvents(
    "fs",
    "replace_in_file",
    { path: "tests/e.spec.ts", old: "a", new: "b" },
    { path: "tests/e.spec.ts", replaced: 1, changedTests: [T] },
  );

  it("drops a bug whose test passed earlier and fails only since it was edited", () => {
    const events = [
      ...run([{ title: T, status: "passed" }]),
      ...edit,
      ...run([{ title: T, status: "failed" }]),
    ];
    const s = settleBugs([bug("AC-2: page 2 shows the same products as page 1")], events, {
      workItem: "1",
      runLevel: null,
    });
    expect(s.keep).toHaveLength(0);
    expect(s.drop[0]?.reason).toContain(
      "passed earlier in this run and fails only since it was edited",
    );
  });

  it("matches a bug about AC-2 to a failing AC-2b test, and keeps one bug per failing test", () => {
    const events = [...run([{ title: T, status: "failed" }])];
    const s = settleBugs(
      [
        bug("AC-2: page 2 does not change the list"),
        bug("AC-2: pagination shows the same products"),
      ],
      events,
      { workItem: "1", runLevel: null },
    );
    expect(s.keep).toHaveLength(1);
    expect(s.drop).toHaveLength(1);
    expect(s.drop[0]?.reason).toContain("one bug per failing test");
  });
});

describe("a bug carries its test's screenshot and trace", () => {
  it("adds the final run's evidence for the failing test to a Jira bug", () => {
    const T = "AC-3 Current page control is marked as active";
    const events = pairEvents(
      "pw",
      "run_tests",
      { spec: "s" },
      {
        passed: 0,
        failed: 1,
        skipped: 0,
        green: false,
        tests: [{ title: T, status: "failed" }],
        failures: [
          {
            title: T,
            message: "x",
            screenshot: "/ws/test-results/a/test-failed-1.png",
            trace: "/ws/test-results/a/trace.zip",
          },
        ],
      },
    );
    const call: ProposedCall = {
      toolName: "jira.create_bug",
      args: {
        projectKey: "TOOL",
        storyKey: "TOOL-6",
        summary: "AC-3: page 2 control is not marked",
        description: "d",
        labels: ["agentic-qa"],
      },
    };
    const s = settleBugs([call], events, { workItem: "TOOL-6", runLevel: null });
    expect(s.keep[0]?.args["attachments"]).toEqual([
      "/ws/test-results/a/test-failed-1.png",
      "/ws/test-results/a/trace.zip",
    ]);
  });
});
