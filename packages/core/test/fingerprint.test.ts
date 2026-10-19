import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestPriorDesign, readRuns, storyFingerprint } from "../src/design/fingerprint.js";
import { approvedDesign, type StoryFacts } from "../src/design/test-design.js";
import { storyToTestsSkill } from "../src/skills/story-to-tests.js";
import { StageTracker } from "../src/runtime/stages.js";
import type { AnyRunEvent } from "../src/types.js";

// Item 7 (docs/ENGINE_MAP.md §11): a story that has not changed since the run
// whose design a person approved keeps that design; the rerun only executes.

const FACTS: StoryFacts = {
  acceptanceCriteria: ["AC-1: valid credentials sign the customer in"],
  bugs: [],
  tasks: [],
  story: { id: "SCRUM-6", title: "Login" },
  epic: { id: "SCRUM-5", title: "Customer account access" },
};
const FEATURE = [
  "Feature: Customer account access",
  "",
  "  @story:SCRUM-6 @ac:1 @design:D1 @type:functional",
  "  Scenario: AC-1: Valid credentials sign the customer in",
  '    When I sign in as "jim"',
].join("\n");
const SPEC = [
  'import { test, expect } from "@playwright/test";',
  "// @story:SCRUM-6 @ac:1 @design:D1",
  'test("AC-1: Valid credentials sign the customer in", async ({ page }) => {',
  "  await expect(page).toHaveTitle(/x/);",
  "});",
].join("\n");

function workspace(feature = FEATURE): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-fp-"));
  mkdirSync(join(ws, "features"));
  mkdirSync(join(ws, "tests"));
  writeFileSync(join(ws, "playwright.config.ts"), 'export default { testDir: "tests" };');
  writeFileSync(join(ws, "features", "epic-scrum-5-customer-account-access.feature"), feature);
  writeFileSync(join(ws, "tests", "epic-scrum-5-customer-account-access.spec.ts"), SPEC);
  return ws;
}

let n = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
const pair = (toolName: string, args: Record<string, unknown>, result: unknown): AnyRunEvent[] => {
  const id = ++n;
  return [
    {
      ...base,
      eventId: id,
      kind: "call",
      payload: { server: "aqa", toolName, args, startedAt: 0 },
    },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as AnyRunEvent[];
};
const preflight = (facts: StoryFacts) =>
  pair("story_context", {}, { kind: "preflight", summary: {}, text: "", facts });
const DESIGN = {
  items: [
    {
      id: "D1",
      covers: "AC-1",
      type: "functional",
      technique: "equivalence-partitioning",
      conditions: ["valid user"],
      expected: "signed in",
      source: "AC-1",
    },
  ],
};
// A finished run: design approved, suite run after the last change, ended.
const suite = (failing: string[] = []) => {
  const [c, o] = pair(
    "run_tests",
    { spec: "tests/x.spec.ts" },
    {
      tests: [
        {
          title: "AC-1: Valid credentials sign the customer in",
          status: failing.length ? "failed" : "passed",
        },
      ],
    },
  ) as [AnyRunEvent, AnyRunEvent];
  (c.payload as unknown as { server: string }).server = "pw";
  return [c, o];
};
const end = () =>
  ({
    ...base,
    eventId: ++n,
    kind: "end",
    payload: { status: "done", summary: "", exitCode: 0 },
  } as unknown as AnyRunEvent);
const priorRun = (facts: StoryFacts, failing: string[] = []) => ({
  runId: "20261018T100000Z",
  events: [
    ...preflight(facts),
    ...pair("test_design", DESIGN, { recorded: true }),
    ...suite(failing),
    end(),
  ],
});

const skillWith = (
  ws: string,
  runs: Array<{ runId: string; events: AnyRunEvent[] }>,
  fresh = false,
) =>
  storyToTestsSkill({
    workItem: "SCRUM-6",
    tracker: "jira",
    workspaceDir: ws,
    testTypes: ["functional"],
    previousRuns: () => runs,
    ...(fresh ? { fresh: true } : {}),
  });

describe("storyFingerprint", () => {
  it("ignores whitespace and case, and changes with criteria, bug state and test types", () => {
    const fp = storyFingerprint(FACTS, ["functional"]);
    expect(
      storyFingerprint(
        { ...FACTS, acceptanceCriteria: ["  ac-1: VALID credentials   sign the customer in "] },
        ["functional"],
      ),
    ).toBe(fp);
    expect(
      storyFingerprint({ ...FACTS, acceptanceCriteria: ["AC-1: changed"] }, ["functional"]),
    ).not.toBe(fp);
    const bug = { id: "SCRUM-9", state: "To Do", title: "x" };
    expect(storyFingerprint({ ...FACTS, bugs: [bug] }, ["functional"])).not.toBe(
      storyFingerprint({ ...FACTS, bugs: [{ ...bug, state: "Done" }] }, ["functional"]),
    );
    expect(storyFingerprint(FACTS, ["functional", "accessibility"])).not.toBe(fp);
  });

  it("finds the latest earlier run of the same story that had a design approved", () => {
    const other = { ...FACTS, story: { id: "SCRUM-8", title: "Logout" } };
    const runs = [
      priorRun(FACTS),
      {
        runId: "20261019T090000Z",
        events: [...preflight(other), ...pair("test_design", DESIGN, {}), ...suite(), end()],
      },
      { runId: "20261019T100000Z", events: preflight(FACTS) }, // no design approved
    ];
    expect(latestPriorDesign(runs, FACTS.story, ["functional"])?.runId).toBe("20261018T100000Z");
  });

  it("reads no runs from a ledger root that has none", () => {
    expect(readRuns(mkdtempSync(join(tmpdir(), "aqa-none-")))).toEqual([]);
  });
});

describe("the route for an unchanged story", () => {
  it("carries the approved design, hides aqa.test_design and tells the agent", () => {
    const skill = skillWith(workspace(), [priorRun(FACTS)]);
    const events = preflight(FACTS);
    const d = skill.route?.(events);
    expect(d?.path).toBe("B");
    expect(d?.deny).toContain("aqa.test_design");
    expect(d?.reason).toContain("story unchanged since run 20261018T100000Z");
    expect(d?.note).toContain("stays in force");
    const routed = [
      ...events,
      {
        ...base,
        eventId: ++n,
        kind: "route",
        payload: { path: d?.path, reason: d?.reason, because: d?.because, denied: d?.deny },
      },
    ] as AnyRunEvent[];
    // The design-first rule, the autorun and the verifier all read this.
    expect(approvedDesign(routed)?.items.map((i) => i.id)).toEqual(["D1"]);
    expect(skill.autoRun?.(routed)?.toolName).toBe("pw.run_tests");
    expect(skill.reroute?.(routed)).toBeUndefined();
    const stages = new StageTracker();
    expect(stages.line(routed[routed.length - 1] as AnyRunEvent)).toMatch(/Test design: reused/);
  });

  it("does not reuse the design of a run that was stopped before its suite ran (20261019T163019Z)", async () => {
    const finished = priorRun(FACTS);
    const stopped = {
      runId: "20261019T100000Z",
      events: [...preflight(FACTS), ...pair("test_design", DESIGN, { recorded: true })],
    };
    // The stopped run is the later one: its tests are on disk, so the older
    // finished run's design is not reused either.
    const d = skillWith(workspace(), [finished, stopped]).route?.(preflight(FACTS));
    expect(d?.because?.["carriedDesign"]).toBeUndefined();
    expect(d?.because?.["unverifiedTests"]).toEqual({ runId: "20261019T100000Z" });
    expect(d?.reason).toContain("treated as new tests");
    expect(d?.deny).not.toContain("aqa.test_design");
    const { provenTests, isProven } = await import("../src/triage/quarantine.js");
    const routed = [
      ...preflight(FACTS),
      {
        ...base,
        eventId: ++n,
        kind: "route",
        payload: { path: "B", reason: "", because: d?.because, denied: [] },
      },
    ] as AnyRunEvent[];
    expect(
      isProven("x.spec.ts › AC-1: Valid credentials sign the customer in", provenTests(routed)),
    ).toBe(false);
  });

  it("carries the tests that were still failing, so they are repaired rather than frozen", async () => {
    const d = skillWith(workspace(), [
      priorRun(FACTS, ["AC-1: Valid credentials sign the customer in"]),
    ]).route?.(preflight(FACTS));
    expect(d?.because?.["previousFailing"]).toEqual([
      "AC-1: Valid credentials sign the customer in",
    ]);
    const { provenTests, isProven } = await import("../src/triage/quarantine.js");
    const routed = [
      ...preflight(FACTS),
      {
        ...base,
        eventId: ++n,
        kind: "route",
        payload: { path: "B", reason: "", because: d?.because, denied: [] },
      },
    ] as AnyRunEvent[];
    const proven = provenTests(routed);
    expect(isProven("x.spec.ts › AC-1: Valid credentials sign the customer in", proven)).toBe(
      false,
    );
    expect(isProven("x.spec.ts › some other existing test", proven)).toBe(true);
  });

  it("designs again when the story changed, and says so", () => {
    const skill = skillWith(workspace(), [
      priorRun({ ...FACTS, acceptanceCriteria: ["AC-1: old wording"] }),
    ]);
    const d = skill.route?.(preflight(FACTS));
    expect(d?.deny).not.toContain("aqa.test_design");
    expect(d?.because?.["carriedDesign"]).toBeUndefined();
    expect(d?.because?.["fingerprint"]).toBe(storyFingerprint(FACTS, ["functional"]));
    expect(d?.reason).toContain("the story changed since run 20261018T100000Z");
  });

  it("designs again when a design item lost its scenario", () => {
    const a11y = {
      id: "D2",
      covers: "story",
      type: "accessibility",
      technique: "error-guessing",
      conditions: ["login page"],
      expected: "no WCAG A/AA violations",
      source: "WCAG 2.1 AA",
    };
    const prior = {
      runId: "20261018T100000Z",
      events: [
        ...preflight(FACTS),
        ...pair("test_design", { items: [...DESIGN.items, a11y] }, {}),
        ...suite(),
        end(),
      ],
    };
    const skill = storyToTestsSkill({
      workItem: "SCRUM-6",
      tracker: "jira",
      workspaceDir: workspace(),
      testTypes: ["functional", "accessibility"],
      previousRuns: () => [prior],
    });
    const d = skill.route?.(preflight(FACTS));
    expect(d?.path).toBe("B");
    expect(d?.because?.["carriedDesign"]).toBeUndefined();
    expect(d?.because?.["previousDesignMissing"]).toEqual(["D2"]);
    expect(d?.reason).toContain("no longer have a scenario");
  });

  it("stops a --fresh run while the story's scenarios are still on disk", () => {
    const d = skillWith(workspace(), [priorRun(FACTS)], true).route?.(preflight(FACTS));
    expect(d?.stop).toContain("Move them aside");
    expect(d?.stop).toContain("1 scenario(s) tagged @story:SCRUM-6");
  });

  it("ignores earlier runs with --fresh once the story's scenarios are moved aside", () => {
    const other = [
      "Feature: Customer account access",
      "",
      "  @story:SCRUM-8 @design:D7",
      "  Scenario: D7: Logout ends the session",
      '    When I click "Logout"',
    ].join("\n");
    const d = skillWith(workspace(other), [priorRun(FACTS)], true).route?.(preflight(FACTS));
    expect(d?.stop).toBeUndefined();
    expect(d?.because?.["carriedDesign"]).toBeUndefined();
    expect(d?.because?.["cases"]).toBeUndefined();
    expect(d?.deny).not.toContain("aqa.test_design");
  });
});

describe("the case list at the design approval (item 8)", () => {
  it("lists each item by its case id and state, changed against the last approved design", () => {
    const a11y = {
      id: "D4",
      covers: "story",
      type: "accessibility",
      technique: "error-guessing",
      conditions: ["login page"],
      expected: "no WCAG A/AA violations",
      source: "WCAG 2.1 AA",
    };
    const changedD1 = { ...DESIGN.items[0], expected: "the account menu shows the user's name" };
    const skill = storyToTestsSkill({
      workItem: "SCRUM-6",
      tracker: "jira",
      workspaceDir: workspace(),
      testTypes: ["functional", "accessibility"],
      previousRuns: () => [priorRun(FACTS)],
    });
    const r = skill.approvalNote?.(
      [{ toolName: "aqa.test_design", args: { items: [changedD1, a11y] } }] as never,
      preflight(FACTS),
    );
    expect(r?.note).toContain("Test cases (1 changed, 1 new):");
    expect(r?.note).toMatch(/SCRUM-6-D1 +changed +AC-1: Valid credentials sign the customer in/);
    expect(r?.note).toMatch(/SCRUM-6-D4 +new/);
  });
});

describe("a reused design names the passing tests that do not match it (20261019T202717Z)", () => {
  it("tells the agent before the suite runs that a green test must still change", () => {
    const transition = {
      items: [
        {
          ...DESIGN.items[0],
          technique: "state-transition",
          conditions: ["signed out", "user signs in"],
          expected: "the account menu shows; the sign-in link is gone",
        },
      ],
    };
    const run = {
      runId: "20261018T100000Z",
      events: [
        ...preflight(FACTS),
        ...pair("test_design", transition, { recorded: true }),
        ...suite(),
        end(),
      ],
    };
    const d = skillWith(workspace(), [run]).route?.(preflight(FACTS));
    expect(d?.path).toBe("B");
    expect(d?.note).toContain("even when it passes");
    expect(d?.note).toContain("must be changed in this run");
    expect(d?.note).toContain("performs no action");
  });

  it("says nothing extra when the tests match", () => {
    const d = skillWith(workspace(), [priorRun(FACTS)]).route?.(preflight(FACTS));
    expect(d?.note).not.toContain("must be changed in this run");
  });
});
