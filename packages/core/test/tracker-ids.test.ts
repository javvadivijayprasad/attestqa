import { describe, it, expect } from "vitest";
import {
  hasStoryTag,
  includesId,
  isJiraKey,
  normId,
  sameId,
  storyTagId,
  storyTagIds,
} from "../src/design/ids.js";
import {
  epicStem,
  featurePathFor,
  scenarioStoryTags,
  storiesIn,
  storyTestTitles,
  type StoryFacts,
} from "../src/design/test-design.js";
import { gatherJiraStoryContext, jiraStateMeaning } from "../src/skills/jira-story-context.js";
import { storyFacts, validateDesign } from "../src/design/test-design.js";
import type { AnyRunEvent } from "../src/types.js";
import type { PreflightRead } from "../src/types.js";

/**
 * One tracker interface (decision D17): a Jira story and an Azure DevOps story
 * reach the agent as the same facts, and every place that reads a story id
 * accepts both. Azure DevOps ids stay numbers, so nothing it did before changes.
 */

describe("tracker ids", () => {
  it("keeps Azure DevOps ids as numbers and upper-cases Jira keys", () => {
    expect(normId(44)).toBe(44);
    expect(normId("44")).toBe(44);
    expect(normId(" shop-12 ")).toBe("SHOP-12");
    expect(normId("AB#44")).toBeUndefined();
    expect(normId("X-1")).toBeUndefined(); // project keys have two or more characters
    expect(normId(Number.NaN)).toBeUndefined();
    expect(normId(undefined)).toBeUndefined();
  });

  it("compares ids across shapes", () => {
    expect(sameId(44, "44")).toBe(true);
    expect(sameId("SHOP-12", "shop-12")).toBe(true);
    expect(sameId(12, "SHOP-12")).toBe(false);
    expect(sameId(undefined, undefined)).toBe(false);
    expect(includesId([1, "QA-3"], "qa-3")).toBe(true);
    expect(isJiraKey("QA-3")).toBe(true);
    expect(isJiraKey(3)).toBe(false);
  });

  it("reads @story tags of either kind", () => {
    expect(storyTagId("@story:44")).toBe(44);
    expect(storyTagId("@story:SHOP-12")).toBe("SHOP-12");
    expect(storyTagId("@story:")).toBeUndefined();
    expect(storyTagIds("// @story:44 @story:shop-12 @ac:1")).toEqual([44, "SHOP-12"]);
    expect(hasStoryTag("// @ac:1")).toBe(false);
  });
});

const FEATURE = [
  "Feature: Checkout",
  "",
  "  @story:SHOP-12 @ac:1",
  "  Scenario: Pay with a saved card",
  "    Given a cart",
  "",
  "  @story:44 @ac:2",
  "  Scenario: Old ADO scenario",
  "    Given a cart",
  "",
  "  Scenario: Untagged",
  "    Given nothing",
].join("\n");

const SPEC = [
  "// @story:SHOP-12 @ac:1",
  'test("Pay with a saved card", async () => {});',
  "// @story:44 @ac:2",
  'test("Old ADO scenario", async () => {});',
].join("\n");

describe("shared epic files with Jira stories", () => {
  it("separates scenarios and tests by story, whichever tracker the id came from", () => {
    expect(scenarioStoryTags(FEATURE).map((s) => s.stories)).toEqual([["SHOP-12"], [44], []]);
    expect([...storiesIn(FEATURE)]).toEqual(["SHOP-12", 44]);
    expect([...storyTestTitles(SPEC, "shop-12")]).toEqual(["Pay with a saved card"]);
    expect([...storyTestTitles(SPEC, 44)]).toEqual(["Old ADO scenario"]);
  });

  it("names the epic file for a Jira epic in lower case, and an ADO epic as before", () => {
    const jira: StoryFacts = {
      acceptanceCriteria: [],
      bugs: [],
      tasks: [],
      epic: { id: "SHOP-1", title: "Checkout & payment" },
    };
    expect(epicStem(jira)).toBe("epic-shop-1-checkout-payment");
    expect(featurePathFor(jira)).toBe("features/epic-shop-1-checkout-payment.feature");
    expect(epicStem({ ...jira, epic: { id: 7, title: "Login" } })).toBe("epic-7-login");
    expect(epicStem({ ...jira, epic: { id: Number.NaN, title: "x" } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- stage 1

type Call = { tool: string; args: Record<string, unknown>; linked: boolean };

function fakeJira(over: Partial<Record<string, unknown>> = {}): {
  read: PreflightRead;
  calls: Call[];
} {
  const calls: Call[] = [];
  const issues: Record<string, unknown> = {
    "SHOP-12": {
      key: "SHOP-12",
      summary: "Pay with a saved card",
      type: "Story",
      status: "In Progress",
      description:
        "Customers reuse a card.\n\nAcceptance criteria\nAC-1: a saved card can be chosen\n- AC-2: the last four digits are shown",
      acceptanceCriteria:
        "AC-1: a saved card can be chosen\n- AC-2: the last four digits are shown",
      acceptanceCriteriaSource: "description",
      parent: "SHOP-1",
      subtasks: [{ key: "SHOP-13", summary: "Store card token", status: "Done" }],
    },
    "SHOP-1": { key: "SHOP-1", summary: "Checkout", type: "Epic", description: "All of checkout." },
    "SHOP-13": { key: "SHOP-13", description: "Token is stored by the payment provider." },
    ...over,
  };
  const read: PreflightRead = async (tool, args, opts) => {
    calls.push({ tool, args, linked: opts?.linkedToStory === true });
    if (tool === "jira.get_issue") {
      const i = issues[String(args["key"])];
      return i ? { ok: true, result: i } : { ok: false, result: { message: "not found" } };
    }
    if (tool === "jira.list_comments")
      return {
        ok: true,
        result: {
          comments: [
            { author: "Priya (PO)", text: "Only Visa and Mastercard for now." },
            { author: "Vijay", text: "## agentic-qa run 20261010T101500Z-abcdef12\nall green" },
          ],
        },
      };
    if (tool === "jira.search" && String(args["jql"]).startsWith("parent"))
      return {
        ok: true,
        result: {
          issues: [{ key: "SHOP-14", type: "Story", status: "To Do", summary: "Remove a card" }],
        },
      };
    if (tool === "jira.search")
      return {
        ok: true,
        result: {
          issues: [
            {
              key: "SHOP-20",
              status: "In Progress",
              summary: "Card list empty after refresh",
              labels: [],
            },
            { key: "SHOP-21", status: "Resolved", summary: "Expiry not shown", labels: [] },
            { key: "SHOP-22", status: "To Do", summary: "Pay fails", labels: ["agentic-qa"] },
            { key: "SHOP-23", status: "Closed", summary: "Old", labels: [] },
          ],
        },
      };
    return { ok: false, result: { message: "unexpected" } };
  };
  return { read, calls };
}

describe("gatherJiraStoryContext", () => {
  it("produces the same facts an Azure DevOps story would", async () => {
    const { read, calls } = fakeJira();
    const d = await gatherJiraStoryContext(read, { workItem: "shop-12" });
    const facts = d.facts as StoryFacts;
    expect(facts.story).toEqual({ id: "SHOP-12", title: "Pay with a saved card" });
    expect(facts.epic).toEqual({ id: "SHOP-1", title: "Checkout" });
    expect(facts.acceptanceCriteria).toEqual(["AC-1", "AC-2"]);
    expect(facts.tasks).toEqual(["SHOP-13"]);
    expect(facts.bugs.map((b) => b.id)).toEqual(["SHOP-20", "SHOP-21"]);
    expect(facts.filedBugs?.find((b) => b.id === "SHOP-22")?.agent).toBe(true);
    expect(facts.filedBugs?.some((b) => b.id === "SHOP-23")).toBe(false);
    expect(d.summary).toMatchObject({
      storyRead: 1,
      epicRead: 1,
      siblingsRead: 1,
      tasksRead: 1,
      commentsRead: 1,
      commentsExcluded: 1,
      openBugsRead: 2,
      openBugsExcluded: 1,
    });
    // Items reached through the story's own links are marked as such.
    expect(calls.filter((c) => c.linked).map((c) => c.args["key"])).toEqual(["SHOP-1", "SHOP-13"]);
    expect(
      calls.find((c) => c.tool === "jira.search" && String(c.args["jql"]).includes("Bug"))?.args[
        "jql"
      ],
    ).toBe("project = SHOP AND issuetype = Bug ORDER BY updated DESC");
  });

  it("leaves out what this runtime wrote and keeps what people wrote", async () => {
    const { read } = fakeJira();
    const d = await gatherJiraStoryContext(read, { workItem: "SHOP-12" });
    expect(d.text).toContain("Only Visa and Mastercard");
    expect(d.text).not.toContain("all green");
    expect(d.text).not.toContain("Pay fails");
    expect(d.text).toContain("SHOP-20 [In Progress]");
    expect(d.text).toContain("@story:SHOP-12");
    expect(d.text).toContain("features/epic-shop-1-checkout.feature");
  });

  it("stops on a story it cannot read, and on an id that is not a key", async () => {
    const { read } = fakeJira({ "SHOP-12": undefined });
    const d = await gatherJiraStoryContext(read, { workItem: "SHOP-12" });
    expect(d.summary).toEqual({ storyRead: 0 });
    expect(d.text).toMatch(/could not be read/);
    const n = await gatherJiraStoryContext(read, { workItem: "44" });
    expect(n.text).toMatch(/not a Jira issue key/);
  });

  it("maps workflow states onto the three meanings, and says when it cannot", () => {
    expect(jiraStateMeaning("In Progress")).toMatch(/^ACTIVE/);
    expect(jiraStateMeaning("to do")).toMatch(/^NEW/);
    expect(jiraStateMeaning("Ready for QA")).toMatch(/^RESOLVED/);
    expect(jiraStateMeaning("Parked")).toMatch(/not recognised/);
  });
});

describe("facts read back from the ledger", () => {
  it("keeps Jira keys as keys and Azure DevOps ids as numbers", async () => {
    const { read } = fakeJira();
    const d = await gatherJiraStoryContext(read, { workItem: "SHOP-12" });
    const base = { tool: "attestqa", runId: "r", timestamp: 1 };
    const events = [
      {
        ...base,
        eventId: 1,
        kind: "call",
        payload: { server: "aqa", toolName: "story_context", args: {}, startedAt: 0 },
      },
      {
        ...base,
        eventId: 2,
        kind: "observation",
        payload: {
          eventIdOfCall: 1,
          ok: true,
          result: {
            kind: "preflight",
            summary: d.summary,
            text: d.text,
            facts: JSON.parse(JSON.stringify(d.facts)),
          },
          artefacts: [],
          durationMs: 1,
        },
      },
    ] as unknown as AnyRunEvent[];
    const f = storyFacts(events);
    expect(f?.story?.id).toBe("SHOP-12");
    expect(f?.epic?.id).toBe("SHOP-1");
    expect(f?.tasks).toEqual(["SHOP-13"]);
    expect(f?.filedBugs?.map((b) => b.id)).toEqual(["SHOP-20", "SHOP-21", "SHOP-22"]);
  });
});

describe("a design may cite Jira tasks and bugs as its source", () => {
  it("accepts task SCRUM-9 and bug SCRUM-12 the way it accepts task #46", () => {
    const facts = {
      acceptanceCriteria: ["AC-1"],
      bugs: [],
      tasks: ["SCRUM-9"],
      story: { id: "SCRUM-8", title: "Customer signs out" },
    };
    const design = {
      items: [
        {
          id: "D1",
          covers: "AC-1",
          type: "functional",
          technique: "state-transition",
          conditions: ["signed in"],
          expected: "Login offered again",
          source: "AC-1",
        },
        {
          id: "D2",
          covers: "task SCRUM-9",
          type: "functional",
          technique: "state-transition",
          conditions: ["signed in"],
          expected: "token removed from storage",
          source: "task SCRUM-9",
        },
      ],
      excluded: [],
    };
    const problems = validateDesign(design as never, facts as never, ["functional"]);
    expect(problems.filter((p) => /names no criterion/.test(p))).toEqual([]);
  });
});
