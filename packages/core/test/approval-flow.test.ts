import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.js";
import { TableGate } from "../src/governance/policy.js";
import { ScriptedApprover } from "../src/runtime/approval.js";
import { SteppingClock } from "../src/runtime/clock.js";
import { runLoop, MAX_SAME_DESIGN_PROBLEM, designProblemKey } from "../src/runtime/loop.js";
import { ScriptedModel, type ModelDecision } from "../src/runtime/model.js";
import { StubTools, type ToolDescriptor, type ToolResult } from "../src/runtime/tools.js";
import { ScriptedVerifier } from "../src/verify/scripted.js";
import type { AgentConfig, PolicyClass, Skill } from "../src/types.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { fixtureConfig } from "../examples/fixture-ledger/scenario.js";

/**
 * The Jira flow Vijay asked for (13 Oct): approve the test design — which posts
 * the test cases to the QA sub-task — then approve execution, then any bug; the
 * results go to the sub-task at the end under the design approval.
 */
const u = { inputTokens: 100, outputTokens: 10 };
const tool = (
  server: string,
  name: string,
  policyClass: PolicyClass,
  result: unknown = { ok: 1 },
) =>
  [
    { server, name, description: "", inputSchema: {}, policyClass },
    { ok: true, result, artefacts: [] as string[] },
  ] as [ToolDescriptor, ToolResult];

function setup(approveExecution: boolean, decisions: ModelDecision[]) {
  const tools = new StubTools()
    .add(...tool("aqa", "test_design", "write_record"))
    .add(...tool("jira", "record_qa", "write_record"))
    .add(...tool("pw", "run_tests", "write_workspace", { passed: 1, failed: 0, green: true }));
  const skill: Skill = {
    name: "t",
    instructions: "",
    allowedTools: ["aqa.test_design", "jira.record_qa", "pw.run_tests"],
    verifier: new ScriptedVerifier([{ done: true, gaps: [] }]),
    afterApproved: (executed) =>
      executed.some((c) => c.toolName === "aqa.test_design")
        ? [{ toolName: "jira.record_qa", args: { mode: "cases" } }]
        : [],
    finalReport: () => ({ toolName: "jira.record_qa", args: { mode: "results" } }),
  };
  const config: AgentConfig = {
    ...fixtureConfig,
    budgets: { steps: 20, tokens: 100000 },
    policy: DEFAULT_POLICY,
    ...(approveExecution ? { approve_execution: true } : {}),
  };
  const approver = new ScriptedApprover([], { decision: "approved", by: "vijay", at: "t" });
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "aqa-flow-")), "run-flow");
  return {
    tools,
    approver,
    ledger,
    deps: {
      requestText: "Write tests for QA-12",
      model: new ScriptedModel({ plan: { steps: ["a"], usage: u }, decisions }),
      tools,
      gate: new TableGate(),
      approver,
      skill,
      ledger,
      config,
      workspaceDir: "/tmp/ws",
      clock: new SteppingClock(1_000_000, 10),
    },
  };
}

const design: ModelDecision = {
  calls: [{ toolName: "aqa.test_design", args: { items: [] } }],
  usage: u,
};
const run = (i: number): ModelDecision => ({
  calls: [{ toolName: "pw.run_tests", args: { i } }],
  usage: u,
});
const done: ModelDecision = { calls: [], usage: u };

describe("Jira approval flow", () => {
  it("asks for the design, then for execution once; posts cases and results under the design approval", async () => {
    const s = setup(true, [design, run(1), run(2), done]);
    await runLoop(s.deps);
    expect(s.approver.asked.map((a) => a.calls.map((c) => c.toolName))).toEqual([
      ["aqa.test_design"],
      ["pw.run_tests"],
    ]);
    expect(
      s.tools.calls.map(
        (c) => `${c.toolName}${c.args["mode"] ? `:${String(c.args["mode"])}` : ""}`,
      ),
    ).toEqual([
      "aqa.test_design",
      "jira.record_qa:cases",
      "pw.run_tests",
      "pw.run_tests",
      "jira.record_qa:results",
    ]);
    const covered = s.ledger
      .read()
      .filter(
        (e) =>
          e.kind === "policy" &&
          String((e.payload as { reason?: string }).reason).includes(
            "covered by approval apr-0001",
          ),
      );
    expect(covered).toHaveLength(2);
  });

  it("does not ask before running the suite when approve_execution is off", async () => {
    const s = setup(false, [design, run(1), done]);
    await runLoop(s.deps);
    expect(s.approver.asked.map((a) => a.calls.map((c) => c.toolName))).toEqual([
      ["aqa.test_design"],
    ]);
  });
});

describe("design stage stop rule", () => {
  // Observed on AB#1 (13 Oct): the same item sent back 50+ times for one
  // problem, never reaching the reviewer, until the budget ran out.
  const submit = (i: number): ModelDecision => ({
    calls: [{ toolName: "aqa.test_design", args: { items: [{ id: `D${i}` }] } }],
    usage: u,
  });
  const refusing = (problem: (i: number) => string) => {
    let n = 0;
    return () => `the design has problems:\n- ${problem(++n)}`;
  };

  it("stops once the same problem is sent back MAX_SAME_DESIGN_PROBLEM times running", async () => {
    const s = setup(
      false,
      Array.from({ length: 10 }, (_, i) => submit(i)),
    );
    const reason = refusing(
      (n) => `D${n % 2 ? 7 : 6}: covers bug #49, so its type must be "confirmation"`,
    );
    s.deps.skill.refuse = (c) => (c.toolName === "aqa.test_design" ? reason() : undefined);
    const r = await runLoop(s.deps);
    expect(r.status).toBe("blocked");
    expect(r.summary).toContain(`sent back ${MAX_SAME_DESIGN_PROBLEM} times running`);
    expect(r.summary).toContain("covers bug #49");
    // The design never reached the reviewer.
    expect(s.approver.asked.flatMap((a) => a.calls.map((c) => c.toolName))).not.toContain(
      "aqa.test_design",
    );
  });

  it("keeps going while the problems change", async () => {
    const s = setup(
      false,
      Array.from({ length: 8 }, (_, i) => submit(i)),
    );
    const reason = refusing((n) => `D${n}: problem number ${n}`);
    s.deps.skill.refuse = (c) => (c.toolName === "aqa.test_design" ? reason() : undefined);
    const r = await runLoop(s.deps);
    expect(r.summary).not.toContain("no progress on the test design");
  });

  it("strips the item id so a renumbered item still counts", () => {
    expect(designProblemKey("D7: covers bug #49")).toBe(designProblemKey("D6:  covers bug #49"));
    expect(designProblemKey("D1-44: x")).toBe("x");
  });
});
