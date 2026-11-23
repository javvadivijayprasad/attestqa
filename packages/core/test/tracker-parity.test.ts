import { describe, it, expect } from "vitest";
import { storyRefusal } from "../src/skills/story-rules.js";
import { proposedBug } from "../src/governance/bug-view.js";
import { trackerTools, STORY_TO_TESTS_TOOLS } from "../src/skills/story-to-tests.js";
import { DEFECT_PROFILE_SOURCES, DEFECT_PROFILE_TOOLS } from "../src/skills/defect-profile.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Tracker parity audit (2.5.0, slice 1).
 *
 * Every rule that judges a write to the tracker is given one situation twice:
 * as the Azure DevOps call and as the Jira call that means the same thing. The
 * table below is the record of what each tracker's run is told. It was written
 * to find out, before the tracker seam is built, which rules really are Azure
 * DevOps only — the roadmap said about twelve of thirteen.
 *
 * What it found (21 Nov 2026) is at the bottom of this file. A change that
 * moves any row has to change the row here.
 */

type Call = { toolName: string; args: Record<string, unknown> };
type Entry = { tool: string; args?: Record<string, unknown>; result?: unknown };

function ledgerOf(entries: Entry[]): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  let id = 0;
  const base = { tool: "attestqa" as const, runId: "r", timestamp: 1 };
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
    } as unknown as AnyRunEvent);
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
    } as unknown as AnyRunEvent);
  }
  return events;
}

type Tracker = "ado" | "jira";
const STORY: Record<Tracker, number | string> = { ado: 44, jira: "TOOL-6" };
const EPIC: Record<Tracker, number | string> = { ado: 42, jira: "TOOL-3" };

type Filed = {
  id: number | string;
  state: string;
  title: string;
  agent?: boolean;
  text?: string;
  linked?: boolean;
};

/** The story as the run's first read gives it: the same facts for either tracker. */
const context = (tracker: Tracker, filedBugs: Filed[] = []): Entry => ({
  tool: "aqa.story_context",
  result: {
    kind: "preflight",
    summary: {},
    text: `story ${STORY[tracker]}`,
    facts: {
      acceptanceCriteria: [],
      bugs: [],
      filedBugs,
      tasks: [],
      story: { id: STORY[tracker], title: "Log out" },
      epic: { id: EPIC[tracker], title: "Customer account access" },
    },
  },
});

/** One proposed bug in each tracker's own call. `link: null` leaves the story link out. */
function bug(tracker: Tracker, title: string, repro: string, link?: number | string | null): Call {
  const story = link === undefined ? STORY[tracker] : link;
  if (tracker === "jira")
    return {
      toolName: "jira.create_bug",
      args: {
        projectKey: "TOOL",
        ...(story === null ? {} : { storyKey: story }),
        summary: title,
        description: repro,
      },
    };
  return {
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Bug",
      ...(story === null ? {} : { parentId: story }),
      tags: "agentic-qa",
      fields: { "System.Title": title, "Microsoft.VSTS.TCM.ReproSteps": `<div>${repro}</div>` },
    },
  };
}

const LOGOUT = "Story-a — Signed-in user can log out via the account menu";
const A11Y = "Accessibility — Logout flow has no WCAG A/AA violations";
const SPEC_PATH = "tests/epic-42.spec.ts";

const spec = (logoutStep: string) =>
  [
    'import { test, expect } from "@playwright/test";',
    'import AxeBuilder from "@axe-core/playwright";',
    `test("${LOGOUT}", async ({ page }) => {`,
    `  ${logoutStep}`,
    "  await expect(page).toHaveURL(/\\/#\\/login/);",
    '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
    "});",
    `test("${A11Y}", async ({ page }) => {`,
    '  const r = await new AxeBuilder({ page }).withTags(["wcag2a"]).analyze();',
    "  expect(r.violations.map((v) => v.id)).toEqual([]);",
    "});",
  ].join("\n");

const readSpec = (logoutStep = "await clickLogout(page);"): Entry => ({
  tool: "fs.read_file",
  args: { path: SPEC_PATH },
  result: { content: spec(logoutStep) },
});

const suite = (failures: Array<{ title: string; message: string }>): Entry => ({
  tool: "pw.run_tests",
  args: { spec: SPEC_PATH },
  result: { passed: 8, failed: failures.length, skipped: 0, flaky: 0, green: false, failures },
});

const URL_FAILURE = {
  title: LOGOUT,
  message:
    'Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /\\/#\\/login/\nReceived string: "http://localhost:3100/#/"',
};
const LOCATOR_FAILURE = {
  title: LOGOUT,
  message:
    "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Log out')\n" +
    "Expected: visible\nTimeout: 5000ms\nError: element(s) not found\n\nCall log:\n" +
    "  - waiting for getByText('Log out')",
};
const A11Y_FAILURE = {
  title: A11Y,
  message: "Error: Accessibility violations found: color-contrast, label",
};

const REDIRECT_BUG = [
  "Logout does not redirect to the login page",
  "After clicking Logout the URL stays on /#/ instead of /#/login.",
] as const;

interface Row {
  rule: string;
  situation: string;
  /** What must be in the refusal, for both trackers; null when the call must go through. */
  refused: RegExp | null;
  events: (t: Tracker) => Entry[];
  call: (t: Tracker) => Call;
}

const ROWS: Row[] = [
  {
    rule: "unlinkedBug",
    situation: "a bug with no link to the story",
    refused: /this bug is missing one thing/,
    events: (t) => [context(t), readSpec(), suite([URL_FAILURE])],
    call: (t) => bug(t, ...REDIRECT_BUG, null),
  },
  {
    rule: "unlinkedBug",
    situation: "a bug linked to another story",
    refused: /this bug is missing one thing/,
    events: (t) => [context(t), readSpec(), suite([URL_FAILURE])],
    call: (t) => bug(t, ...REDIRECT_BUG, t === "jira" ? "TOOL-99" : 99),
  },
  {
    rule: "duplicateBug",
    situation: "an open bug already says this, under another title",
    refused: /already says this/,
    events: (t) => [
      context(t, [
        {
          id: t === "jira" ? "TOOL-83" : 83,
          state: t === "jira" ? "To Do" : "Active",
          title: "Story-a: Logout redirects to home page instead of login page",
          agent: true,
        },
      ]),
      readSpec(),
      suite([URL_FAILURE]),
    ],
    call: (t) => bug(t, "Logout does not redirect to the login page — app stays on /#/", "x"),
  },
  {
    rule: "duplicateBug",
    situation: "an open bug names the failing test in its text",
    refused: /already says this/,
    events: (t) => [
      context(t, [
        {
          id: t === "jira" ? "TOOL-84" : 84,
          state: t === "jira" ? "To Do" : "Active",
          title: "Account menu problem",
          text: `Failing test: ${LOGOUT}`,
          agent: true,
          linked: true,
        },
      ]),
      readSpec(),
      suite([URL_FAILURE]),
    ],
    call: (t) => bug(t, "The session is kept", `Failing test: ${LOGOUT}. The URL stays on /#/.`),
  },
  {
    rule: "unhealedLocator",
    situation: "a bug while a locator that matched nothing has not been looked at",
    refused: /locator in this run matched nothing/,
    events: (t) => [context(t), readSpec(), suite([LOCATOR_FAILURE])],
    call: (t) => bug(t, ...REDIRECT_BUG),
  },
  {
    rule: "swallowedFailure",
    situation: "a bug from a test that catches its own failure",
    refused: /catch/,
    events: (t) => [
      context(t),
      readSpec("await clickLogout(page).catch(() => {});"),
      suite([URL_FAILURE]),
    ],
    call: (t) => bug(t, ...REDIRECT_BUG),
  },
  {
    rule: "unobservedClaim",
    situation: "a bug that claims a check which never ran",
    refused: /never ran/,
    events: (t) => [context(t), readSpec(), suite([URL_FAILURE])],
    call: (t) =>
      bug(
        t,
        "Logout does not redirect to login page or clear the session token",
        "The redirect does not happen and the localStorage token is still present after logout.",
      ),
  },
  {
    rule: "unscopedAccessibilityBug",
    situation: "an accessibility bug from a scan of the whole page",
    refused: /scans the WHOLE page/,
    events: (t) => [context(t), readSpec(), suite([A11Y_FAILURE])],
    call: (t) =>
      bug(
        t,
        "Logout flow has WCAG A/AA violations",
        "axe reported color-contrast and label violations.",
      ),
  },
  {
    rule: "(none)",
    situation: "a linked bug that claims only what failed",
    refused: null,
    events: (t) => [context(t), readSpec(), suite([URL_FAILURE])],
    call: (t) => bug(t, ...REDIRECT_BUG),
  },
];

const judge = (row: Row, t: Tracker) => storyRefusal(row.call(t), ledgerOf(row.events(t)));

describe("tracker parity: every bug rule judges a Jira bug as it judges an Azure DevOps bug", () => {
  for (const row of ROWS) {
    it(`${row.rule}: ${row.situation}`, () => {
      const ado = judge(row, "ado");
      const jira = judge(row, "jira");
      if (row.refused === null) {
        expect(ado).toBeUndefined();
        expect(jira).toBeUndefined();
        return;
      }
      expect(ado).toMatch(row.refused);
      expect(jira).toMatch(row.refused);
    });
  }
});

describe("tracker parity: one proposed bug, whichever tracker it is written for", () => {
  it("reads the same title, steps, story link and tag from either tracker's call", () => {
    const ado = proposedBug(bug("ado", ...REDIRECT_BUG));
    const jira = proposedBug(bug("jira", ...REDIRECT_BUG));
    expect(ado).toEqual({
      tracker: "ado",
      title: REDIRECT_BUG[0],
      repro: `<div>${REDIRECT_BUG[1]}</div>`,
      story: 44,
      tags: "agentic-qa",
    });
    expect(jira).toEqual({
      tracker: "jira",
      title: REDIRECT_BUG[0],
      repro: REDIRECT_BUG[1],
      story: "TOOL-6",
      tags: "agentic-qa",
    });
  });

  it("reads Azure DevOps fields given as a list, and a title given outside them", () => {
    const listed = proposedBug({
      toolName: "ado.wit_work_item_write",
      args: {
        action: "create",
        workItemType: "Bug",
        title: "Outside",
        fields: [
          { name: "System.Title", value: "Inside" },
          { name: "Microsoft.VSTS.TCM.ReproSteps", value: "steps" },
          { name: "System.Tags", value: "agentic-qa; login" },
        ],
      },
    });
    expect(listed).toMatchObject({ title: "Outside", repro: "steps", tags: "agentic-qa; login" });
    expect(listed?.story).toBeUndefined();
  });

  it("keeps the labels a Jira bug passes, with the one the adapter always adds", () => {
    const b = proposedBug({
      toolName: "jira.create_bug",
      args: { projectKey: "TOOL", summary: "x", labels: ["login", "agentic-qa"] },
    });
    expect(b?.tags).toBe("agentic-qa; login");
    expect(b?.repro).toBe("");
  });

  it("is not a proposed bug when the call creates something else, or creates nothing", () => {
    const write = (args: Record<string, unknown>) =>
      proposedBug({ toolName: "ado.wit_work_item_write", args });
    expect(write({ action: "create", workItemType: "Task" })).toBeUndefined();
    expect(write({ action: "update", workItemType: "Bug" })).toBeUndefined();
    expect(proposedBug({ toolName: "jira.record_qa", args: {} })).toBeUndefined();
  });
});

describe("tracker parity: the run report is the runtime's to post, in both trackers", () => {
  it("refuses the agent's own report as a comment and as a Jira QA record", () => {
    const ado = storyRefusal(
      {
        toolName: "ado.wit_work_item_comment_write",
        args: { workItemId: 44, text: "## agentic-qa run\n5 of 5 passed" },
      },
      ledgerOf([context("ado")]),
    );
    const jira = storyRefusal(
      { toolName: "jira.record_qa", args: { storyKey: "TOOL-6" } },
      ledgerOf([context("jira")]),
    );
    expect(ado).toMatch(/the runtime posts the run report itself/);
    expect(jira).toMatch(/kept by the runtime at the end of the run/);
  });
});

describe("tracker parity: what Jira has no counterpart for", () => {
  it("offers a Jira run no test-case, suite or plan tool, so their rules have nothing to judge", () => {
    const jira = trackerTools("jira", STORY_TO_TESTS_TOOLS);
    expect(jira.filter((x) => x.startsWith("ado."))).toEqual([]);
    expect(jira.filter((x) => x.startsWith("jira.")).sort()).toEqual([
      "jira.create_bug",
      "jira.get_issue",
      "jira.list_comments",
      "jira.record_qa",
      "jira.search",
    ]);
  });
});

/**
 * Words in a refusal that only an Azure DevOps user can act on. A Jira run that
 * is told to "pass parentId" has been told nothing it can do.
 */
const ADO_ONLY_WORDS =
  /parentId|System\.[A-Z]\w+|Microsoft\.VSTS|workItemType|ado\.\w+|Azure DevOps|ReproSteps/;

describe("tracker parity: what a Jira run is told", () => {
  /**
   * Rules whose refusal, shown to a Jira run, names Azure DevOps fields. The
   * audit of 21 Nov 2026 found the two unlinkedBug rows here; both were fixed in
   * the next change, and the set is kept empty so a new one shows up as a failure.
   */
  const SPEAKS_ADO_TO_JIRA = new Set<string>([]);

  for (const row of ROWS.filter((r) => r.refused !== null)) {
    it(`${row.rule}: ${row.situation}`, () => {
      const jira = judge(row, "jira") ?? "";
      const key = `${row.rule}: ${row.situation}`;
      expect({ key, speaksAdo: ADO_ONLY_WORDS.test(jira) }).toEqual({
        key,
        speaksAdo: SPEAKS_ADO_TO_JIRA.has(key),
      });
    });
  }

  it("names the link to the story as each tracker's own tool names it", () => {
    for (const row of ROWS.filter((r) => r.rule === "unlinkedBug")) {
      expect(judge(row, "ado")).toContain("parentId: 44 —");
      expect(judge(row, "jira")).toContain('storyKey: "TOOL-6" —');
    }
  });

  it("names an existing bug as its tracker writes it: #83, and the Jira key alone", () => {
    const row = ROWS.find((r) => r.situation.startsWith("an open bug already says this")) as Row;
    expect(judge(row, "ado")).toMatch(/^#83 \[Active\]/);
    expect(judge(row, "jira")).toMatch(/^TOOL-83 \[To Do\]/);
  });
});

describe("tracker parity: skills that read one tracker only", () => {
  it("reads the bug history for a defect profile from Azure DevOps and nowhere else", () => {
    expect(DEFECT_PROFILE_SOURCES.every((x) => x.startsWith("ado."))).toBe(true);
    expect(DEFECT_PROFILE_TOOLS.some((x) => x.startsWith("jira."))).toBe(false);
  });
});

/*
 * What the audit found (21 Nov 2026).
 *
 * 1. The bug rules are NOT Azure DevOps only. All six (unlinkedBug, duplicateBug,
 *    unhealedLocator, swallowedFailure, unobservedClaim, unscopedAccessibilityBug)
 *    refuse a Jira bug in the situations where they refuse an Azure DevOps bug.
 *    At the audit that was because `asAdoBug` showed them the Jira call in the
 *    shape they checked; they now read a `ProposedBug` that names no tracker. The
 *    roadmap's "a duplicate or unlinked bug goes through on Jira" is out of date.
 * 2. The run report is refused for both, each with its own wording.
 * 3. The test-case, suite and plan rules have nothing to judge on Jira: a Jira
 *    run is offered no such tool (ADR-004: the QA sub-task, kept by the runtime).
 * 4. Gaps:
 *    a. FIXED in the next change. unlinkedBug told a Jira run to pass `parentId`.
 *       The Jira argument is `storyKey`, and the refusal now names it.
 *    b. FIXED in the next change. duplicateBug wrote a Jira key as "#TOOL-83";
 *       it now writes "TOOL-83".
 *    c. OPEN. The defect-profile skill cannot run against Jira at all.
 * 5. Not covered here: the end-of-run settlement (`triage/settle.ts`) and the
 *    verifier, which use the same view and have their own Jira tests
 *    (`jira-tracker.test.ts`, `settle.test.ts`).
 */
