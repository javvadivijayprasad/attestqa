import { describe, it, expect } from "vitest";
import { storyRefusal } from "../src/skills/story-rules.js";
import { unboundSteps } from "../src/mcp/adapters/bdd2pw.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * S4 — the author and implement guards. All three come from one run
 * (20260925T151945Z), which rewrote a shared feature file in wording the
 * generator could not read, scaffolded it, and produced 14 tests with 42 empty
 * steps in a file nobody wanted.
 */
function ledgerOf(
  entries: Array<{ tool: string; args?: Record<string, unknown>; result?: unknown }>,
): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  let id = 0;
  const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
  for (const e of entries) {
    const callId = ++id;
    events.push({
      ...base,
      eventId: callId,
      kind: "call",
      payload: {
        server: e.tool.split(".")[0] as string,
        toolName: e.tool.slice(e.tool.indexOf(".") + 1),
        args: e.args ?? {},
        startedAt: 0,
      },
    } as AnyRunEvent);
    events.push({
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: true,
        result: e.result ?? {},
        artefacts: [],
        durationMs: 1,
      },
    } as AnyRunEvent);
  }
  return events;
}

/** Stage 1's digest, which is where the rules read the story and the epic from. */
const STORY = {
  tool: "aqa.story_context",
  result: {
    kind: "preflight",
    summary: {},
    text: "story 44",
    facts: {
      acceptanceCriteria: [],
      bugs: [],
      tasks: [],
      story: { id: 44, title: "Log out of an account" },
      epic: { id: 42, title: "Customer account access" },
    },
  },
};

const FEATURE = "features/epic-42-customer-account-access.feature";
const scaffold = {
  toolName: "bdd2pw.scaffold",
  args: { feature: FEATURE, url: "http://localhost:3100" },
};

describe("bdd2pw's own report decides whether a feature is ready", () => {
  it("reads the unbound steps out of its findings", () => {
    const out =
      '[{"severity":"warn","message":"[Story-a] no rule matched: \\"When I find the Email field\\""},' +
      '{"severity":"info","message":"scanned 12 elements"},' +
      '{"severity":"warn","message":"ambiguous visibility step: no POM field matched \\"the account menu\\""}]';
    expect(unboundSteps(out)).toHaveLength(2);
    expect(unboundSteps('[{"severity":"info","message":"all steps bound"}]')).toHaveLength(0);
  });

  it("refuses a scaffold of a feature this run wrote but never analyzed", () => {
    const events = ledgerOf([
      { tool: "fs.write_file", args: { path: FEATURE, content: "Feature: x" } },
    ]);
    expect(storyRefusal(scaffold, events)).toContain("bdd2pw.analyze");
  });

  it("refuses a scaffold while steps are unbound, naming them", () => {
    const events = ledgerOf([
      { tool: "fs.write_file", args: { path: FEATURE, content: "Feature: x" } },
      {
        tool: "bdd2pw.analyze",
        args: { feature: FEATURE, url: "http://localhost:3100" },
        result: {
          unboundCount: 2,
          unbound: ['no rule matched: "When I find the Email field"', "ambiguous visibility step"],
        },
      },
    ]);
    const why = storyRefusal(scaffold, events);
    expect(why).toContain("cannot bind 2 step(s)");
    expect(why).toContain("When I find the Email field");
  });

  it("allows the scaffold once nothing is unbound", () => {
    const events = ledgerOf([
      { tool: "fs.write_file", args: { path: FEATURE, content: "Feature: x" } },
      {
        tool: "bdd2pw.analyze",
        args: { feature: FEATURE, url: "http://localhost:3100" },
        result: { unboundCount: 0 },
      },
    ]);
    expect(storyRefusal(scaffold, events)).toBeUndefined();
  });
});

describe("a generator may not overwrite implemented tests", () => {
  const SPEC = "tests/epic-42-customer-account-access.spec.ts";
  it("refuses a scaffold over a spec whose tests are implemented", () => {
    const events = ledgerOf([
      STORY,
      {
        tool: "fs.read_file",
        args: { path: SPEC },
        result: {
          content: [
            'test("Story-a — logs out", async ({ page }) => {',
            "  await expect(page).toHaveURL(/login/);",
            "});",
          ].join("\n"),
        },
      },
      { tool: "fs.write_file", args: { path: FEATURE, content: "Feature: x" } },
      { tool: "bdd2pw.analyze", args: { feature: FEATURE, url: "u" }, result: { unboundCount: 0 } },
    ]);
    const why = storyRefusal(scaffold, events);
    expect(why).toContain("REGENERATES");
    expect(why).toContain("1 of its 1 test(s) are implemented");
  });
});

describe("another story's scenarios are not this run's to reword", () => {
  const before = [
    "Feature: Customer account access",
    "",
    "  @story:1 @ac:1 @design:D1",
    "  Scenario: AC-1 — signs in",
    "    Given I am on the login page",
    '    When I enter "user" and "pass"',
    "",
    "  @story:44 @design:D9",
    "  Scenario: Story-a — logs out",
    "    Given I am signed in",
  ].join("\n");

  const events = (_content: string) =>
    ledgerOf([
      STORY,
      { tool: "fs.read_file", args: { path: FEATURE }, result: { content: before } },
    ]).concat([]) as AnyRunEvent[];

  const write = (content: string) => ({
    toolName: "fs.write_file",
    args: { path: FEATURE, content },
  });

  it("refuses a reworded step in story #1's scenario", () => {
    const after = before.replace(
      'When I enter "user" and "pass"',
      "When I sign in with valid credentials",
    );
    expect(storyRefusal(write(after), events(after))).toContain("rewords 1 scenario(s)");
  });

  it("allows a change to this story's own scenario", () => {
    const after = before.replace(
      "Given I am signed in",
      "Given I am signed in as a registered user",
    );
    expect(storyRefusal(write(after), events(after))).toBeUndefined();
  });
});
