import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roleFor } from "../src/agents/roles.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A failure the healer cannot repair leaves the heal role.
 *
 * Runs 20261114T144930Z and …145555Z (TOOL-34, route B). The test for a
 * 75-year-old waits for a refusal message; the application accepts the
 * registration, so the message is never there. `aqa.heal_locator` said so. The
 * run stayed in the heal role — five tools, no bug tool — and ended blocked
 * with a real defect unreported.
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

const AGE_75 = {
  title: "AC-1c A customer aged 75 is refused",
  message:
    "Error: expect(locator).toBeVisible() failed\nLocator: getByText('75').first()\nExpected: visible\n" +
    "Timeout: 5000ms\nError: element(s) not found\nCall log:\n  - waiting for getByText('75').first()",
};
const MENU = {
  title: "AC-3 Signing out from the menu",
  message:
    "TimeoutError: locator.click\nCall log:\n  - waiting for locator('a[href=\"#/logout\"]')",
};
const run = (failures: Array<{ title: string; message: string }>, args = {}) => ({
  tool: "pw.run_tests",
  args,
  result: { passed: 1, failed: failures.length, skipped: 0, flaky: 0, green: false, failures },
});
const healed = (title: string, result: Record<string, unknown>) => ({
  tool: "aqa.heal_locator",
  args: { test: title },
  result: { test: title, ...result },
});
const SELECTOR = "getByText('75').first()";
const ABSENT = {
  failedSelector: SELECTOR,
  controlOnPage: false,
  verdict: "No candidate shares a word with the selector",
};

describe("the heal role and a control that is not there", () => {
  it("starts on the locator failure", () => {
    expect(roleFor(ledgerOf([run([AGE_75])])).name).toBe("heal");
  });

  it("ends once the healer has said the control was not on the page", () => {
    expect(roleFor(ledgerOf([run([AGE_75]), healed(AGE_75.title, ABSENT)])).name).toBe("default");
  });

  it("reads the same from a ledger written before the field existed", () => {
    for (const verdict of [
      "No candidate shares a word with the selector that failed. The control may genuinely be absent",
      "NOTHING CLICKABLE OR TYPEABLE WAS ON THE PAGE when this test failed.",
    ])
      expect(
        roleFor(
          ledgerOf([run([AGE_75]), healed(AGE_75.title, { failedSelector: SELECTOR, verdict })]),
        ).name,
      ).toBe("default");
  });

  it("stays while the healer found the control, or has another failure to look at", () => {
    const found = {
      controlOnPage: true,
      verdict: "The control this test was looking for IS on the page",
    };
    expect(roleFor(ledgerOf([run([AGE_75]), healed(AGE_75.title, found)])).name).toBe("heal");
    expect(roleFor(ledgerOf([run([AGE_75, MENU]), healed(AGE_75.title, ABSENT)])).name).toBe(
      "heal",
    );
  });

  it("stays ended when a later run fails on the same selector", () => {
    // 20261114T151820Z: another test was edited, the suite ran again, and the
    // run was back in the heal role for a failure already answered.
    const events = ledgerOf([run([AGE_75]), healed(AGE_75.title, ABSENT), run([AGE_75])]);
    expect(roleFor(events).name).toBe("default");
  });

  it("starts again when the test then fails on a different selector", () => {
    const moved = {
      ...AGE_75,
      message: AGE_75.message.split(SELECTOR).join("getByRole('alert')"),
    };
    const events = ledgerOf([run([AGE_75]), healed(AGE_75.title, ABSENT), run([moved])]);
    expect(roleFor(events).name).toBe("heal");
  });
});

/** The real ledger and workspace; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261114T145555Z-fd514b1c", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "toolshop");
describe.skipIf(!existsSync(RUN) || !existsSync(WS))("run 20261114T145555Z, replayed", () => {
  const all = (): AnyRunEvent[] =>
    readFileSync(RUN, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);

  it("leaves the heal role once the healer has answered for the 75-year-old test", () => {
    const events = all();
    const firstVerify = events.find((e) => e.kind === "verify");
    const upTo = events.filter((e) => e.eventId < (firstVerify?.eventId ?? 0));
    expect(roleFor(upTo, "TOOL-34").name).toBe("default");
    // And was in it before the healer was asked.
    const firstHeal = events.find(
      (e) => e.kind === "call" && e.payload.toolName === "heal_locator",
    );
    expect(
      roleFor(
        events.filter((e) => e.eventId < (firstHeal?.eventId ?? 0)),
        "TOOL-34",
      ).name,
    ).toBe("heal");
  });

  it("tells the run which failing test has no bug, and what can be done about it", async () => {
    const events = all();
    for (const e of events) {
      const facts = (
        e.payload as { result?: { facts?: { filedBugs?: Array<Record<string, unknown>> } } }
      ).result?.facts;
      for (const b of facts?.filedBugs ?? [])
        if (b["id"] === "TOOL-36" || b["id"] === "TOOL-37") b["linked"] = true;
    }
    const last = [...events].reverse().find((e) => e.kind === "verify");
    const out = await new StoryToTestsVerifier({ workItem: "TOOL-34", tracker: "jira" }).verify({
      events: events.filter((e) => e.eventId < (last?.eventId ?? 0)),
      workspaceDir: WS,
    });
    const red = out.gaps.find((g) => g.code === "suite-not-green")?.message ?? "";
    expect(red).toContain('with no bug: "AC-1c A customer aged 75');
    expect(red).not.toContain("AC-1a A customer aged 18 to 74");
    expect(red).toContain("propose a bug");
  });
});

const RUN3 = join(__dirname, "..", ".aqa", "runs", "20261114T151820Z-a95af210", "events.jsonl");
describe.skipIf(!existsSync(RUN3))("run 20261114T151820Z, replayed", () => {
  it("does not go back to the heal role for the failure the healer already answered", () => {
    const events = readFileSync(RUN3, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    const firstVerify = events.find((e) => e.kind === "verify");
    const upTo = events.filter((e) => e.eventId < (firstVerify?.eventId ?? 0));
    expect(roleFor(upTo, "TOOL-34").name).toBe("default");
  });
});
