import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseRoute, AUTHORING_TOOLS, renderRoute } from "../src/route/route.js";
import type { StoryFacts } from "../src/design/test-design.js";

/**
 * The route is the one decision this runtime took away from the model, so these
 * tests are about STATE: what is on disk decides, and nothing else.
 */

const FEATURE = [
  "Feature: Customer account access",
  "",
  "  @story:1 @ac:1 @design:D1",
  "  Scenario: AC-1 — signs in with correct credentials",
  "    Given I am on the login page",
  "",
  "  @story:44 @design:D9",
  "  Scenario: Story-a — logs out via the account menu",
  "    Given I am signed in",
].join("\n");

const SPEC = [
  'import { test, expect } from "@playwright/test";',
  'test.describe("Customer account access", () => {',
  "  // @story:1 @ac:1 @design:D1",
  '  test("AC-1 — signs in with correct credentials", async ({ page }) => {',
  '    await page.goto("/#/login");',
  "  });",
  "  // @story:44 @design:D9",
  '  test("Story-a — logs out via the account menu", async ({ page }) => {',
  '    await page.goto("/#/");',
  "  });",
  "});",
].join("\n");

function facts(story: number): StoryFacts {
  return {
    acceptanceCriteria: [],
    bugs: [],
    tasks: [],
    story: { id: story, title: "Login", type: "User Story" },
    epic: { id: 42, title: "Customer account access" },
  } as unknown as StoryFacts;
}

function workspace(files: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-route-"));
  for (const [rel, text] of Object.entries(files)) {
    const parts = rel.split("/");
    parts.pop();
    if (parts.length > 0) mkdirSync(join(ws, ...parts), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  return ws;
}

const EPIC_FEATURE = "features/epic-42-customer-account-access.feature";
const EPIC_SPEC = "tests/epic-42-customer-account-access.spec.ts";

describe("the route is decided by what is on disk", () => {
  it("stops the run when there is no framework at all", () => {
    const d = chooseRoute({ facts: facts(1), workspaceDir: workspace({}), frameworkFound: false });
    expect(d.path).toBe("P0");
    // 20260925T144905Z spent a whole run against the runtime's own sample project.
    expect(d.stop).toContain("npm init playwright@latest");
  });

  it("authors when the epic has no feature file", () => {
    const d = chooseRoute({
      facts: facts(1),
      workspaceDir: workspace({ "playwright.config.ts": "export default {};" }),
      frameworkFound: true,
    });
    expect(d.path).toBe("A");
    expect(d.deny).toEqual([]);
  });

  it("completes what is missing when the story has no scenario yet", () => {
    const d = chooseRoute({
      facts: facts(99),
      workspaceDir: workspace({ [EPIC_FEATURE]: FEATURE, [EPIC_SPEC]: SPEC }),
      frameworkFound: true,
    });
    expect(d.path).toBe("A2");
    expect(d.reason).toContain("@story:99");
  });

  it("completes what is missing when the feature is written but the spec is not", () => {
    const d = chooseRoute({
      facts: facts(1),
      workspaceDir: workspace({ [EPIC_FEATURE]: FEATURE }),
      frameworkFound: true,
    });
    expect(d.path).toBe("A2");
    expect(d.because["specExists"]).toBe(false);
  });

  it("executes what exists, and takes the authoring tools away", () => {
    const d = chooseRoute({
      facts: facts(44),
      workspaceDir: workspace({ [EPIC_FEATURE]: FEATURE, [EPIC_SPEC]: SPEC }),
      frameworkFound: true,
    });
    expect(d.path).toBe("B");
    expect(d.because["implemented"]).toBe(1);
    // The generator goes; the file writer does NOT — the healer needs it.
    expect(d.deny).toEqual(AUTHORING_TOOLS);
    expect(d.deny).toContain("bdd2pw.scaffold");
    expect(d.deny).not.toContain("fs.write_file");
    expect(renderRoute(d)).toContain("execute existing tests");
  });

  it("is a pure function of the same state", () => {
    const ws = workspace({ [EPIC_FEATURE]: FEATURE, [EPIC_SPEC]: SPEC });
    const a = chooseRoute({ facts: facts(1), workspaceDir: ws, frameworkFound: true });
    const b = chooseRoute({ facts: facts(1), workspaceDir: ws, frameworkFound: true });
    expect(a).toEqual(b);
  });
});

describe("on the execute path, a spec may be repaired but scenarios may not be rewritten", () => {
  const events = (path: string) =>
    [
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "route" as const,
        payload: { path, reason: "", because: {}, denied: [] },
      },
    ] as never;

  it("refuses a .feature write on path B", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const why = storyRefusal(
      {
        toolName: "fs.write_file",
        args: { path: "features/epic-42.feature", content: "Feature: x" },
      },
      events("B"),
    );
    expect(why).toContain("not this run's to rewrite");
  });

  it("allows a spec write on path B — that is how a locator is healed", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    expect(
      storyRefusal(
        {
          toolName: "fs.write_file",
          args: { path: "tests/epic-42.spec.ts", content: "// healed" },
        },
        events("B"),
      ),
    ).toBeUndefined();
  });

  it("allows a .feature write on the authoring path", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    expect(
      storyRefusal(
        {
          toolName: "fs.write_file",
          args: { path: "features/epic-42.feature", content: "Feature: x" },
        },
        events("A"),
      ),
    ).toBeUndefined();
  });
});

describe("no rule that assumes authoring may block a repair on path B", () => {
  /**
   * Three rules kept the healer from writing: specBeforeScaffold ("no spec has
   * been generated this run"), featureFirst ("write the feature file first")
   * and the deny list itself. All three assume the run is CREATING the
   * automation. On path B it is not, and the run spent its budget re-reading a
   * file while its own notes said what to change (20260925T172038Z).
   */
  it("lets the healer write the spec with no feature write and no scaffold this run", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const events = [
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "route" as const,
        payload: { path: "B", reason: "", because: {}, denied: [] },
      },
    ] as never;
    expect(
      storyRefusal(
        {
          toolName: "fs.write_file",
          args: {
            path: "tests/epic-42-customer-account-access.spec.ts",
            content: 'await page.getByRole("button", { name: "Show/hide account menu" }).click();',
          },
        },
        events,
      ),
    ).toBeUndefined();
  });
});

describe("a quarantined test may be strengthened, never weakened", () => {
  const QUARANTINED = "Story-a — Signed-in user can log out via the account menu";

  const ledger = (before: string) =>
    [
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "route" as const,
        payload: { path: "B", reason: "", because: {}, denied: [] },
      },
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 2,
        timestamp: 1,
        kind: "call" as const,
        payload: {
          server: "fs",
          toolName: "read_file",
          args: { path: "tests/e.spec.ts" },
          startedAt: 0,
        },
      },
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 3,
        timestamp: 1,
        kind: "observation" as const,
        payload: {
          eventIdOfCall: 2,
          ok: true,
          result: { path: "tests/e.spec.ts", content: before },
          artefacts: [],
          durationMs: 1,
        },
      },
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 4,
        timestamp: 1,
        kind: "triage" as const,
        payload: {
          attempt: 1,
          reportFingerprint: "f",
          runLevel: null,
          verdicts: [
            { test: `tests/e.spec.ts › ${QUARANTINED}`, category: "real-defect", confidence: 0.7 },
          ],
          quarantined: [QUARANTINED],
        },
      },
    ] as never;

  const BEFORE = [
    `test("${QUARANTINED}", async ({ page }) => {`,
    '  await page.locator(\'a[href="#/logout"]\').click().catch(async () => { await page.goto("/#/logout"); });',
    '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
    "});",
  ].join("\n");

  const write = (content: string) => ({
    toolName: "fs.write_file",
    args: { path: "tests/e.spec.ts", content },
  });

  it("allows the fallback to go and a precondition to be added", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const healed = [
      `test("${QUARANTINED}", async ({ page }) => {`,
      '  await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible();',
      '  await page.getByRole("menuitem", { name: "Logout" }).click();',
      '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
      "});",
    ].join("\n");
    expect(storyRefusal(write(healed), ledger(BEFORE))).toBeUndefined();
  });

  it("still refuses a write that drops the claim the test made", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const softened = [
      `test("${QUARANTINED}", async ({ page }) => {`,
      '  await page.getByRole("menuitem", { name: "Logout" }).click();',
      "});",
    ].join("\n");
    const why = storyRefusal(write(softened), ledger(BEFORE));
    expect(why).toContain("drops the claim");
  });
});
