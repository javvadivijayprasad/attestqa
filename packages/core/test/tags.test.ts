import { describe, it, expect } from "vitest";
import { storyRefusal } from "../src/skills/story-rules.js";
import { kindTagsFor, parseDesign, scenarioTags } from "../src/design/test-design.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Tags are what let someone act on a suite without reading it: which story a
 * test belongs to, which design item it implements, and what KIND of test it
 * is — so `--grep @type:security` is a lane, and a test case in Azure DevOps
 * can be traced to the run that recorded it.
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

const CONTEXT = {
  tool: "aqa.story_context",
  result: {
    kind: "preflight",
    summary: {},
    text: "story 44",
    facts: {
      acceptanceCriteria: [],
      bugs: [],
      tasks: [],
      story: { id: 44, title: "Log out" },
      epic: { id: 42, title: "Customer account access" },
    },
  },
};

const DESIGN = {
  tool: "aqa.test_design",
  args: {
    items: [
      {
        id: "D13",
        covers: "story",
        type: "security",
        technique: "state-transition",
        conditions: ["signs in, logs out"],
        expected: "no JWT remains",
        source: "story description",
      },
    ],
  },
};

const FEATURE = "features/epic-42-customer-account-access.feature";
const existing = ["Feature: Customer account access", ""].join("\n");

const withScenario = (tags: string) =>
  [
    existing,
    `  ${tags}`,
    "  Scenario: Security — no JWT after logout",
    "    Given I am signed in",
  ].join("\n");

describe("a scenario says what kind of test it is", () => {
  it("names the tags the design implies", () => {
    const item = parseDesign(DESIGN.args).items[0]!;
    expect(kindTagsFor(item)).toEqual(["@type:security", "@technique:state-transition"]);
  });

  it("reads the tags off a feature file", () => {
    const [sc] = scenarioTags(withScenario("@story:44 @design:D13 @type:security"));
    expect(sc?.tags).toEqual(["@story:44", "@design:D13", "@type:security"]);
  });

  it("refuses a new scenario missing its type and technique", () => {
    const events = ledgerOf([
      CONTEXT,
      { tool: "fs.read_file", args: { path: FEATURE }, result: { content: existing } },
      DESIGN,
    ]);
    const why = storyRefusal(
      {
        toolName: "fs.write_file",
        args: { path: FEATURE, content: withScenario("@story:44 @design:D13") },
      },
      events,
    );
    expect(why).toContain("@type:security");
    expect(why).toContain("@technique:state-transition");
  });

  it("says which tag to replace when the scenario names the wrong type (AB#1)", () => {
    const events = ledgerOf([
      CONTEXT,
      { tool: "fs.read_file", args: { path: FEATURE }, result: { content: existing } },
      DESIGN,
    ]);
    const why = storyRefusal(
      {
        toolName: "fs.write_file",
        args: {
          path: FEATURE,
          content: withScenario(
            "@story:44 @design:D13 @type:functional @technique:state-transition",
          ),
        },
      },
      events,
    );
    expect(why).toContain("(@design:D13)");
    expect(why).toContain("replace @type:functional with @type:security");
    expect(why).not.toContain("@technique:state-transition with");
  });

  it("allows it once both are there", () => {
    const events = ledgerOf([
      CONTEXT,
      { tool: "fs.read_file", args: { path: FEATURE }, result: { content: existing } },
      DESIGN,
    ]);
    const why = storyRefusal(
      {
        toolName: "fs.write_file",
        args: {
          path: FEATURE,
          content: withScenario("@story:44 @design:D13 @type:security @technique:state-transition"),
        },
      },
      events,
    );
    expect(why ?? "").not.toContain("what kind of test");
  });
});

describe("a test case says where it came from, where the tool can say it", () => {
  const events = ledgerOf([CONTEXT]);
  const viaWorkItem = (tags?: string) => ({
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Test Case",
      fields: { "System.Title": "AC-1 …", ...(tags ? { "System.Tags": tags } : {}) },
    },
  });

  it("refuses a work-item case with no tags at all", () => {
    const why = storyRefusal(viaWorkItem(), events);
    expect(why).toContain("agentic-qa");
    expect(why).toContain("story-44");
    expect(why).toContain("epic-42");
  });

  it("refuses one that is missing only the epic", () => {
    const why = storyRefusal(viaWorkItem("agentic-qa; story-44"), events);
    expect(why).toContain("epic-42");
  });

  it("allows a fully tagged case", () => {
    expect(storyRefusal(viaWorkItem("agentic-qa; story-44; epic-42"), events)).toBeUndefined();
  });

  // ado.testplan_test_case_write has no tags field and rejects unknown fields;
  // demanding tags there stopped AB#91 in 20261020T200144Z on no progress.
  it("does not ask the test-plan tool for tags it cannot carry", () => {
    const why = storyRefusal(
      {
        toolName: "ado.testplan_test_case_write",
        args: { action: "create", title: "AC-1 …", steps: "1. a|b", testsWorkItemId: 44 },
      },
      events,
    );
    expect(why ?? "").not.toContain("carries no");
  });
});
