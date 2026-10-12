import { describe, it, expect } from "vitest";
import { roleFor } from "../src/agents/roles.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * S5 — an agent is a tool list plus a prompt, chosen by code.
 *
 * The heal role exists because a model holding the whole skill kept reading the
 * authoring half of it while repairing: "the pipeline is feature → scaffold →
 * implement" is true, and irrelevant, when a locator has moved.
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

const run = (failures: Array<{ title: string; message: string }>) => ({
  tool: "pw.run_tests",
  result: { passed: 8, failed: failures.length, skipped: 0, flaky: 0, green: false, failures },
});

const LOCATOR = {
  title: "Story-a — logs out via the account menu",
  message:
    "TimeoutError: locator.click\nCall log:\n  - waiting for locator('a[href=\"#/logout\"]')",
};

describe("which agent the run is being", () => {
  it("is the healer when a locator matched nothing", () => {
    const role = roleFor(ledgerOf([run([LOCATOR])]));
    expect(role.name).toBe("heal");
    expect(role.because).toContain("locator that matched nothing");
    // Five tools, and none of them can author anything.
    expect(role.tools).toContain("aqa.heal_locator");
    expect(role.tools).not.toContain("bdd2pw.scaffold");
    expect(role.tools).not.toContain("ado.wit_work_item_write");
    expect(role.instructions).toContain("YOU ARE THE HEAL AGENT");
  });

  it("is the healer when the failure is an assertion but the test catches its own break", () => {
    const spec = [
      'test("Story-a — logs out via the account menu", async ({ page }) => {',
      '  await page.locator("a").click().catch(() => page.goto("/#/logout"));',
      "  expect(await token(page)).toBeNull();",
      "});",
    ].join("\n");
    const role = roleFor(
      ledgerOf([
        { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: spec } },
        run([
          {
            title: "Story-a — logs out via the account menu",
            message: "expect(received).toBeNull()",
          },
        ]),
      ]),
    );
    expect(role.name).toBe("heal");
    expect(role.because).toContain("catches its own failure");
  });

  it("does not blame a test for a .catch in a beforeEach that is not its own", () => {
    const spec = [
      "test.beforeEach(async ({ page }) => {",
      '  await page.getByRole("button", { name: "dismiss" }).waitFor({ timeout: 4000 }).catch(() => {});',
      "});",
      'test("AC-1: After logout the token is removed", async ({ page }) => {',
      '  expect(await page.evaluate(() => localStorage.getItem("token"))).not.toBeNull();',
      "});",
    ].join("\n");
    const role = roleFor(
      ledgerOf([
        { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: spec } },
        run([
          {
            title: "AC-1: After logout the token is removed",
            message: "Precondition: token must be present · expect(received).not.toBeNull()",
          },
        ]),
      ]),
    );
    expect(role.name).toBe("default");
  });

  it("is the default role when the failure is an honest assertion", () => {
    const spec = [
      'test("Story-a — logs out via the account menu", async ({ page }) => {',
      '  await page.getByRole("menuitem", { name: "Logout" }).click();',
      "  await expect(page).toHaveURL(/login/);",
      "});",
    ].join("\n");
    const role = roleFor(
      ledgerOf([
        { tool: "fs.read_file", args: { path: "tests/e.spec.ts" }, result: { content: spec } },
        run([
          {
            title: "Story-a — logs out via the account menu",
            message: "expect(page).toHaveURL(expected) failed\nReceived: http://localhost:3100/#/",
          },
        ]),
      ]),
    );
    expect(role.name).toBe("default");
    expect(role.tools).toEqual([]);
  });

  it("is the default role before anything has run", () => {
    expect(roleFor([]).name).toBe("default");
  });
});

describe("a stuck action is the healer's business, however Playwright words it", () => {
  it("treats a bare test timeout with no assertion as healable", async () => {
    const { stuckAction } = await import("../src/heal/locator.js");
    // What a broken locator actually produced (20260925T232423Z).
    expect(stuckAction("Test timeout of 30000ms exceeded.")).toBe(true);
    expect(
      stuckAction("TimeoutError: locator.click\nCall log:\n  - waiting for getByRole('menuitem')"),
    ).toBe(true);
    // A claim the product failed is NOT a heal: that is a finding.
    expect(
      stuckAction(
        "Test timeout of 30000ms exceeded.\nexpect(page).toHaveURL(expected)\nExpected pattern: /login/",
      ),
    ).toBe(false);
    expect(stuckAction('expect(received).toBeNull()\nReceived: "eyJ0…"')).toBe(false);
  });

  it("puts the run in the heal role for that failure", () => {
    const events = ledgerOf([
      run([{ title: "Story-a — logs out", message: "Test timeout of 30000ms exceeded." }]),
    ]);
    expect(roleFor(events).name).toBe("heal");
  });
});

describe("the suite is a deliverable, not a desk", () => {
  it("refuses a scratch file written into tests/", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    const why = storyRefusal(
      {
        toolName: "fs.write_file",
        args: { path: "tests/read-spec-probe.ts", content: "// probe" },
      },
      [],
    );
    expect(why).toContain("not a test, a fixture or a page object");
  });

  it("allows a spec, a page object and a fixture", async () => {
    const { storyRefusal } = await import("../src/skills/story-rules.js");
    // Only this rule is under test: a spec write has its own rules elsewhere
    // (scaffold first, and so on), so the check is that THIS refusal is silent.
    for (const path of [
      "tests/epic-42.spec.ts",
      "tests/fixtures/users.json",
      "pages/login.page.ts",
    ]) {
      const why =
        storyRefusal({ toolName: "fs.write_file", args: { path, content: "x" } }, []) ?? "";
      expect(why).not.toContain("not a test, a fixture or a page object");
    }
  });
});
