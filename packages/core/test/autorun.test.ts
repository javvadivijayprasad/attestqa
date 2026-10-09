import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storyToTestsSkill } from "../src/skills/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Executing a suite is not a judgement. Once a design is approved and a spec
 * exists, the suite runs — so the runtime runs it, and the model spends its
 * turns on the things that need one. These tests are about WHEN.
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
      payload: { eventIdOfCall: callId, ok: true, result: e.result ?? {}, artefacts: [], durationMs: 1 },
    } as AnyRunEvent);
  }
  return events;
}

const SPEC = "tests/epic-42-customer-account-access.spec.ts";

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-autorun-"));
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(join(ws, SPEC), 'test("x", async () => {});');
  return ws;
}

const CONTEXT = {
  tool: "aqa.story_context",
  result: {
    kind: "preflight",
    summary: {},
    text: "story 44",
    facts: {
      acceptanceCriteria: [],
      bugs: [],
      tasks: [],
      story: { id: 44, title: "Log out" },
      epic: { id: 42, title: "Customer account access" },
    },
  },
};

const DESIGN = {
  tool: "aqa.test_design",
  args: {
    items: [
      {
        id: "D9",
        covers: "story",
        type: "functional",
        technique: "state-transition",
        conditions: ["c"],
        expected: "e",
        source: "story description",
      },
    ],
  },
};

const RUN = (extra: Record<string, unknown> = {}) => ({
  tool: "pw.run_tests",
  args: { spec: SPEC, ...extra },
  result: { passed: 1, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] },
});

const skill = (ws: string) =>
  storyToTestsSkill({ workItem: "44", workspaceDir: ws, testTypes: ["functional"] });

describe("the runtime runs the suite, and says why", () => {
  it("runs once a design is approved and a spec exists", () => {
    const ws = workspace();
    const at = skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN]));
    expect(at?.toolName).toBe("pw.run_tests");
    expect(at?.args).toEqual({ spec: SPEC });
    expect(at?.why).toBe("nothing has run yet");
  });

  it("does not run before the design is approved", () => {
    const ws = workspace();
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT]))).toBeUndefined();
  });

  it("does not run again when nothing has changed", () => {
    const ws = workspace();
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN, RUN()]))).toBeUndefined();
  });

  it("runs again after the spec is edited, naming the file", () => {
    const ws = workspace();
    const at = skill(ws).autoRun?.(
      ledgerOf([
        CONTEXT,
        DESIGN,
        RUN(),
        { tool: "fs.replace_in_file", args: { path: SPEC, old: "a", new: "b" }, result: { replaced: 1 } },
      ]),
    );
    expect(at?.why).toContain(SPEC);
    expect(at?.why).toContain("changed since the last full run");
  });

  it("ignores a filtered run — that is the healer checking one test", () => {
    const ws = workspace();
    // A grep run happened, but the full suite has not: the runtime still owes one.
    const at = skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN, RUN({ grep: "Story-a" })]));
    expect(at?.why).toBe("nothing has run yet");
  });

  it("does not run when there is no spec to run", () => {
    const ws = mkdtempSync(join(tmpdir(), "aqa-empty-"));
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN]))).toBeUndefined();
  });
});
