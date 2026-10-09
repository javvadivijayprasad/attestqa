import { describe, it, expect } from "vitest";
import {
  parseDesign,
  validateDesign,
  traceProblems,
  scenarioDesignTags,
  specMarkers,
  renderDesign,
  type StoryFacts,
} from "../src/design/test-design.js";
import { makeStoryRefusal } from "../src/skills/story-rules.js";
import { renderApproval } from "../src/runtime/render-approval.js";
import type { AnyRunEvent } from "../src/types.js";

const FACTS: StoryFacts = {
  acceptanceCriteria: ["AC-1", "AC-2", "AC-3", "AC-4"],
  bugs: [
    { id: 48, state: "Active", title: "Error message persists" },
    { id: 49, state: "New", title: "Whitespace in password" },
    { id: 50, state: "Resolved", title: "Session token survives logout" },
  ],
  tasks: [45, 46, 47],
};
const ALL = ["functional", "security", "accessibility", "confirmation"] as const;

const item = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: "functional",
  technique: "equivalence-partitioning",
  conditions: ["x"],
  expected: "y",
  source: "AC-1",
  ...over,
});

const GOOD = {
  items: [
    item({ id: "D1", covers: "AC-1", technique: "state-transition" }),
    item({ id: "D2", covers: "AC-2", source: "AC-2" }),
    item({ id: "D3", covers: "AC-3a", technique: "boundary-value-analysis", source: "AC-3" }),
    item({ id: "D4", covers: "AC-4", source: "AC-4" }),
    item({
      id: "D5",
      covers: "AC-4",
      type: "security",
      technique: "equivalence-partitioning",
      source: "AC-4",
    }),
    item({
      id: "D6",
      covers: "story",
      type: "accessibility",
      technique: "checklist-based",
      source: "comment",
    }),
    item({
      id: "D7",
      covers: "bug #48",
      type: "confirmation",
      technique: "state-transition",
      source: "bug #48",
      expectFail: true,
    }),
    item({
      id: "D8",
      covers: "bug #50",
      type: "confirmation",
      technique: "state-transition",
      source: "bug #50",
    }),
  ],
  excluded: [{ what: "bug #49", reason: "New: an unconfirmed claim" }],
};

describe("validateDesign — checked against what stage 1 read", () => {
  it("accepts a complete design", () => {
    expect(validateDesign(parseDesign(GOOD), FACTS, ALL)).toEqual([]);
  });

  it("requires expectFail on an Active bug's test", () => {
    const d = parseDesign({
      ...GOOD,
      items: GOOD.items.map((i) => (i["id"] === "D7" ? { ...i, expectFail: false } : i)),
    });
    expect(validateDesign(d, FACTS, ALL).join("\n")).toContain("bug #48 is Active");
  });

  it("refuses an expectation with no source — the logout-URL mistake", () => {
    const d = parseDesign({
      ...GOOD,
      items: [...GOOD.items, item({ id: "D9", covers: "AC-1", source: "it usually does" })],
    });
    expect(validateDesign(d, FACTS, ALL).join("\n")).toContain(
      "names no criterion, task, bug or comment",
    );
  });

  it("requires every criterion, bug and in-scope type to be accounted for", () => {
    const d = parseDesign({ items: [item({ id: "D1", covers: "AC-1" })], excluded: [] });
    const p = validateDesign(d, FACTS, ALL).join("\n");
    expect(p).toContain("AC-2 has no functional test");
    expect(p).toContain("bug #49 [New] is neither tested nor listed");
    expect(p).toContain('{"what": "bug #49", "reason": "<why not>"}');
    expect(p).toContain('test type "security" is in scope but has no item');
  });

  it("reads an exclusion written for a reader, not for a parser", () => {
    // 20260922T230624Z: the design DID exclude bug #49, with a good reason,
    // and was sent back six times because the text carried the bug's title.
    const d = parseDesign({
      ...GOOD,
      items: GOOD.items.filter((i) => i["covers"] !== "bug #50"),
      excluded: [
        {
          what: "bug #49 [New] — Leading and trailing whitespace in the password",
          reason: "an unconfirmed claim",
        },
        {
          what: "bug #50 (Resolved) — session token survives logout",
          reason: "belongs to the Logout story",
        },
      ],
    });
    expect(validateDesign(d, FACTS, ALL)).toEqual([]);
  });

  it("lets an accessibility item name the config as its source", () => {
    const d = parseDesign({
      ...GOOD,
      items: GOOD.items.map((i) =>
        i["id"] === "D6" ? { ...i, source: "agent.test_types (WCAG A/AA)" } : i,
      ),
    });
    expect(validateDesign(d, FACTS, ALL)).toEqual([]);
  });

  it("accepts a type left out with a reason", () => {
    const d = parseDesign({
      items: GOOD.items.filter((i) => i["type"] !== "accessibility"),
      excluded: [
        ...GOOD.excluded,
        { what: "accessibility testing — not this sprint", reason: "axe not installed" },
      ],
    });
    expect(validateDesign(d, FACTS, ALL)).toEqual([]);
  });

  it("refuses items for unknown criteria, bugs, and types out of scope", () => {
    const d = parseDesign({
      ...GOOD,
      items: [
        ...GOOD.items,
        item({ id: "D9", covers: "AC-7", source: "AC-7" }),
        item({ id: "D10", covers: "bug #99", type: "confirmation", source: "bug #99" }),
      ],
    });
    const p = validateDesign(d, FACTS, [
      "functional",
      "security",
      "accessibility",
      "confirmation",
    ]).join("\n");
    expect(p).toContain("covers AC-7, which is not one of the story's criteria");
    expect(p).toContain("bug #99, which is not one of the open bugs");
    const q = validateDesign(parseDesign(GOOD), FACTS, ["functional", "confirmation"]).join("\n");
    expect(q).toContain('type "security" is not in scope');
  });
});

describe("tracing the tests on disk to the design", () => {
  const feature = [
    "Feature: Login",
    "  @ac:1 @design:D1",
    "  Scenario: AC-1 signs in",
    "    When x",
    "  @ac:1 @bug:48 @design:D7",
    "  Scenario: bug 48 error clears",
    "    When y",
    "  @ac:2",
    "  Scenario: AC-2 untagged",
  ].join("\n");

  it("reads design tags per scenario", () => {
    expect(scenarioDesignTags(feature).map((s) => s.designs)).toEqual([["D1"], ["D7"], []]);
  });

  it("finds whether the test under each tag carries test.fail", () => {
    const spec = [
      "  // @ac:1 @design:D1",
      '  test("AC-1", async () => {});',
      "  // @ac:1 @bug:48 @design:D7",
      '  test("bug 48", async () => { test.fail(true, "Bug #48 Active"); });',
    ].join("\n");
    expect([...specMarkers(spec)]).toEqual([
      ["D1", false],
      ["D7", true],
    ]);
  });

  it("reports untested items, untagged scenarios, and an unmarked Active-bug test", () => {
    const d = parseDesign(GOOD);
    const spec = "  // @design:D7\n  test('bug 48', async () => {});";
    const t = traceProblems(
      d,
      [{ path: "features/login.feature", text: feature }],
      [{ path: "tests/l.spec.ts", text: spec }],
    );
    expect(t.untested).toContain("D2 (AC-2)");
    expect(t.untagged).toEqual(['features/login.feature: "AC-2 untagged"']);
    expect(t.unmarked).toEqual(["D7 (bug #48)"]);
  });
});

describe("design-first, enforced before the call", () => {
  const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
  let n = 100;
  const pair = (
    server: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
  ): AnyRunEvent[] => {
    const id = ++n;
    return [
      { ...base, eventId: id, kind: "call", payload: { server, toolName, args, startedAt: 0 } },
      {
        ...base,
        eventId: ++n,
        kind: "observation",
        payload: { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 },
      },
    ] as AnyRunEvent[];
  };
  const preflight = pair(
    "aqa",
    "story_context",
    {},
    { kind: "preflight", summary: {}, text: "", facts: FACTS },
  );
  const refuse = makeStoryRefusal({ testTypes: ALL });

  it("refuses to RUN the suite before a design is approved", () => {
    // A spec left on disk by an earlier run let the whole design step be
    // skipped (20260923T230115Z).
    expect(
      refuse({ toolName: "pw.run_tests", args: { spec: "tests/x.spec.ts" } }, preflight),
    ).toContain("no test design has been approved yet");
  });

  it("refuses a feature file, a scaffold or a test case before a design is approved", () => {
    expect(
      refuse(
        { toolName: "fs.write_file", args: { path: "features/login.feature", content: "" } },
        preflight,
      ),
    ).toContain("no test design has been approved yet");
    expect(refuse({ toolName: "bdd2pw.scaffold", args: { feature: "f" } }, preflight)).toContain(
      "no test design",
    );
    expect(
      refuse(
        { toolName: "ado.testplan_test_case_write", args: { action: "create", title: "AC-1" } },
        preflight,
      ),
    ).toContain("no test design");
  });

  it("sends back a design with problems, listing them, before anyone is asked", () => {
    const r = refuse(
      { toolName: "aqa.test_design", args: { items: [item({ id: "D1", covers: "AC-1" })] } },
      preflight,
    );
    expect(r).toContain("problem(s)");
    expect(r).toContain("AC-2 has no functional test");
  });

  it("lets a valid design through, and writes after it is recorded", () => {
    expect(refuse({ toolName: "aqa.test_design", args: GOOD }, preflight)).toBeUndefined();
    const after = [...preflight, ...pair("aqa", "test_design", GOOD, { recorded: true, items: 8 })];
    expect(refuse({ toolName: "bdd2pw.scaffold", args: { feature: "f" } }, after)).toBeUndefined();
  });

  it("without test types in scope, there is no design stage", () => {
    expect(
      makeStoryRefusal({})({ toolName: "bdd2pw.scaffold", args: { feature: "f" } }, []),
    ).toBeUndefined();
  });
});

describe("the design at the approval prompt", () => {
  it("reads as one line per test, with type, technique, expectation and source", () => {
    const out = renderApproval([{ toolName: "aqa.test_design", args: GOOD }]);
    expect(out).toContain("Approve: 1 test design");
    expect(out).toContain(
      "TEST DESIGN — 8 item(s): functional 4 · security 1 · accessibility 1 · confirmation 2",
    );
    expect(out).toContain(
      "D7 bug #48 — confirmation, state-transition — EXPECTED TO FAIL (Active bug)",
    );
    expect(out).toContain("bug #49 — New: an unconfirmed claim");
    expect(renderDesign(parseDesign(GOOD)).some((l) => l.includes("(from AC-2)"))).toBe(true);
  });
});

describe("one file per epic, tagged by story", () => {
  const facts = {
    ...FACTS,
    story: { id: 1, title: "Login with valid credentials" },
    epic: { id: 42, title: "Customer account access" },
  };

  it("names the feature and spec after the epic", async () => {
    const { featurePathFor, specPathFor } = await import("../src/design/test-design.js");
    expect(featurePathFor(facts)).toBe("features/epic-42-customer-account-access.feature");
    expect(specPathFor(facts)).toBe("tests/epic-42-customer-account-access.spec.ts");
  });

  it("reads which story each scenario belongs to", async () => {
    const { scenarioStoryTags, storiesIn } = await import("../src/design/test-design.js");
    const feature = [
      "Feature: Customer account access",
      "  @story:1 @ac:1 @design:D1",
      "  Scenario: AC-1 signs in",
      "  @story:44 @ac:1",
      "  Scenario: AC-1 logs out",
    ].join("\n");
    expect(scenarioStoryTags(feature).map((s) => s.stories)).toEqual([[1], [44]]);
    expect([...storiesIn(feature)]).toEqual([1, 44]);
  });

  it("picks one story's test titles out of the shared spec", async () => {
    const { storyTestTitles } = await import("../src/design/test-design.js");
    const spec = [
      "  // @story:1 @ac:1",
      '  test("AC-1 signs in", async () => {});',
      "  // @story:44 @ac:1",
      '  test("AC-1 logs out", async () => {});',
    ].join("\n");
    expect([...storyTestTitles(spec, 1)]).toEqual(["AC-1 signs in"]);
    expect([...storyTestTitles(spec, 44)]).toEqual(["AC-1 logs out"]);
  });
});

describe("a story with no acceptance criteria", () => {
  const FACTS_NO_AC = { ...FACTS, acceptanceCriteria: [] };
  const derived = (over: Record<string, unknown> = {}) => ({
    id: "D1",
    covers: "story",
    type: "functional",
    technique: "state-transition",
    conditions: ["signed-in user clicks Logout"],
    expected: "the session ends and the token is removed",
    source: "story description",
    ...over,
  });

  it("lets the design cover the story and cite its description", () => {
    const d = parseDesign({
      items: [derived()],
      excluded: [
        { what: "bug #48", reason: "another story" },
        { what: "bug #49", reason: "unconfirmed" },
        { what: "bug #50", reason: "tested elsewhere" },
        { what: "security", reason: "nothing implied" },
        { what: "accessibility", reason: "not this run" },
        { what: "confirmation", reason: "no bug applies" },
      ],
    });
    expect(validateDesign(d, FACTS_NO_AC, ALL)).toEqual([]);
  });

  it("still refuses an expectation with no written source", () => {
    const d = parseDesign({
      items: [derived({ source: "it usually works that way" })],
      excluded: [],
    });
    expect(validateDesign(d, FACTS_NO_AC, ALL).join("\n")).toContain("names no criterion");
  });

  it("still wants at least one functional test", () => {
    const d = parseDesign({
      items: [
        derived({
          type: "accessibility",
          technique: "checklist-based",
          source: "agent.test_types (WCAG A/AA)",
        }),
      ],
      excluded: [],
    });
    expect(validateDesign(d, FACTS_NO_AC, ALL).join("\n")).toContain(
      "at least one functional item",
    );
  });

  it("warns the reviewer at the top of the prompt", () => {
    const out = renderApproval([
      { toolName: "aqa.test_design", args: { items: [derived()], excluded: [] } },
    ]);
    expect(out).toContain("THIS STORY HAS NO ACCEPTANCE CRITERIA");
  });
});

describe("a state-transition test proves the action happened", () => {
  it("wants an assertion for the action as well as for the state", async () => {
    const { shapeProblems } = await import("../src/design/test-design.js");
    const item = {
      id: "D1-44",
      covers: "story",
      type: "functional" as const,
      technique: "state-transition" as const,
      conditions: ["signed in"],
      expected: "token cleared",
      source: "story description",
    };
    const onlyTheState = 'await page.click("#logout"); expect(token).toBeNull();';
    expect(shapeProblems(item, onlyTheState).join(" ")).toContain("at least two assertions");
    const both =
      'await page.click("#logout"); await expect(page).toHaveURL(/#\\//); expect(token).toBeNull();';
    expect(shapeProblems(item, both)).toEqual([]);
  });
});

describe("a test may not catch its own failure", () => {
  it("flags a try/catch fallback around an action", async () => {
    const { shapeProblems } = await import("../src/design/test-design.js");
    const item = {
      id: "D1-44",
      covers: "story",
      type: "functional" as const,
      technique: "state-transition" as const,
      conditions: ["signed in"],
      expected: "logged out",
      source: "story description",
    };
    const withFallback =
      'try { await link.click(); } catch { await page.goto("/#/logout"); } await expect(page).toHaveURL(/#\\//); expect(token).toBeNull();';
    expect(shapeProblems(item, withFallback).join(" ")).toContain("catches its own failure");
  });
});
