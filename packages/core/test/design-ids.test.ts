import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStoryRefusal } from "../src/skills/story-rules.js";
import { storyToTestsSkill } from "../src/skills/story-to-tests.js";
import type { StoryFacts } from "../src/design/test-design.js";
import type { AnyRunEvent } from "../src/types.js";

// Run 20261016T193254Z: D4 was SCRUM-8's number in the shared epic file, so the
// approved design was refused three times after approval, renumbered to D20 and
// approved again — while the plan still enforced D4.

const FACTS: StoryFacts = {
  acceptanceCriteria: ["AC-1"],
  bugs: [],
  tasks: [],
  story: { id: "SCRUM-6", title: "Login" },
  epic: { id: "SCRUM-5", title: "Customer account access" },
} as StoryFacts;
const FEATURE_PATH = "features/epic-scrum-5-customer-account-access.feature";
const FEATURE = [
  "Feature: Customer account access",
  "",
  "  @story:SCRUM-6 @ac:1 @design:D1",
  "  Scenario: AC-1: Login with valid credentials",
  '    When I sign in as "jim"',
  '    Then the page displays "Logout"',
  "",
  "  @story:SCRUM-8 @design:D4",
  "  Scenario: D4: Logout ends the session",
  '    When I click "Logout"',
  '    Then the page displays "Login"',
  "",
  "  @story:SCRUM-8 @design:D7",
  "  Scenario: D7: Logout menu is keyboard reachable",
  '    When I press "Tab"',
  '    Then the page displays "Logout"',
].join("\n");

const workspace = (feature = FEATURE): string => {
  const ws = mkdtempSync(join(tmpdir(), "aqa-ids-"));
  mkdirSync(join(ws, "features"), { recursive: true });
  writeFileSync(join(ws, FEATURE_PATH), feature);
  return ws;
};

const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
let n = 0;
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
const preflight = pair(
  "story_context",
  {},
  { kind: "preflight", summary: {}, text: "", facts: FACTS },
);

const item = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: "functional",
  technique: "equivalence-partitioning",
  conditions: ["x"],
  expected: "y",
  source: "AC-1",
  ...over,
});
const design = (ids: string[]) => ({
  items: [
    item({ id: "D1", covers: "AC-1" }),
    ...ids.map((id) =>
      item({
        id,
        covers: "story",
        type: "accessibility",
        technique: "error-guessing",
        source: "WCAG 2.1 AA",
      }),
    ),
  ],
});

describe("design numbers already used by another story in the shared file", () => {
  it("refuses the design before anyone is asked, naming the owner and the next free number", () => {
    const refuse = makeStoryRefusal({
      testTypes: ["functional", "accessibility"],
      workspaceDir: workspace(),
    });
    const r = refuse({ toolName: "aqa.test_design", args: design(["D4"]) }, preflight);
    expect(r).toContain("D4: that number already belongs to SCRUM-8");
    expect(r).toContain("use D8");
  });

  it("lets the story keep its own numbers and take a free one", () => {
    const refuse = makeStoryRefusal({
      testTypes: ["functional", "accessibility"],
      workspaceDir: workspace(),
    });
    const r = refuse({ toolName: "aqa.test_design", args: design(["D8"]) }, preflight);
    expect(r ?? "").not.toContain("already belongs");
  });
});

describe("items this story already tests keep their scenario's number", () => {
  // Run 20261016T201236Z: told only "use the next free number", the agent
  // renumbered everything D20–D26 while SCRUM-6's scenarios carried D6–D13.
  const OWN = [
    "Feature: Customer account access",
    "",
    "  @story:SCRUM-8 @ac:1 @design:D1 @type:functional",
    "  Scenario: AC-1: Logout signs the customer out",
    '    When I click "Logout"',
    "",
    "  @story:SCRUM-6 @ac:1 @design:D6 @type:functional",
    "  Scenario: AC-1: Valid credentials sign the customer in",
    '    When I sign in as "jim"',
    "",
    "  @story:SCRUM-6 @design:D13 @type:accessibility",
    "  Scenario: AC-story: Login page passes axe-core WCAG A/AA scan",
    '    When I open "/login"',
  ].join("\n");
  const refuse = () =>
    makeStoryRefusal({
      testTypes: ["functional", "accessibility"],
      workspaceDir: workspace(OWN),
    });
  const designOf = (fn: string, a11y: string) => ({
    items: [
      item({ id: fn, covers: "AC-1" }),
      item({
        id: a11y,
        covers: "story",
        type: "accessibility",
        technique: "error-guessing",
        source: "WCAG 2.1 AA",
      }),
    ],
  });

  it("points a renumbered item back to the id its scenario carries", () => {
    const r = refuse()({ toolName: "aqa.test_design", args: designOf("D20", "D26") }, preflight);
    expect(r).toContain(
      'D20: this story\'s scenario "AC-1: Valid credentials sign the customer in"',
    );
    expect(r).toContain("give the item the id D6");
    expect(r).toContain("give the item the id D13");
    expect(r).not.toContain("next free number");
  });

  it("prefers the story's own number over the next free one when the clash is another story's", () => {
    const r = refuse()({ toolName: "aqa.test_design", args: designOf("D1", "D13") }, preflight);
    expect(r).toContain("give the item the id D6");
    expect(r).not.toContain("already belongs to SCRUM-8");
  });

  it("accepts the design that uses the scenarios' own numbers", () => {
    const r = refuse()({ toolName: "aqa.test_design", args: designOf("D6", "D13") }, preflight);
    expect(r ?? "").not.toMatch(/give the item the id|not in the design|already belongs/);
  });

  it("names an existing scenario the design leaves out", () => {
    const r = refuse()(
      { toolName: "aqa.test_design", args: { items: [item({ id: "D6", covers: "AC-1" })] } },
      preflight,
    );
    expect(r).toContain('existing scenario "AC-story: Login page passes axe-core WCAG A/AA scan"');
    expect(r).toContain("with the id D13");
  });
});

describe("re-planning after a revised design is approved", () => {
  const route = (because: Record<string, unknown>): AnyRunEvent =>
    ({
      ...base,
      eventId: ++n,
      kind: "route",
      payload: { path: "A2", reason: "", because, denied: [] },
    }) as AnyRunEvent;

  it("re-plans with the new number and keeps the scenarios locked at the first switch", () => {
    const ws = workspace();
    const skill = storyToTestsSkill({
      workItem: "SCRUM-6",
      tracker: "jira",
      workspaceDir: ws,
      testTypes: ["functional", "accessibility"],
    });
    const locked = ["AC-1: Login with valid credentials"];
    const events = [
      ...preflight,
      ...pair("test_design", design(["D4"]), { recorded: true }),
      route({ from: "B", appendOnly: true, missing: ["D4"], locked }),
      ...pair("test_design", design(["D20"]), { recorded: true }),
    ];
    const next = skill.reroute?.(events);
    expect(next?.path).toBe("A2");
    expect(next?.because?.["missing"]).toEqual(["D20"]);
    expect(next?.because?.["locked"]).toEqual(locked);
  });

  it("does not re-plan while the same items are being finished", () => {
    const skill = storyToTestsSkill({
      workItem: "SCRUM-6",
      tracker: "jira",
      workspaceDir: workspace(),
      testTypes: ["functional", "accessibility"],
    });
    const events = [
      ...preflight,
      ...pair("test_design", design(["D20"]), { recorded: true }),
      route({ from: "B", appendOnly: true, missing: ["D20"], locked: [] }),
    ];
    expect(skill.reroute?.(events)).toBeUndefined();
  });
});
