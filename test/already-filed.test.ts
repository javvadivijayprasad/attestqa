import { describe, it, expect } from "vitest";
import { composeRunReport } from "../src/mcp/adapters/summary.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Closing the loop between a refusal and the record.
 *
 * `duplicateBug` refuses the second filing of one defect and tells the agent to
 * say so in its report instead. But the report is composed from the ledger by
 * code, not written by the agent, so that sentence had nowhere to go: the reader
 * of 20260928T095319Z saw two failing tests and no bug reference at all, while
 * both defects were on record, open, and had just been reproduced.
 *
 * The refusal names the bug. The report reads it back.
 */

const SPEC = "tests/epic-42.spec.ts";
const FILED = {
  id: 83,
  state: "Active",
  title: "Story-a: Logout redirects to home page instead of login page",
  agent: true,
};

let id = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };

function context(): AnyRunEvent[] {
  const callId = ++id;
  return [
    { ...base, eventId: callId, kind: "call", payload: { server: "aqa", toolName: "story_context", args: {}, startedAt: 0 } },
    {
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: true,
        result: {
          kind: "preflight",
          summary: {},
          text: "story 44",
          facts: {
            acceptanceCriteria: [],
            bugs: [],
            filedBugs: [FILED],
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

const PROPOSAL = {
  toolName: "ado.wit_work_item_write",
  args: {
    action: "create",
    workItemType: "Bug",
    project: "agentic-qa-sandbox",
    parentId: 44,
    tags: "agentic-qa",
    title: "Logout does not redirect to the login page — app stays on /#/",
  },
};

/** The refusal as the gate records it, taken from the rule itself — not copied. */
function refusalEvent(reason: string): AnyRunEvent {
  return {
    ...base,
    eventId: ++id,
    kind: "policy",
    payload: {
      toolName: "ado.wit_work_item_write",
      class: "write_record",
      decision: "refuse",
      reason,
    },
  } as unknown as AnyRunEvent;
}

function ranTheSuite(): AnyRunEvent[] {
  const callId = ++id;
  return [
    { ...base, eventId: callId, kind: "call", payload: { server: "pw", toolName: "run_tests", args: { spec: SPEC }, startedAt: 0 } },
    {
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: true,
        result: {
          passed: 1,
          failed: 1,
          skipped: 0,
          flaky: 0,
          green: false,
          failures: [{ title: "Story-a — logout", file: SPEC, message: "toHaveURL failed" }],
          tests: [{ title: "Story-a — logout", file: SPEC, status: "failed", durationMs: 10 }],
          testsOmitted: 0,
        },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}

describe("a reproduced defect that is already on record", () => {
  it("appears in the report, quoting the bug the rule named", () => {
    const events = [...context(), ...ranTheSuite()];
    const why = storyRefusal(PROPOSAL, events);
    expect(why).toBeDefined();

    // The refusal text goes into the ledger exactly as the rule produced it —
    // this is the coupling the report depends on, so it is asserted here rather
    // than restated as a literal.
    const report = composeRunReport([...events, refusalEvent(why as string)], "r", { workItem: "44" });
    expect(report.text).toContain("**Bugs:**");
    expect(report.text).toContain("#83");
    expect(report.text).toContain("Active");
    expect(report.text).toContain("confirmed and unfixed");
    expect(report.text).toContain(FILED.title);
  });

  it("says it once, however many proposals the rule refused", () => {
    const events = [...context(), ...ranTheSuite()];
    const why = storyRefusal(PROPOSAL, events) as string;
    const report = composeRunReport(
      [...events, refusalEvent(why), refusalEvent(why), refusalEvent(why)],
      "r",
      { workItem: "44" },
    );
    expect(report.text.match(/#83 \[Active\]/g) ?? []).toHaveLength(1);
  });

  it("stays silent when no proposal was refused as a duplicate", () => {
    const report = composeRunReport([...context(), ...ranTheSuite()], "r", { workItem: "44" });
    expect(report.text).not.toContain("already recorded");
  });

  it("does not confuse another refusal for this one", () => {
    const events = [...context(), ...ranTheSuite()];
    const report = composeRunReport(
      [...events, refusalEvent('this bug is missing one thing: parentId: 44 — a bug nobody can trace to a story')],
      "r",
      { workItem: "44" },
    );
    expect(report.text).not.toContain("already recorded");
  });
});
