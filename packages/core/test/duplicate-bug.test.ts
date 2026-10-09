import { describe, it, expect } from "vitest";
import { storyRefusal, sameDefect } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * One defect, one record.
 *
 * "Logout does not redirect to the login page" reached Azure DevOps three times
 * from three runs, each arguing it from scratch and each correct, because bugs
 * this runtime files are withheld from its own context on purpose. The withhold
 * stays; the check moves into code, against a list the model never sees.
 */

const FILED = [
  {
    id: 83,
    state: "Active",
    title: "Story-a: Logout redirects to home page instead of login page",
    agent: true,
  },
  { id: 50, state: "Resolved", title: "Session token survives logout", agent: false },
  {
    id: 84,
    state: "Active",
    title: "Logout flow has WCAG A/AA accessibility violations: color-contrast and label",
    agent: true,
  },
];

function ledger(filedBugs = FILED): AnyRunEvent[] {
  const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
  return [
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
          summary: {},
          text: "story 44",
          facts: {
            acceptanceCriteria: [],
            bugs: filedBugs.filter((b) => !b.agent),
            filedBugs,
            tasks: [],
            story: { id: 44, title: "Log out" },
            epic: { id: 42, title: "Customer account access" },
          },
        },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}

const propose = (title: string) => ({
  toolName: "ado.wit_work_item_write",
  args: {
    action: "create",
    workItemType: "Bug",
    project: "agentic-qa-sandbox",
    parentId: 44,
    tags: "agentic-qa",
    title,
  },
});

describe("a defect already filed is not filed again", () => {
  it("refuses the fourth record of the logout redirect", () => {
    const why = storyRefusal(
      propose("Logout does not redirect to the login page — app stays on /#/"),
      ledger(),
    );
    expect(why).toContain("#83");
    expect(why).toContain("same defect");
  });

  it("says why the agent cannot see it, since that is the confusing part", () => {
    const why = storyRefusal(
      propose("AC Story-a: Logout redirects to home page (/#/) instead of login page"),
      ledger(),
    );
    expect(why).toContain("withheld");
  });

  it("does not say that about a bug a person filed", () => {
    const filed = [{ ...FILED[0]!, agent: false }];
    const why = storyRefusal(
      propose("Logout does not redirect to the login page — app stays on /#/"),
      ledger(filed),
    );
    expect(why).toContain("#83");
    expect(why ?? "").not.toContain("withheld");
  });

  it("offers the two honest ways out: report it, or distinguish it", () => {
    const why = storyRefusal(propose("Logout does not redirect to the login page"), ledger());
    expect(why).toContain("say so in your report");
    expect(why).toContain("the title has to show it");
  });

  it("lets an unrelated defect on the same story through", () => {
    expect(
      storyRefusal(propose("Password field accepts leading and trailing whitespace"), ledger()),
    ).toBeUndefined();
  });

  it("lets an accessibility finding through — it shares only the word logout", () => {
    expect(
      storyRefusal(propose("Logout menu item has no accessible name for screen readers"), ledger()),
    ).toBeUndefined();
  });

  it("leaves a closed bug alone: a defect that returns deserves its own record", () => {
    // #50 is Resolved. This runtime cannot reopen a work item, so a fresh
    // record is the only honest way to report a regression.
    expect(storyRefusal(propose("Session token survives logout"), ledger())).toBeUndefined();
  });

  it("says nothing about a test case, which has its own rule", () => {
    const why = storyRefusal(
      {
        toolName: "ado.wit_work_item_write",
        args: {
          action: "create",
          workItemType: "Test Case",
          title: "Logout redirects to login page",
        },
      },
      ledger(),
    );
    expect(why ?? "").not.toContain("same defect");
  });
});

describe("sameDefect is blunt on purpose", () => {
  it("matches three real titles for one defect", () => {
    const a = "Story-a: Logout redirects to home page instead of login page";
    const b = "AC Story-a: Logout redirects to home page (/#/) instead of login page (/#/login)";
    const c = "Logout does not redirect to the login page — app stays on /#/";
    expect(sameDefect(a, b)).toBe(true);
    expect(sameDefect(a, c)).toBe(true);
    expect(sameDefect(b, c)).toBe(true);
  });

  it("separates the other bugs that lived on the same story", () => {
    const redirect = "Logout does not redirect to the login page — app stays on /#/";
    expect(sameDefect(redirect, "Session token survives logout")).toBe(false);
    expect(sameDefect(redirect, "Logout flow has WCAG A/AA accessibility violations")).toBe(false);
    expect(sameDefect(redirect, "Error message persists after email corrected")).toBe(false);
  });

  it("is not fooled by the story label two unrelated bugs share", () => {
    expect(
      sameDefect("Story-a: user cannot sign in", "Story-a: password field is not masked"),
    ).toBe(false);
  });
});
