import { describe, it, expect } from "vitest";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Two rules about what a bug may SAY, both learned from story #44's run
 * 20260925T174149Z: a defect record may only carry what the run observed, and
 * an accessibility defect has to be able to name the part of the page that
 * fails.
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

const LOGOUT = "Story-a — Signed-in user can log out via the account menu";
const A11Y = "Accessibility — Logout flow has no WCAG A/AA violations";

const SPEC = [
  'import { test, expect } from "@playwright/test";',
  'import AxeBuilder from "@axe-core/playwright";',
  `test("${LOGOUT}", async ({ page }) => {`,
  "  await clickLogout(page);",
  "  await expect(page).toHaveURL(/\\/#\\/login/);",
  '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
  "});",
  `test("${A11Y}", async ({ page }) => {`,
  '  const r = await new AxeBuilder({ page }).withTags(["wcag2a"]).analyze();',
  "  expect(r.violations.map((v) => v.id)).toEqual([]);",
  "});",
].join("\n");

const bug = (title: string, repro: string) => ({
  toolName: "ado.wit_work_item_write",
  args: {
    action: "create",
    workItemType: "Bug",
    parentId: "44",
    tags: "agentic-qa",
    fields: { "System.Title": title, "Microsoft.VSTS.TCM.ReproSteps": `<div>${repro}</div>` },
  },
});

const runWith = (failures: Array<{ title: string; message: string }>) =>
  ledgerOf([
    { tool: "fs.read_file", args: { path: "tests/epic-42.spec.ts" }, result: { content: SPEC } },
    {
      tool: "pw.run_tests",
      result: { passed: 8, failed: failures.length, skipped: 0, flaky: 0, green: false, failures },
    },
  ]);

describe("a bug may only claim what the run observed", () => {
  const URL_FAILURE = {
    title: LOGOUT,
    message:
      'Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /\\/#\\/login/\nReceived string: "http://localhost:3100/#/"',
  };

  it("refuses the claim about a check that never ran", () => {
    const why = storyRefusal(
      bug(
        "Logout does not redirect to login page or clear the session token",
        "The redirect does not happen and the localStorage token is still present after logout.",
      ),
      runWith([URL_FAILURE]),
    );
    expect(why).toContain("never ran");
    expect(why).toContain("token");
  });

  it("allows the bug that claims only what failed", () => {
    expect(
      storyRefusal(
        bug(
          "Logout does not redirect to the login page",
          "After clicking Logout the URL stays on /#/ instead of /#/login.",
        ),
        runWith([URL_FAILURE]),
      ),
    ).toBeUndefined();
  });
});

describe("an accessibility bug needs a scoped scan", () => {
  const A11Y_FAILURE = {
    title: A11Y,
    message: "Error: Accessibility violations found: color-contrast, label",
  };

  it("refuses a bug from a whole-page scan", () => {
    const why = storyRefusal(
      bug(
        "Logout flow has WCAG A/AA violations",
        "axe reported color-contrast and label violations.",
      ),
      runWith([A11Y_FAILURE]),
    );
    expect(why).toContain("scans the WHOLE page");
  });

  it("does not refuse a bug about another test because the scan is unscoped", () => {
    // 20261018T154651Z: eighteen page-button bugs refused with a reason about the scan.
    const why = storyRefusal(
      bug(
        "AC-3: Current page button is not marked as active",
        "the Page-2 button has no active class.",
      ),
      runWith([A11Y_FAILURE]),
    );
    expect(why ?? "").not.toContain("scans the WHOLE page");
  });

  it("allows it once the scan is scoped", () => {
    const scoped = SPEC.replace(
      "new AxeBuilder({ page })",
      'new AxeBuilder({ page }).include("#navbarAccount")',
    );
    const events = ledgerOf([
      {
        tool: "fs.read_file",
        args: { path: "tests/epic-42.spec.ts" },
        result: { content: scoped },
      },
      {
        tool: "pw.run_tests",
        result: {
          passed: 8,
          failed: 1,
          skipped: 0,
          flaky: 0,
          green: false,
          failures: [A11Y_FAILURE],
        },
      },
    ]);
    expect(
      storyRefusal(
        bug(
          "Logout flow has WCAG A/AA violations",
          "axe reported color-contrast and label violations.",
        ),
        events,
      ),
    ).toBeUndefined();
  });
});

describe("a heal is not evidence-destruction", () => {
  const TITLE = "Story-a — Signed-in user can log out via the account menu";
  const CLAIM = "  await expect(page).toHaveURL(/\\/#\\/login/);";

  const specWith = (step: string) =>
    [`test("${TITLE}", async ({ page }) => {`, step, CLAIM, "});"].join("\n");

  const triageEvent = (eventId: number, attempt: number, evidence: string): AnyRunEvent =>
    ({
      tool: "agentic-qa",
      runId: "r",
      eventId,
      timestamp: 1,
      kind: "triage",
      payload: {
        attempt,
        reportFingerprint: `f${attempt}`,
        runLevel: null,
        verdicts: [
          {
            test: `tests/e.spec.ts › ${TITLE}`,
            category: "real-defect",
            confidence: 0.7,
            evidence,
            rationale: "",
            matchedPatterns: ["(?i)expect\\("],
          },
        ],
        quarantined: [TITLE],
      },
    }) as unknown as AnyRunEvent;

  const events = (before: string, after: string): AnyRunEvent[] => [
    ...ledgerOf([
      { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: before } },
      { tool: "fs.write_file", args: { path: "tests/e.spec.ts", content: after } },
    ]),
    triageEvent(900, 1, "Error: localStorage token should be cleared after logout"),
    triageEvent(901, 2, "Error: expect(page).toHaveURL(expected) failed"),
  ];

  it("records a repair that kept every claim as a limitation, not a gap", async () => {
    const { triageGaps } = await import("../src/triage/step.js");
    const out = triageGaps(
      events(
        specWith('  await page.locator("a").click().catch(() => page.goto("/#/logout"));'),
        specWith('  await page.getByRole("menuitem", { name: "Logout" }).click();'),
      ),
    );
    expect(out.gaps.map((g) => g.code)).not.toContain("quarantined-test-modified");
    expect(out.limitations.join(" ")).toContain("kept every assertion");
  });

  it("still reports an edit that dropped a claim", async () => {
    const { triageGaps } = await import("../src/triage/step.js");
    const out = triageGaps(
      events(
        specWith('  await page.locator("a").click();'),
        [
          `test("${TITLE}", async ({ page }) => {`,
          '  await page.locator("a").click();',
          "});",
        ].join("\n"),
      ),
    );
    expect(out.gaps.map((g) => g.code)).toContain("quarantined-test-modified");
  });
});

describe("the baseline for a write is the file, read or not", () => {
  const TITLE = "Story-a — Signed-in user can log out via the account menu";
  const ON_DISK = [
    `test("${TITLE}", async ({ page }) => {`,
    '  await page.getByRole("menuitem", { name: "Logout" }).click();',
    "  await expect(page).toHaveURL(/\\/#\\/login/);",
    '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
    "});",
  ].join("\n");
  const SOFTENED = [
    `test("${TITLE}", async ({ page }) => {`,
    '  await page.getByRole("menuitem", { name: "Logout" }).click();',
    '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
    "});",
  ].join("\n");

  it("refuses a dropped claim even when the run never read the spec", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { makeStoryRefusal } = await import("../src/skills/story-rules.js");

    const ws = mkdtempSync(join(tmpdir(), "aqa-baseline-"));
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "e.spec.ts"), ON_DISK);

    // A ledger with a quarantine and NO read of the spec — the hole that let
    // Story-a lose its redirect assertion in 20260925T184615Z.
    const events: AnyRunEvent[] = [
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 0,
        timestamp: 1,
        kind: "route",
        payload: { path: "B", reason: "", because: {}, denied: [] },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "triage",
        payload: {
          attempt: 1,
          reportFingerprint: "f",
          runLevel: null,
          verdicts: [
            {
              test: `tests/e.spec.ts › ${TITLE}`,
              category: "real-defect",
              confidence: 0.7,
              evidence: "Error: expect(page).toHaveURL(expected) failed",
              rationale: "",
              matchedPatterns: ["(?i)expect\\("],
            },
          ],
          quarantined: [TITLE],
        },
      } as unknown as AnyRunEvent,
    ];

    const refuse = makeStoryRefusal({ workspaceDir: ws });
    const why = refuse(
      { toolName: "fs.write_file", args: { path: "tests/e.spec.ts", content: SOFTENED } },
      events,
    );
    expect(why).toContain("drops the claim");
    expect(why).toContain("toHaveURL");
  });
});

describe("what a test claims includes what it expects", () => {
  it("sees a relaxed pattern as a dropped claim", async () => {
    const { assertionsOf } = await import("../src/design/test-design.js");
    const strict = "await expect(page).toHaveURL(/\\/#\\/login/, { timeout: 5000 });";
    const relaxed = "await expect(page).toHaveURL(/\\/#\\//);";
    // The signature used to be "page.toHaveURL" for both, which is how a
    // retreat passed for a repair (20260925T192122Z).
    expect(assertionsOf(strict)).not.toEqual(assertionsOf(relaxed));
    // A timeout is not part of the claim.
    expect(assertionsOf(strict)).toEqual(
      assertionsOf("await expect(page).toHaveURL(/\\/#\\/login/, { timeout: 10000 });"),
    );
  });

  it("refuses the relaxed rewrite of a quarantined test", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const TITLE = "Story-a — Signed-in user can log out via the account menu";
    const before = [
      `test("${TITLE}", async ({ page }) => {`,
      "  await expect(page).toHaveURL(/\\/#\\/login/, { timeout: 5000 });",
      "});",
    ].join("\n");
    const after = [
      `test("${TITLE}", async ({ page }) => {`,
      "  await expect(page).toHaveURL(/\\/#\\//);",
      "});",
    ].join("\n");
    const events: AnyRunEvent[] = [
      ...ledgerOf([
        { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: before } },
      ]),
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 50,
        timestamp: 1,
        kind: "route",
        payload: { path: "B", reason: "", because: {}, denied: [] },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 51,
        timestamp: 1,
        kind: "triage",
        payload: {
          attempt: 1,
          reportFingerprint: "f",
          runLevel: null,
          verdicts: [
            {
              test: `tests/e.spec.ts › ${TITLE}`,
              category: "real-defect",
              confidence: 0.7,
              evidence: "Error: expect(page).toHaveURL(expected) failed",
              rationale: "",
              matchedPatterns: ["x"],
            },
          ],
          quarantined: [TITLE],
        },
      } as unknown as AnyRunEvent,
    ];
    const why = storyRefusal(
      { toolName: "fs.write_file", args: { path: "tests/e.spec.ts", content: after } },
      events,
    );
    expect(why).toContain("drops the claim");
  });
});

describe("one bug per failing test, and only when the test is the same", () => {
  it("does not collapse bugs about different tests", async () => {
    const { settleBugs } = await import("../src/triage/settle.js");
    const failures = (titles: string[]) =>
      titles.map((title) => ({ title, file: "tests/e.spec.ts", message: "Error: x" }));
    const events = ledgerOf([
      {
        tool: "pw.run_tests",
        result: {
          passed: 10,
          failed: 3,
          skipped: 0,
          flaky: 0,
          green: false,
          failures: failures([
            "Story-a — Signed-in user can log out via the account menu",
            "Story-c — After logout, navigating to the account page redirects to login",
            "Accessibility — Logout flow has no WCAG A/AA violations",
          ]),
          tests: [
            {
              title: "Story-a — Signed-in user can log out via the account menu",
              status: "failed",
            },
            {
              title: "Story-c — After logout, navigating to the account page redirects to login",
              status: "failed",
            },
            { title: "Accessibility — Logout flow has no WCAG A/AA violations", status: "failed" },
          ],
        },
      },
    ]);
    const proposals = [
      "Story-a: Logout redirects to home page instead of login page",
      "Story-c: After logout, navigating to /#/profile does not redirect to login",
      "Accessibility: WCAG A/AA violations detected in logout flow",
    ].map((t) => ({
      toolName: "ado.wit_work_item_write",
      args: {
        action: "create",
        workItemType: "Bug",
        parentId: "44",
        tags: "agentic-qa",
        fields: { "System.Title": t },
      },
    })) as never[];

    const out = settleBugs(proposals, events, { workItem: "44", runLevel: null });
    expect(out.keep).toHaveLength(3);
    expect(out.drop).toHaveLength(0);
  });
});

describe("an expectation may not offer an alternative", () => {
  const item = (expected: string) => ({
    id: "D9",
    covers: "story",
    type: "functional",
    technique: "state-transition",
    conditions: ["user clicks Logout"],
    expected,
    source: "story description",
  });

  const facts = {
    acceptanceCriteria: [],
    bugs: [],
    tasks: [],
    story: { id: 44, title: "Log out of an account", type: "User Story" },
    epic: { id: 42, title: "Customer account access" },
  };

  const problemsFor = async (expected: string) => {
    const { parseDesign, validateDesign } = await import("../src/design/test-design.js");
    return validateDesign(
      parseDesign({ items: [item(expected)] }),
      facts as never,
      ["functional"] as never,
    );
  };

  it("refuses the hedge that reached a reviewer", async () => {
    // 20260925T194528Z, D9, verbatim.
    const problems = await problemsFor(
      "After clicking Logout via the account menu, the URL changes to /#/login " +
        "(or the session ends and the user is no longer shown as signed in)",
    );
    expect(problems.join(" ")).toContain("offers an alternative");
  });

  it("accepts one expectation", async () => {
    const problems = await problemsFor("After clicking Logout the URL is /#/login");
    expect(problems.join(" ")).not.toContain("offers an alternative");
  });

  it("leaves a list of conditions alone", async () => {
    const problems = await problemsFor(
      "The error message is identical for a wrong password or an unregistered email",
    );
    expect(problems.join(" ")).not.toContain("offers an alternative");
  });
});

describe("a claim is what an assertion SAYS, not the code around it", () => {
  const TITLE = "Story-a — Signed-in user can log out via the account menu";
  // Story #44's spec, in the order its assertions run.
  const SPEC = [
    `test("${TITLE}", async ({ page }) => {`,
    '  expect(tokenBefore, "localStorage token should be set after login (precondition)").not.toBeNull();',
    "  await expect(page).toHaveURL(/\\/#\\/login/, { timeout: 5000 });",
    '  await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible();',
    '  expect(tokenAfter, "localStorage token should be cleared after logout").toBeNull();',
    "});",
  ].join("\n");

  const events = ledgerOf([
    { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: SPEC } },
    {
      tool: "pw.run_tests",
      result: {
        passed: 11,
        failed: 1,
        skipped: 0,
        flaky: 0,
        green: false,
        failures: [
          {
            title: TITLE,
            message:
              'Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /\\/#\\/login/\nReceived string: "http://localhost:3100/#/"',
          },
        ],
      },
    },
  ]);

  const bug = (title: string, repro: string) => ({
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Bug",
      parentId: "44",
      tags: "agentic-qa",
      fields: { "System.Title": title, "Microsoft.VSTS.TCM.ReproSteps": `<div>${repro}</div>` },
    },
  });

  it("allows a bug that describes how it clicked, in code words", () => {
    // Verbatim from the run this rule wrongly refused four times.
    const why = storyRefusal(
      bug(
        "Story-a: Logout redirects to home page instead of login page",
        "The Logout menu item was clicked via getByRole('menuitem', { name: 'Logout' }) — confirmed " +
          "present by heal_locator. The page then stayed on /#/ instead of /#/login.",
      ),
      events,
    );
    expect(why).toBeUndefined();
  });

  it("still refuses a claim about what a later assertion would have checked", () => {
    const why = storyRefusal(
      bug(
        "Logout does not redirect to login page or clear the session token",
        "The redirect does not happen and the localStorage token is still present after logout.",
      ),
      events,
    );
    expect(why).toContain("never ran");
    expect(why).toContain("token");
  });
});

describe("two bugs about two tests stay two bugs", () => {
  it("matches a bug to its test by the name in front of the colon", async () => {
    const { settleBugs } = await import("../src/triage/settle.js");
    const TESTS = [
      "Story-a — Signed-in user can log out via the account menu",
      "Story-c — After logout, navigating to the account page redirects to login",
    ];
    const events = ledgerOf([
      {
        tool: "pw.run_tests",
        result: {
          passed: 11,
          failed: 2,
          skipped: 0,
          flaky: 0,
          green: false,
          failures: TESTS.map((title) => ({
            title,
            file: "tests/e.spec.ts",
            message: "Error: toHaveURL",
          })),
          tests: TESTS.map((title) => ({ title, status: "failed" })),
        },
      },
    ]);
    // Verbatim titles from run 20260926T132210Z, where the second was dropped.
    const proposals = [
      "AC Story-a: Logout redirects to home page (/#/) instead of login page (/#/login)",
      "AC Story-c: After logout, navigating to /#/profile does not redirect to /#/login",
    ].map((t) => ({
      toolName: "ado.wit_work_item_write",
      args: {
        action: "create",
        workItemType: "Bug",
        parentId: "44",
        tags: "agentic-qa",
        fields: { "System.Title": t },
      },
    })) as never[];

    const out = settleBugs(proposals, events, { workItem: "44", runLevel: null });
    expect(out.keep).toHaveLength(2);
    expect(out.drop).toHaveLength(0);
  });
});

describe("a claim read from the element's parent is the same claim", () => {
  // 20261018T125846Z: Toolshop puts `active` on the list item around the page
  // button; moving the assertion there was refused eight times.
  const TITLE = "AC-2 Choosing page 2 shows a different set of products";
  const spec = (target: string) =>
    [
      `test("${TITLE}", async ({ page }) => {`,
      '  await page.getByRole("button", { name: "Page-2" }).click();',
      `  await expect(${target}).toHaveClass(/active/);`,
      "});",
    ].join("\n");
  const BUTTON = 'page.getByRole("button", { name: "Page-2" })';

  async function refusal(after: string): Promise<string | undefined> {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { makeStoryRefusal } = await import("../src/skills/story-rules.js");
    const ws = mkdtempSync(join(tmpdir(), "aqa-relative-"));
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "e.spec.ts"), spec(BUTTON));
    const events = [
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 0,
        timestamp: 1,
        kind: "route",
        payload: { path: "A", reason: "", because: {}, denied: [] },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 2,
        timestamp: 1,
        kind: "call",
        payload: {
          server: "bdd2pw",
          toolName: "scaffold",
          args: { feature: "features/e.feature", url: "http://x" },
          startedAt: 0,
        },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 3,
        timestamp: 1,
        kind: "observation",
        payload: {
          eventIdOfCall: 2,
          ok: true,
          result: { exitCode: 0, wrote: ["tests/e.spec.ts"] },
          artefacts: ["tests/e.spec.ts"],
          durationMs: 1,
        },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 4,
        timestamp: 1,
        kind: "call",
        payload: {
          server: "fs",
          toolName: "read_file",
          args: { path: "tests/e.spec.ts" },
          startedAt: 0,
        },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 5,
        timestamp: 1,
        kind: "observation",
        payload: {
          eventIdOfCall: 4,
          ok: true,
          result: { path: "tests/e.spec.ts", content: spec(BUTTON) },
          artefacts: [],
          durationMs: 1,
        },
      } as unknown as AnyRunEvent,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "triage",
        payload: {
          attempt: 2,
          reportFingerprint: "f",
          runLevel: null,
          verdicts: [
            {
              test: `tests/e.spec.ts › ${TITLE}`,
              category: "real-defect",
              confidence: 0.1,
              evidence: "Error: expect(locator).toHaveClass(expected) failed",
              rationale: "",
              matchedPatterns: [],
            },
          ],
          quarantined: [TITLE],
        },
      } as unknown as AnyRunEvent,
    ];
    return makeStoryRefusal({ workspaceDir: ws })(
      { toolName: "fs.write_file", args: { path: "tests/e.spec.ts", content: spec(after) } },
      events,
    );
  }

  it("allows the same assertion on the old element's parent", async () => {
    expect(await refusal(`${BUTTON}.locator("..")`)).toBeUndefined();
    expect(
      await refusal(`page.locator("li.page-item").filter({ has: ${BUTTON} })`),
    ).toBeUndefined();
  });

  it("still refuses the assertion moved to an unrelated element", async () => {
    expect(await refusal('page.locator("li.page-item").first()')).toContain("drops the claim");
  });
});
