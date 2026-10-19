import { describe, it, expect } from "vitest";
import { StageTracker } from "../src/runtime/stages.js";
import type { AnyRunEvent } from "../src/types.js";

let id = 0;
const ev = (kind: string, payload: Record<string, unknown>): AnyRunEvent =>
  ({
    tool: "attestqa",
    runId: "r",
    eventId: ++id,
    timestamp: 1,
    kind,
    payload,
  }) as unknown as AnyRunEvent;
const call = (server: string, toolName: string, args: Record<string, unknown> = {}) =>
  ev("call", { server, toolName, args, startedAt: 0 });

function play(events: AnyRunEvent[]): string {
  const t = new StageTracker();
  return events.map((e) => t.line(e)).join("");
}

describe("the run says which stage it is in", () => {
  it("announces each stage of a new story, then the report", () => {
    const events: AnyRunEvent[] = [
      ev("request", { text: "Write tests for TOOL-6" }),
      ev("route", { path: "A" }),
    ];
    events.push(
      ev("approval_requested", {
        approvalId: "apr-0001",
        calls: [{ toolName: "aqa.test_design", args: {} }],
      }),
      ev("approval_resolved", { approvalId: "apr-0001", decision: "approved" }),
      call("fs", "write_file", { path: "features/epic.feature", content: "" }),
    );
    const scaffold = call("bdd2pw", "scaffold", { feature: "features/epic.feature" });
    events.push(
      scaffold,
      ev("observation", { eventIdOfCall: scaffold.eventId, ok: true, result: {} }),
    );
    events.push(
      ev("approval_requested", {
        approvalId: "apr-0002",
        calls: [{ toolName: "pw.run_tests", args: {} }],
      }),
    );
    const run = call("pw", "run_tests", { spec: "tests/epic.spec.ts" });
    events.push(
      run,
      ev("observation", {
        eventIdOfCall: run.eventId,
        ok: true,
        result: { passed: 3, failed: 1, skipped: 0 },
      }),
      ev("triage", { verdicts: [{ category: "real-defect" }] }),
      ev("agent", { role: "heal", because: "a locator matched nothing" }),
      ev("agent", { role: "default" }),
      ev("end", { status: "done", summary: "" }),
    );
    const out = play(events);
    for (const line of [
      "== Test design: started",
      "== Test design: ready — waiting for your approval",
      "== Test design: done — approved",
      "== Test case authoring: started",
      "== Test case authoring: done",
      "== Building the test script (bdd2pw): started",
      "== Building the test script (bdd2pw): done — spec generated",
      "== Execution: waiting for your approval to run the suite",
      "== Execution: started",
      "== Defect analysis: started — 1 failure(s): 1 possible product defect(s)",
      "== Self-healing: started — a locator matched nothing",
      "== Self-healing: done",
      "== Execution: done",
      "== Creating defects: none",
      "Total scripts : 4",
      "Passed        : 3",
      "Failed        : 1",
      "Defects found : 0 filed",
      "== Story TOOL-6: completed",
    ])
      expect(out).toContain(line);
    // In that order.
    expect(out.indexOf("Test design: started")).toBeLessThan(out.indexOf("Execution: started"));
    expect(out.indexOf("Execution: done")).toBeLessThan(out.indexOf("== Report"));
  });

  it("says authoring was skipped when the story's tests already exist", () => {
    const out = play([
      ev("request", { text: "Write tests for SCRUM-6" }),
      ev("route", { path: "B" }),
      ev("approval_requested", {
        approvalId: "a",
        calls: [{ toolName: "pw.run_tests", args: {} }],
      }),
      ev("end", { status: "blocked", summary: "verifier gaps remain" }),
    ]);
    expect(out).toContain("== Test case authoring: skipped");
    expect(out).not.toContain("Building the test script (bdd2pw): started");
    expect(out).toContain("The suite did not run.");
    expect(out).toContain("== Story SCRUM-6: stopped (blocked) — verifier gaps remain");
  });

  it("counts defects proposed and filed", () => {
    const bug = { toolName: "jira.create_bug", args: { storyKey: "TOOL-6" } };
    const filed = call("jira", "create_bug", { storyKey: "TOOL-6" });
    const out = play([
      ev("route", { path: "A" }),
      ev("approval_requested", { approvalId: "b", calls: [bug, bug] }),
      filed,
      ev("observation", { eventIdOfCall: filed.eventId, ok: true, result: { key: "TOOL-30" } }),
      ev("end", { status: "done", summary: "" }),
    ]);
    expect(out).toContain("== Creating defects: 2 proposed — waiting for your approval");
    expect(out).toContain("Defects found : 1 filed, 1 proposed but not filed");
  });
});

describe("the report links what was filed and shows the evidence", () => {
  it("lists the bug link, the QA record link and each failure's screenshot", async () => {
    const { StageTracker } = await import("../src/runtime/stages.js");
    const t = new StageTracker();
    let id = 0;
    const ev = (kind: string, payload: Record<string, unknown>) =>
      ({
        tool: "attestqa",
        runId: "r",
        timestamp: 1,
        eventId: ++id,
        kind,
        payload,
      }) as unknown as import("../src/types.js").AnyRunEvent;
    const out: string[] = [];
    const call = (
      server: string,
      toolName: string,
      args: Record<string, unknown>,
      result: unknown,
    ) => {
      out.push(t.line(ev("call", { server, toolName, args, startedAt: 0 })));
      out.push(
        t.line(
          ev("observation", { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 }),
        ),
      );
    };
    out.push(t.line(ev("request", { text: "Write tests for TOOL-6" })));
    call(
      "pw",
      "run_tests",
      { spec: "s" },
      {
        passed: 4,
        failed: 1,
        skipped: 0,
        failures: [
          { title: "AC-3 marks the page", screenshot: "test-results/x/test-failed-1.png" },
        ],
      },
    );
    call(
      "jira",
      "create_bug",
      { projectKey: "TOOL" },
      {
        key: "TOOL-30",
        url: "https://x.atlassian.net/browse/TOOL-30",
        attached: ["a.png", "trace.zip"],
      },
    );
    call(
      "jira",
      "record_qa",
      {},
      { qaKey: "TOOL-22", url: "https://x.atlassian.net/browse/TOOL-22" },
    );
    out.push(t.line(ev("end", { status: "done", summary: "ok" })));
    const text = out.join("");
    expect(text).toContain("screenshot: test-results/x/test-failed-1.png");
    expect(text).toContain(
      "TOOL-30  https://x.atlassian.net/browse/TOOL-30  (2 files attached: screenshot/trace)",
    );
    expect(text).toContain("Test cases    : TOOL-22  https://x.atlassian.net/browse/TOOL-22");
  });
});
