import { describe, it, expect } from "vitest";
import { HealTools } from "../src/mcp/adapters/heal.js";
import type { LedgerView } from "../src/mcp/adapters/summary.js";
import { candidatesFrom, rankCandidates, selectorFromMessage } from "../src/heal/locator.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

function ledgerOf(
  entries: Array<{ tool: string; args?: Record<string, unknown>; result?: unknown; ok?: boolean }>,
): LedgerView {
  const events: AnyRunEvent[] = [];
  let id = 0;
  const base = { tool: "agentic-qa" as const, runId: "run-1", timestamp: 1 };
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
        ok: e.ok ?? true,
        result: e.result ?? {},
        artefacts: [],
        durationMs: 1,
      },
    } as AnyRunEvent);
  }
  return { runId: "run-1", read: () => events };
}

/** The shape Playwright's accessibility snapshot actually has. */
const SNAPSHOT = `
- banner:
  - link "OWASP Juice Shop"
  - button "Search"
  - generic "welcome"
- navigation:
  - menuitem "Your Basket"
  - menuitem "Logout" [ref=e328]
  - img "avatar"
`;

const TIMEOUT =
  "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('a[href=\"#/logout\"]')\n";

const RED = (over: Record<string, unknown> = {}) => ({
  passed: 4,
  failed: 1,
  skipped: 0,
  flaky: 0,
  green: false,
  failures: [
    {
      title: "AC-4: the session token is cleared on logout",
      file: "tests/epic-42-login.spec.ts",
      message: TIMEOUT,
      pageAtFailure: SNAPSHOT,
      ...over,
    },
  ],
});

const call = (t: HealTools, args: Record<string, unknown>) => t.call("aqa", "heal_locator", args);

describe("the page at the failure is read by code, not by eye", () => {
  it("lists only what can be clicked or typed into", () => {
    const got = candidatesFrom(SNAPSHOT).map((c) => c.expression);
    expect(got).toContain('page.getByRole("menuitem", { name: "Logout" })');
    expect(got).toContain('page.getByRole("button", { name: "Search" })');
    // A page full of generic and img nodes drowns the candidates that matter.
    expect(got.join(" ")).not.toContain("generic");
    expect(got.join(" ")).not.toContain("img");
  });

  it("ranks the control the failed selector was looking for first", () => {
    const top = rankCandidates(SNAPSHOT, 'a[href="#/logout"]')[0];
    expect(top?.expression).toBe('page.getByRole("menuitem", { name: "Logout" })');
    expect(top?.why).toContain('"logout"');
  });

  it("takes the failed selector from Playwright's own message", () => {
    expect(selectorFromMessage(TIMEOUT)).toBe("locator('a[href=\"#/logout\"]')");
    expect(selectorFromMessage("no locator here")).toBeUndefined();
  });
});

describe("aqa.heal_locator", () => {
  it("is a read — healing nothing by itself", async () => {
    const [d] = await new HealTools(ledgerOf([])).listTools();
    expect(d?.policyClass).toBe("read");
  });

  it("names the control that was on the page, and calls it a test defect", async () => {
    const t = new HealTools(ledgerOf([{ tool: "pw.run_tests", result: RED() }]));
    const r = await call(t, { test: "session token is cleared" });
    expect(r.ok).toBe(true);
    const res = r.result as { candidates: Array<{ expression: string }>; verdict: string };
    expect(res.candidates[0]?.expression).toBe('page.getByRole("menuitem", { name: "Logout" })');
    expect(res.verdict).toContain("TEST defect");
  });

  it("does not call it a test defect when nothing on the page matches", async () => {
    const t = new HealTools(
      ledgerOf([
        {
          tool: "pw.run_tests",
          result: RED({ pageAtFailure: '- banner:\n  - link "OWASP Juice Shop"\n' }),
        },
      ]),
    );
    const res = (await call(t, { test: "session token is cleared" })).result as { verdict: string };
    expect(res.verdict).toContain("may genuinely be");
  });

  it("refuses to guess when the failure carries no snapshot", async () => {
    const t = new HealTools(
      ledgerOf([{ tool: "pw.run_tests", result: RED({ pageAtFailure: undefined }) }]),
    );
    const r = await call(t, { test: "session token is cleared" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.result)).toContain("no page snapshot");
  });

  it("will not pick between two tests that match the title given", async () => {
    const two = RED();
    two.failures.push({
      ...two.failures[0]!,
      title: "AC-5: the session token is cleared elsewhere",
    });
    const r = await call(new HealTools(ledgerOf([{ tool: "pw.run_tests", result: two }])), {
      test: "session token is cleared",
    });
    expect(r.ok).toBe(false);
    expect((r.result as { failingTests: string[] }).failingTests).toHaveLength(2);
  });

  it("uses the newest record of a test, so a filtered rerun wins", async () => {
    const t = new HealTools(
      ledgerOf([
        { tool: "pw.run_tests", result: RED() },
        {
          tool: "pw.run_tests",
          args: { grep: "AC-4" },
          result: RED({ pageAtFailure: '- navigation:\n  - button "Sign out"\n' }),
        },
      ]),
    );
    const res = (await call(t, { test: "AC-4" })).result as {
      candidates: Array<{ expression: string }>;
    };
    expect(res.candidates[0]?.expression).toBe('page.getByRole("button", { name: "Sign out" })');
  });
});

describe("a bug may not be proposed while a locator failure is unexplained", () => {
  const bug = {
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Bug",
      parentId: "1",
      tags: "agentic-qa",
      fields: { "System.Title": "AC-4: logout does not clear the session token" },
    },
  };
  const red = [{ tool: "pw.run_tests", result: RED() }];

  it("refuses the bug until aqa.heal_locator has read the page", () => {
    const why = storyRefusal(bug, ledgerOf(red).read());
    expect(why).toContain("aqa.heal_locator");
    expect(why).toContain("AC-4: the session token is cleared on logout");
  });

  it("allows it once the page has been read for that test", () => {
    const events = ledgerOf([
      ...red,
      {
        tool: "aqa.heal_locator",
        args: { test: "AC-4: the session token is cleared on logout" },
        result: {},
      },
    ]).read();
    expect(storyRefusal(bug, events)).toBeUndefined();
  });

  it("says nothing about a failure that is not a locator timeout", () => {
    const events = ledgerOf([
      { tool: "pw.run_tests", result: RED({ message: "expected 200, received 500" }) },
    ]).read();
    expect(storyRefusal(bug, events)).toBeUndefined();
  });
});

describe("another story's scenarios are not this design's business", () => {
  const FEATURE = [
    "Feature: Customer account access",
    "",
    "  @story:1 @ac:1 @design:D1",
    "  Scenario: AC-1 sign in",
    "    Given I am on the login page",
    "",
    "  @story:44 @design:D9",
    "  Scenario: Story-a log out",
    "    Given I am signed in",
    "",
    "  Scenario: nobody's scenario",
    "    Given something",
  ].join("\n");

  const DESIGN = {
    items: [
      {
        id: "D1",
        covers: "AC-1",
        type: "functional",
        technique: "state-transition",
        conditions: ["c"],
        expected: "e",
        source: "AC-1",
      },
    ],
  };

  it("counts only this story's scenarios, and the untagged one", async () => {
    const { parseDesign, traceProblems } = await import("../src/design/test-design.js");
    const t = traceProblems(parseDesign(DESIGN), [{ path: "f.feature", text: FEATURE }], [], 1);
    // Story #44's logout scenario is not listed; relabelling it as story #1's
    // AC-1 was the agent's way out of exactly this (20260925T145714Z).
    expect(t.untagged.join(" ")).not.toContain("Story-a");
    expect(t.untagged.join(" ")).toContain("nobody's scenario");
  });

  it("counts every scenario when the run is not scoped to a story", async () => {
    const { parseDesign, traceProblems } = await import("../src/design/test-design.js");
    const t = traceProblems(parseDesign(DESIGN), [{ path: "f.feature", text: FEATURE }], []);
    expect(t.untagged.join(" ")).toContain("Story-a");
  });
});

describe("a test that catches its own failure is not evidence", () => {
  const bug = {
    toolName: "ado.wit_work_item_write",
    args: {
      action: "create",
      workItemType: "Bug",
      parentId: "1",
      tags: "agentic-qa",
      fields: { "System.Title": "AC-4: logout does not clear the session token" },
    },
  };
  const SPEC_WITH_FALLBACK = [
    "import { test, expect } from '@playwright/test';",
    "test('AC-4: the session token is cleared on logout', async ({ page }) => {",
    "  const link = page.locator('a[href=\"#/logout\"]');",
    "  await link.waitFor({ state: 'visible' }).catch(async () => { await page.goto('/#/logout'); });",
    "  expect(await token(page)).toBeNull();",
    "});",
  ].join("\n");
  const SPEC_CLEAN = [
    "import { test, expect } from '@playwright/test';",
    "test('AC-4: the session token is cleared on logout', async ({ page }) => {",
    "  await page.getByRole('menuitem', { name: 'Logout' }).click();",
    "  expect(await token(page)).toBeNull();",
    "});",
  ].join("\n");

  const withSpec = (spec: string) =>
    ledgerOf([
      {
        tool: "ado.wit_work_item",
        args: { action: "get", id: 1 },
        result: { id: 1, fields: { "System.Title": "Login", "System.WorkItemType": "User Story" } },
      },
      {
        tool: "fs.read_file",
        args: { path: "tests/epic-42-customer-account-access.spec.ts" },
        result: { content: spec },
      },
      {
        tool: "pw.run_tests",
        result: {
          passed: 0,
          failed: 1,
          skipped: 0,
          flaky: 0,
          green: false,
          failures: [
            {
              title: "AC-4: the session token is cleared on logout",
              file: "tests/epic-42-customer-account-access.spec.ts",
              // The honest-looking assertion the fallback produced.
              message: 'expect(received).toBeNull()\nReceived: "eyJ0eXAiOi…"',
            },
          ],
        },
      },
    ]).read();

  it("refuses the bug while the failing test has a fallback", () => {
    const why = storyRefusal(bug, withSpec(SPEC_WITH_FALLBACK));
    expect(why).toContain("catches its own failure");
    expect(why).toContain("aqa.heal_locator");
  });

  it("says nothing once the fallback is gone", () => {
    expect(storyRefusal(bug, withSpec(SPEC_CLEAN))).toBeUndefined();
  });
});

describe("a scaffold names the files it wrote", () => {
  it("reports what changed on disk, not the directory it aimed at", async () => {
    const { Bdd2PwTools } = await import("../src/mcp/adapters/bdd2pw.js");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const ws = mkdtempSync(join(tmpdir(), "aqa-scaffold-"));
    mkdirSync(join(ws, "features"), { recursive: true });
    mkdirSync(join(ws, "tests"), { recursive: true });
    mkdirSync(join(ws, "pages"), { recursive: true });
    writeFileSync(join(ws, "features", "epic-42.feature"), "Feature: x\n  Scenario: y\n");
    // A spec that was already there, and must NOT be reported as written.
    writeFileSync(join(ws, "tests", "epic-42.spec.ts"), "// mine\n");

    // bdd2pw names a spec after the page object, so this is what really happens.
    const runner = async () => {
      writeFileSync(join(ws, "tests", "login.spec.ts"), "// generated\n");
      writeFileSync(join(ws, "pages", "login.page.ts"), "// generated\n");
      return { code: 0, stdout: "ok", stderr: "" };
    };

    const t = new Bdd2PwTools(ws, { runner });
    const out = await t.call("bdd2pw", "scaffold", {
      feature: "features/epic-42.feature",
      url: "http://localhost:3100",
      page: "LoginPage",
    });
    const wrote = (out.result as { wrote: string[] }).wrote.sort();
    expect(wrote).toEqual(["pages/login.page.ts", "tests/login.spec.ts"]);
  });

  it("tells a refused re-read where the generated code actually is", () => {
    const events = ledgerOf([
      {
        tool: "fs.read_file",
        args: { path: "tests/epic-42.spec.ts" },
        result: { content: "// mine" },
      },
      {
        tool: "bdd2pw.scaffold",
        args: { feature: "features/epic-42.feature" },
        result: { wrote: ["tests/login.spec.ts", "pages/login.page.ts"] },
      },
      {
        tool: "fs.read_file",
        args: { path: "tests/epic-42.spec.ts" },
        result: { content: "// mine" },
      },
    ]).read();
    const why = storyRefusal(
      { toolName: "fs.read_file", args: { path: "tests/epic-42.spec.ts" } },
      events,
    );
    expect(why).toContain("tests/login.spec.ts");
    expect(why).toContain("not tests/epic-42.spec.ts");
  });
});

describe("bdd2pw's LLM fallback is configured, never improvised", () => {
  it("accepts a provider in the config and rejects an unknown one", async () => {
    const { agentConfigFromObject } = await import("../src/config.js");
    const base = {
      agent: {
        scope: { work_items: ["1"], repos: [], test_plans: [], branches_writable: [], urls: [] },
      },
    };
    const ok = agentConfigFromObject({
      agent: { ...base.agent, llm_fallback: "anthropic" },
    });
    expect(ok.llm_fallback).toBe("anthropic");
    expect(agentConfigFromObject(base).llm_fallback).toBeUndefined();
    expect(() =>
      agentConfigFromObject({ agent: { ...base.agent, llm_fallback: "llama" } }),
    ).toThrow(/llm_fallback must be one of/);
  });
});

describe("heal refuses to read a snapshot taken after a fallback", () => {
  const TITLE = "Story-a — Signed-in user can log out via the account menu";
  const SPEC_WITH_FALLBACK = [
    "async function clickLogout(page) {",
    "  const link = page.locator('a[href=\"#/logout\"]');",
    '  await link.waitFor({ state: "visible" }).catch(async () => { await page.goto("/#/logout"); });',
    "}",
    `test("${TITLE}", async ({ page }) => {`,
    "  await clickLogout(page);",
    '  expect(await token(page), "localStorage token should be cleared after logout").toBeNull();',
    "});",
  ].join("\n");

  const led = (spec: string, message: string) =>
    ledgerOf([
      { tool: "fs.read_file", args: { path: "tests/epic-42.spec.ts" }, result: { content: spec } },
      {
        tool: "pw.run_tests",
        result: {
          passed: 8,
          failed: 1,
          skipped: 0,
          flaky: 0,
          green: false,
          failures: [
            {
              title: TITLE,
              file: "tests/epic-42.spec.ts",
              message,
              // The snapshot Playwright saved — of the page the fallback landed on.
              pageAtFailure: '- banner:\n  - button "Open Sidenav"\n  - button "Open search"\n',
            },
          ],
        },
      },
    ]);

  it("says what to do instead of naming buttons from the wrong page", async () => {
    const t = new HealTools(
      led(SPEC_WITH_FALLBACK, 'expect(received).toBeNull()\nReceived: "eyJ0…"'),
    );
    const r = await t.call("aqa", "heal_locator", { test: TITLE });
    expect(r.ok).toBe(false);
    const res = r.result as { message: string; do: string[] };
    expect(res.message).toContain("catches its own failure");
    expect(res.do[0]).toContain("Remove the try/catch");
    // And it must NOT offer candidates from a page the locator never saw.
    expect(JSON.stringify(res)).not.toContain("Open Sidenav");
  });

  it("still answers when the failure IS a locator error", async () => {
    const t = new HealTools(
      led(
        SPEC_WITH_FALLBACK,
        "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('a[href=\"#/logout\"]')",
      ),
    );
    const r = await t.call("aqa", "heal_locator", { test: TITLE });
    expect(r.ok).toBe(true);
  });
});

describe("a heal edits one line rather than rewriting the file", () => {
  it("replaces exactly one occurrence, and refuses an ambiguous or absent one", async () => {
    const { FsTools } = await import("../src/mcp/adapters/fs.js");
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const ws = mkdtempSync(join(tmpdir(), "aqa-edit-"));
    mkdirSync(join(ws, "tests"), { recursive: true });
    const spec = [
      "async function clickLogout(page) {",
      '  await page.getByRole("menuitem", { name: "Sign out" }).click();',
      "}",
      'test("Story-a", async ({ page }) => {',
      "  await clickLogout(page);",
      "  await expect(page).toHaveURL(/login/);",
      "});",
    ].join("\n");
    writeFileSync(join(ws, "tests", "e.spec.ts"), spec);

    const fs = new FsTools(ws);
    const ok = await fs.call("fs", "replace_in_file", {
      path: "tests/e.spec.ts",
      old: '{ name: "Sign out" }',
      new: '{ name: "Logout" }',
    });
    expect(ok.ok).toBe(true);
    const after = readFileSync(join(ws, "tests", "e.spec.ts"), "utf8");
    expect(after).toContain('{ name: "Logout" }');
    // Everything else is exactly as it was — the point of the tool.
    expect(after).toContain("await expect(page).toHaveURL(/login/);");
    expect(after.split("\n")).toHaveLength(spec.split("\n").length);

    const absent = await fs.call("fs", "replace_in_file", {
      path: "tests/e.spec.ts",
      old: "nothing like this",
      new: "x",
    });
    expect(absent.ok).toBe(false);

    const ambiguous = await fs.call("fs", "replace_in_file", {
      path: "tests/e.spec.ts",
      old: "page",
      new: "p",
    });
    expect(ambiguous.ok).toBe(false);
    expect(JSON.stringify(ambiguous.result)).toContain("ambiguous");
    // A refused edit writes nothing.
    expect(readFileSync(join(ws, "tests", "e.spec.ts"), "utf8")).toBe(after);
  });

  it("is judged as the write it amounts to: a dropped claim is still refused", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const TITLE = "Story-a — Signed-in user can log out via the account menu";
    const spec = [
      `test("${TITLE}", async ({ page }) => {`,
      '  await page.getByRole("menuitem", { name: "Sign out" }).click();',
      "  await expect(page).toHaveURL(/\\/#\\/login/);",
      "});",
    ].join("\n");
    const events = [
      ...ledgerOf([
        { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: spec } },
      ]).read(),
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 79,
        timestamp: 1,
        kind: "route" as const,
        payload: { path: "B", reason: "", because: {}, denied: [] },
      } as never,
      {
        tool: "agentic-qa" as const,
        runId: "r",
        eventId: 80,
        timestamp: 1,
        kind: "triage" as const,
        payload: {
          attempt: 1,
          reportFingerprint: "f",
          runLevel: null,
          verdicts: [
            {
              test: `tests/e.spec.ts › ${TITLE}`,
              category: "real-defect",
              confidence: 0.7,
              evidence: "Error: toHaveURL failed",
              rationale: "",
              matchedPatterns: ["x"],
            },
          ],
          quarantined: [TITLE],
        },
      } as never,
    ];

    // A locator repair through the edit tool: allowed.
    expect(
      storyRefusal(
        {
          toolName: "fs.replace_in_file",
          args: {
            path: "tests/e.spec.ts",
            old: '{ name: "Sign out" }',
            new: '{ name: "Logout" }',
          },
        },
        events,
      ),
    ).toBeUndefined();

    // Deleting the assertion through the edit tool: refused, same as a write.
    expect(
      storyRefusal(
        {
          toolName: "fs.replace_in_file",
          args: {
            path: "tests/e.spec.ts",
            old: "  await expect(page).toHaveURL(/\\/#\\/login/);\n",
            new: "",
          },
        },
        events,
      ),
    ).toContain("drops the claim");
  });
});
