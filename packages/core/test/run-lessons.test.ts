import { describe, it, expect } from "vitest";
import { classifyFailure, triageRun } from "../src/triage/classify.js";
import { applyRepetition } from "../src/triage/step.js";
import { coverageOf, type TestDesign } from "../src/design/test-design.js";
import { liveLine } from "../src/cli.js";
import { askedFor, rankCandidates } from "../src/heal/locator.js";
import { shapeProblems, testsByTitle, validateDesign } from "../src/design/test-design.js";
import { isKnownBroken } from "../src/design/ids.js";
import {
  appendOnlyAfterReroute,
  appendOnlySpec,
  fallbackInATest,
  knownBugMarkers,
  lockedScenarios,
  misattributedKnownBug,
} from "../src/skills/story-rules.js";
import type { AnyRunEvent, TriagePayload } from "../src/types.js";

/**
 * Lessons from the first Jira runs against Juice Shop (SCRUM-8, 2026-10-11),
 * each pinned with the failure text the run actually produced.
 */

const HOOK_TIMEOUT = 'Test timeout of 30000ms exceeded while running "beforeEach" hook.';
const BAD_SELECTOR =
  'Error: locator.click: Unexpected token "" while parsing css selector "". Did you mean to CSS.escape it?';

describe("triage: failures that never reached the product", () => {
  it("calls a setup-hook failure environmental, not a flake that becomes a defect", () => {
    const v = classifyFailure({ testId: "AC-1: logout", message: HOOK_TIMEOUT });
    expect(v.category).toBe("environmental");
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
    expect(v.rationale).toMatch(/setup hook failed/i);
    // Every test failing in setup means nothing measured the product.
    const run = triageRun([
      { testId: "a", message: HOOK_TIMEOUT },
      { testId: "b", message: HOOK_TIMEOUT },
    ]);
    expect(run.runLevel).toBe("environmental");
  });

  it("calls an invalid selector the test's fault, and keeps it so when it repeats", () => {
    const v = classifyFailure({ testId: "AC-2: home page", message: BAD_SELECTOR });
    expect(v.category).toBe("flake");
    expect(v.rationale).toMatch(/^The test's own code is invalid/);
    const history = [{ verdicts: [v] } as unknown as TriagePayload];
    const [again] = applyRepetition([v], history);
    expect(again?.category).toBe("flake"); // not upgraded to real-defect
  });

  it("calls a page torn down mid-action a stale flake, not a defect (pw-self-heal's stale class)", () => {
    const v = classifyFailure({
      testId: "AC-2: home after logout",
      message:
        "page.evaluate: Execution context was destroyed, most likely because of a navigation",
    });
    expect(v.category).toBe("flake");
    expect(v.confidence).toBeGreaterThanOrEqual(0.85);
    expect(v.rationale).toMatch(/^The page or element was torn down mid-action/);
  });

  it("still upgrades an ordinary repeating timeout to a defect candidate", () => {
    const v = classifyFailure({
      testId: "t",
      message: "locator.click: Timeout 5000ms exceeded. waiting for locator('#x')",
    });
    expect(v.category).toBe("flake");
    const [again] = applyRepetition([v], [{ verdicts: [v] } as unknown as TriagePayload]);
    expect(again?.category).toBe("real-defect");
  });
});

describe("the live line says what triage actually knows", () => {
  const ev = (verdicts: unknown[]) =>
    ({ kind: "triage", payload: { verdicts } } as unknown as AnyRunEvent);

  it("does not present a no-pattern default as a product defect", () => {
    const line = liveLine(ev([{ category: "real-defect", confidence: 0.1, rationale: "x" }]));
    expect(line).toMatch(/matched no known failure pattern/);
    expect(line).not.toMatch(/look like a product defect/);
  });

  it("keeps the product-defect wording for a real match, and names test-code faults", () => {
    const line = liveLine(
      ev([
        { category: "real-defect", confidence: 0.6, rationale: "assertion" },
        { category: "flake", confidence: 0.9, rationale: "The test's own code is invalid (…)" },
      ]),
    );
    expect(line).toMatch(/1 looks like a product defect/);
    expect(line).toMatch(/1 looks like the test's fault/);
  });
});

describe("coverage: same criterion, different type of test", () => {
  const feature = [
    "Feature: Customer account access",
    "  @story:SCRUM-8 @ac:1 @design:D1 @type:functional",
    "  Scenario: AC-1: Logout offers Login again",
    "    Given x",
  ].join("\n");
  const design = {
    items: [
      {
        id: "D1",
        covers: "AC-1",
        type: "functional",
        technique: "state-transition",
        conditions: [],
        expected: "",
        source: "AC-1",
      },
      {
        id: "D3",
        covers: "AC-1",
        type: "security",
        technique: "state-transition",
        conditions: [],
        expected: "",
        source: "task SCRUM-9",
      },
    ],
    excluded: [],
  } as unknown as TestDesign;

  it("does not report a security item as tested by a functional scenario", () => {
    const c = coverageOf(design, { featureText: feature, story: "SCRUM-8" });
    expect(c.get("D1")?.how).toBe("criterion");
    expect(c.has("D3")).toBe(false);
  });

  it("still matches when the scenario names no type at all", () => {
    const untyped = feature.replace(" @type:functional", "");
    const c = coverageOf(design, { featureText: untyped, story: "SCRUM-8" });
    expect(c.has("D3")).toBe(true);
  });
});

describe("heal: the selector that failed, and a name that differs only in spacing", () => {
  const snapshot = [
    '- heading "Login" [level=1] [ref=e52]',
    '- textbox "Text field for the login email" [ref=e60]',
    '- button "Button to display the password" [ref=e70] [cursor=pointer]',
    '- button "Login" [ref=e77]:',
    "  - generic [ref=e79]: Log in",
    '- button "Open Sidenav" [ref=e8] [cursor=pointer]',
  ].join("\n");

  it("reads role and name from a getByRole selector", () => {
    expect(askedFor("getByRole('button', { name: 'Log in' })")).toEqual({
      role: "button",
      name: "Log in",
    });
    expect(askedFor("getByLabel('Password')")).toEqual({ name: "Password" });
  });

  it("ranks the Login button first for a click that waited on 'Log in'", () => {
    const [best] = rankCandidates(snapshot, "getByRole('button', { name: 'Log in' })");
    expect(best?.role).toBe("button");
    expect(best?.name).toBe("Login");
    expect(best?.score).toBeGreaterThanOrEqual(30);
    expect(best?.why).toMatch(/differ only in spacing/);
  });
});

describe("an In Progress Jira bug is known broken", () => {
  it("treats Jira's In Progress like Azure DevOps Active", () => {
    expect(isKnownBroken("In Progress")).toBe(true);
    expect(isKnownBroken("Active")).toBe(true);
    expect(isKnownBroken("To Do")).toBe(false);
    expect(isKnownBroken("Resolved")).toBe(false);
  });

  it("accepts expectFail for SCRUM-12 in progress, and asks for it when missing", () => {
    const facts = {
      acceptanceCriteria: ["AC-1"],
      bugs: [{ id: "SCRUM-12", state: "In Progress", title: "Session token still accepted" }],
      tasks: [],
      story: { id: "SCRUM-8", title: "Customer signs out" },
    };
    const item = (expectFail?: boolean) => ({
      items: [
        {
          id: "D1",
          covers: "AC-1",
          type: "functional",
          technique: "state-transition",
          conditions: ["x"],
          expected: "Login offered",
          source: "AC-1",
        },
        {
          id: "D2",
          covers: "bug SCRUM-12",
          type: "confirmation",
          technique: "error-guessing",
          conditions: ["token reused after logout"],
          expected: "401",
          source: "bug SCRUM-12",
          ...(expectFail === undefined ? {} : { expectFail }),
        },
      ],
      excluded: [],
    });
    const types = ["functional", "confirmation"] as const;
    expect(
      validateDesign(item(true) as never, facts as never, types).filter((p) => /SCRUM-12/.test(p)),
    ).toEqual([]);
    expect(
      validateDesign(item() as never, facts as never, types).some((p) =>
        /EXPECTED to fail/.test(p),
      ),
    ).toBe(true);
  });
});

describe("a known-bug marker belongs only on that bug's test", () => {
  const spec = (markOn: "token" | "bug") =>
    [
      'import { test, expect } from "@playwright/test";',
      "  // @story:SCRUM-8",
      "  // @ac:1",
      "  // @design:D3",
      '  test("AC-1: After logout the authentication token is removed", async ({ page }) => {',
      markOn === "token"
        ? '    test.fail(true, "Bug #SCRUM-12 Active: Session token is still accepted after logout");'
        : "",
      "    expect(1).toBe(1);",
      "  });",
      "  // @story:SCRUM-8",
      "  // @bug:SCRUM-12",
      "  // @design:D5",
      '  test("bug SCRUM-12: the token is refused after logout", async ({ request }) => {',
      markOn === "bug"
        ? '    test.fail(true, "Bug #SCRUM-12 Active: Session token is still accepted after logout");'
        : "",
      "    expect(1).toBe(1);",
      "  });",
    ].join("\n");

  it("finds each marker with the test it sits in and that test's @bug tags", () => {
    expect(knownBugMarkers(spec("token"))).toEqual([
      {
        test: "AC-1: After logout the authentication token is removed",
        bug: "SCRUM-12",
        bugTags: [],
      },
    ]);
    expect(knownBugMarkers(spec("bug"))[0]?.bugTags).toEqual(["SCRUM-12"]);
  });

  it("refuses the marker on another test, and allows it on the bug's own test", () => {
    const write = (content: string) => ({
      toolName: "fs.write_file",
      args: { path: "tests/epic-scrum-5-customer-account-access.spec.ts", content },
    });
    expect(misattributedKnownBug(write(spec("token")), [])).toMatch(/not that bug's test/);
    expect(misattributedKnownBug(write(spec("bug")), [])).toBeUndefined();
  });
});

describe("completing the design after a re-route: add once, then scaffold", () => {
  const FEATURE = "features/epic-scrum-5-customer-account-access.feature";
  const OLD = [
    "Feature: Customer account access",
    "",
    "  @story:SCRUM-8 @ac:1 @design:D1",
    "  Scenario: AC-1: Logout offers Login again",
    '    When I click "Logout"',
    '    Then the page displays "Login"',
  ].join("\n");
  const D5 = (wording: string) =>
    [
      "",
      "  @story:SCRUM-8 @bug:SCRUM-12 @design:D5 @type:confirmation",
      `  Scenario: D5: ${wording}`,
      '    When I click "Logout"',
      "    Then the server rejects the token",
    ].join("\n");

  let id = 0;
  const base = { tool: "attestqa", runId: "r", timestamp: 1 };
  const route = () =>
    ({
      ...base,
      eventId: ++id,
      kind: "route",
      payload: {
        path: "A2",
        reason: "",
        because: { appendOnly: true, missing: ["D5"], locked: lockedScenarios(OLD) },
        denied: [],
      },
    } as unknown as AnyRunEvent);
  const call = (toolName: string, args: Record<string, unknown>): AnyRunEvent[] => {
    const callId = ++id;
    const [server, name] = toolName.split(".");
    return [
      {
        ...base,
        eventId: callId,
        kind: "call",
        payload: { server, toolName: name, args, startedAt: 0 },
      },
      {
        ...base,
        eventId: ++id,
        kind: "observation",
        payload: { eventIdOfCall: callId, ok: true, result: {}, artefacts: [], durationMs: 1 },
      },
    ] as unknown as AnyRunEvent[];
  };
  const write = (content: string) => ({
    toolName: "fs.write_file",
    args: { path: FEATURE, content },
  });

  it("allows adding the new item's scenario, and refuses touching one that was there", () => {
    const events = [route()];
    expect(
      appendOnlyAfterReroute(write(OLD + D5("server refuses the token")), events),
    ).toBeUndefined();
    const edited = OLD.replace('"Login"', '"Sign in"') + D5("server refuses the token");
    expect(appendOnlyAfterReroute(write(edited), events)).toMatch(/existed before would change/);
  });

  it("refuses a second scenario for the same new item", () => {
    const two = OLD + D5("server refuses the token") + D5("token is rejected after logout");
    expect(appendOnlyAfterReroute(write(two), [route()])).toMatch(/more than one scenario/);
  });

  it("once the scenario is written, asks for analyze before another edit", () => {
    const written = OLD + D5("server refuses the token");
    const events = [route(), ...call("fs.write_file", { path: FEATURE, content: written })];
    const reword = OLD + D5("the token is refused after logout");
    expect(appendOnlyAfterReroute(write(reword), events)).toMatch(/next step is bdd2pw\.analyze/);
    const analyzed = [...events, ...call("bdd2pw.analyze", { feature: FEATURE, url: "x" })];
    expect(appendOnlyAfterReroute(write(reword), analyzed)).toBeUndefined();
  });
});

describe("append-only completion of the spec", () => {
  const SPEC = "tests/epic-scrum-5-customer-account-access.spec.ts";
  const OLD = [
    "  // @story:SCRUM-8",
    "  // @design:D1",
    '  test("AC-1: Logout offers Login again", async ({ page }) => {',
    '    await page.getByRole("menuitem", { name: "Logout" }).click();',
    '    await expect(page.getByRole("menuitem", { name: "Login" })).toBeVisible();',
    "  });",
  ].join("\n");
  const D5 = [
    "",
    "  // @story:SCRUM-8",
    "  // @bug:SCRUM-12",
    "  // @design:D5",
    '  test("D5: the server refuses the token after logout", async ({ request }) => {',
    '    test.fail(true, "Bug #SCRUM-12 In Progress: session token still accepted");',
    "    expect((await request.get('/rest/basket/1')).status()).toBe(401);",
    "  });",
  ].join("\n");

  let id = 100;
  const base = { tool: "attestqa", runId: "r", timestamp: 1 };
  const events = () => {
    const callId = ++id;
    return [
      {
        ...base,
        eventId: ++id,
        kind: "route",
        payload: {
          path: "A2",
          reason: "",
          because: { from: "B", appendOnly: true, missing: ["D5"], locked: [] },
          denied: [],
        },
      },
      {
        ...base,
        eventId: callId,
        kind: "call",
        payload: {
          server: "fs",
          toolName: "write_file",
          args: { path: SPEC, content: OLD },
          startedAt: 0,
        },
      },
      {
        ...base,
        eventId: ++id,
        kind: "observation",
        payload: { eventIdOfCall: callId, ok: true, result: {}, artefacts: [], durationMs: 1 },
      },
    ] as unknown as AnyRunEvent[];
  };
  const write = (content: string) => ({ toolName: "fs.write_file", args: { path: SPEC, content } });

  it("allows a new test tagged for the item being completed, beside the old ones", () => {
    expect(appendOnlySpec(write(OLD + D5), events())).toBeUndefined();
  });

  it("refuses dropping an assertion from a test that was there", () => {
    const weaker = OLD.replace(/\n.*toBeVisible.*/, "") + D5;
    expect(appendOnlySpec(write(weaker), events())).toMatch(/would lose an assertion/);
  });

  it("refuses a new test with no @design tag for the item", () => {
    const untagged = OLD + D5.replace("  // @design:D5\n", "");
    expect(appendOnlySpec(write(untagged), events())).toMatch(/carry no @design tag/);
  });
});

describe("a step is not a test", () => {
  it("reads tests, not test.step or test.describe, and keeps each test's whole body", () => {
    const spec = [
      'test.describe("Customer account access", () => {',
      '  test("AC-1: token removed", async ({ page }) => {',
      '    await test.step("When I log in", async () => {});',
      '    await test.step("Then the token is present", async () => {',
      "      expect(token).not.toBeNull();",
      "    });",
      "  });",
      '  test.fixme("AC-2: home page", async () => {});',
      "});",
    ].join("\n");
    const tests = testsByTitle(spec);
    expect([...tests.keys()]).toEqual(["AC-1: token removed", "AC-2: home page"]);
    expect(tests.get("AC-1: token removed")).toContain("expect(token).not.toBeNull()");
  });
});

describe("a wait or an assertion may not catch its own failure", () => {
  const PATH = "tests/epic-scrum-5-customer-account-access.spec.ts";
  const spec = (tail: string) =>
    [
      'import { test, expect } from "@playwright/test";',
      "  // @story:SCRUM-8",
      "  // @design:D3",
      '  test("AC-1: After logout the authentication token is removed", async ({ page }) => {',
      "    await page.waitForFunction(",
      '      () => window.localStorage.getItem("token") !== null,',
      "      { timeout: 5000 }",
      `    )${tail};`,
      '    const token = await page.evaluate(() => window.localStorage.getItem("token"));',
      "    expect(token).not.toBeNull();",
      "  });",
    ].join("\n");
  const write = (content: string) => ({ toolName: "fs.write_file", args: { path: PATH, content } });
  const ledger = (content: string): AnyRunEvent[] =>
    [
      {
        eventId: 1,
        kind: "call",
        payload: {
          server: "fs",
          toolName: "write_file",
          args: { path: PATH, content },
          startedAt: 0,
        },
      },
      {
        eventId: 2,
        kind: "observation",
        payload: { eventIdOfCall: 1, ok: true, result: {}, artefacts: [], durationMs: 1 },
      },
    ] as unknown as AnyRunEvent[];

  it("refuses the .catch(() => {}) the D3 fix put on its wait (20261012T144711Z)", () => {
    expect(fallbackInATest(write(spec(".catch(() => {})")), [])).toMatch(/drop the \.catch/);
  });

  it("allows the wait without the catch", () => {
    expect(fallbackInATest(write(spec("")), [])).toBeUndefined();
  });

  it("allows rewriting a test that already had a fallback (removing one is the repair)", () => {
    const old = spec(".catch(() => {})");
    expect(fallbackInATest(write(old + "\n// touched"), ledger(old))).toBeUndefined();
  });

  it("ignores files that are not specs", () => {
    expect(
      fallbackInATest(
        {
          toolName: "fs.write_file",
          args: { path: "pages/login.page.ts", content: "x.catch(() => {})" },
        },
        [],
      ),
    ).toBeUndefined();
  });
});

describe("the verifier names the line that swallows a failure", () => {
  it("quotes the .catch line so the fix is one edit (20261012T153713Z)", () => {
    const body = [
      "await page.waitForFunction(",
      '  () => window.localStorage.getItem("token") !== null,',
      "  { timeout: 5000 }",
      ").catch(() => {});",
    ].join("\n");
    const item = { id: "D3", covers: "AC-1", type: "functional", technique: "state-transition" };
    const [first] = shapeProblems(item as never, body);
    expect(first).toContain("`).catch(() => {});`");
    expect(first).toMatch(/A green suite does not settle this/);
  });
});
