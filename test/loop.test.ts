import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LEDGER_FILE, runDir } from "../src/ledger/ledger.js";
import { ScopedGate, TableGate } from "../src/governance/policy.js";
import { ScriptedApprover } from "../src/runtime/approval.js";
import { SteppingClock } from "../src/runtime/clock.js";
import { runLoop, withRuntimeArgs, type LoopDeps } from "../src/runtime/loop.js";
import { ScriptedModel, type ModelDecision } from "../src/runtime/model.js";
import { StubTools } from "../src/runtime/tools.js";
import { ScriptedVerifier } from "../src/verify/scripted.js";
import type { AgentConfig, Skill, AnyRunEvent } from "../src/types.js";
import { DEFAULT_POLICY } from "../src/types.js";
import {
  FIXTURE_RUN_ID,
  fixtureConfig,
  fixtureModel,
  fixtureSkill,
  fixtureTools,
  runFixtureScenario,
} from "../examples/fixture-ledger/scenario.js";

const FIXTURE = join(process.cwd(), "examples", "fixture-ledger", "events.jsonl");
const tmp = () => mkdtempSync(join(tmpdir(), "aqa-loop-"));
const u = { inputTokens: 100, outputTokens: 10 };
const kinds = (events: AnyRunEvent[]) => events.map((e) => e.kind);

function tools(): StubTools {
  return new StubTools()
    .add(
      { server: "s", name: "read", description: "", inputSchema: {}, policyClass: "read" },
      { ok: true, result: { v: 1 }, artefacts: [] },
    )
    .add(
      { server: "s", name: "write", description: "", inputSchema: {}, policyClass: "write_record" },
      { ok: true, result: { saved: true }, artefacts: [] },
    )
    .add(
      { server: "s", name: "boom", description: "", inputSchema: {}, policyClass: "read" },
      () => {
        throw new Error("tool exploded");
      },
    );
}

function skill(verifier = new ScriptedVerifier([{ done: true, gaps: [] }])): Skill {
  return {
    name: "t",
    instructions: "test skill",
    allowedTools: ["s.read", "s.write", "s.boom"],
    verifier,
  };
}

function config(over: Partial<AgentConfig["budgets"]> = {}): AgentConfig {
  return {
    ...fixtureConfig,
    budgets: { steps: 10, tokens: 100000, ...over },
    policy: DEFAULT_POLICY,
  };
}

function deps(
  decisions: ModelDecision[],
  over: Partial<LoopDeps> = {},
): LoopDeps & { ledger: Ledger } {
  const ledger = new Ledger(tmp(), "run-t");
  return {
    requestText: "do the thing",
    model: new ScriptedModel({ plan: { steps: ["a"], usage: u }, decisions }),
    tools: tools(),
    gate: new TableGate(),
    approver: new ScriptedApprover([], {
      decision: "approved",
      by: "tester",
      at: "2026-01-01T00:00:00Z",
    }),
    skill: skill(),
    ledger,
    config: config(),
    workspaceDir: "/tmp/ws",
    clock: new SteppingClock(1_000_000, 10),
    ...over,
  };
}

const goal: ModelDecision = { calls: [], usage: u };
const read: ModelDecision = { calls: [{ toolName: "s.read", args: {} }], usage: u };
/**
 * Distinct reads. Repeating one identical call is caught by the no-progress
 * stop rule (see "stop rules" below), so a test about BUDGETS has to make
 * genuinely different calls or it would stop for the other reason first.
 */
const reads = (n: number): ModelDecision[] =>
  Array.from({ length: n }, (_, i) => ({
    calls: [{ toolName: "s.read", args: { i } }],
    usage: u,
  }));

describe("golden: the loop reproduces the checked-in fixture exactly", () => {
  it("byte-for-byte", async () => {
    const root = tmp();
    const result = await runFixtureScenario(root);
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    const produced = readFileSync(join(runDir(root, FIXTURE_RUN_ID), LEDGER_FILE), "utf8");
    const golden = readFileSync(FIXTURE, "utf8");
    expect(produced).toBe(golden);
  });

  it("the fixture scenario only exposes the skill's allowed tools to the model", async () => {
    const model = fixtureModel();
    const ledger = new Ledger(tmp(), "run-x");
    await runLoop({
      requestText: "r",
      model,
      tools: fixtureTools(),
      gate: new TableGate(),
      approver: new ScriptedApprover([], { decision: "approved", by: "t", at: "" }),
      skill: fixtureSkill(),
      ledger,
      config: fixtureConfig,
      workspaceDir: "/tmp",
      clock: new SteppingClock(1, 1),
    });
    const seen = model.inputs[0]!.tools.map((t) => `${t.server}.${t.name}`).sort();
    expect(seen).toEqual([...fixtureSkill().allowedTools].sort());
  });
});

describe("stop rules", () => {
  it("done: goal reached and verifier passes → exit 0, end event, summary.md written", async () => {
    const d = deps([read, goal]);
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    expect(r.exitCode).toBe(0);
    const ev = d.ledger.read();
    expect(kinds(ev)).toEqual([
      "request",
      "plan",
      // S5: every run records the role its first turn belongs to.
      "agent",
      "context",
      "inference",
      "policy",
      "call",
      "observation",
      "context",
      "inference",
      "verify",
      "end",
    ]);
    expect(readFileSync(join(d.ledger.dir, "summary.md"), "utf8")).toContain("# agentic-qa replay");
  });

  it("budget: step budget exhausted → exit 4", async () => {
    const d = deps(reads(10), { config: config({ steps: 3 }) });
    const r = await runLoop(d);
    expect(r.status).toBe("budget");
    expect(r.exitCode).toBe(4);
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(3);
    expect(r.summary).toMatch(/step budget of 3/);
  });

  it("no progress: the same call repeated → blocked, long before the budget dies", async () => {
    // The failure this reproduces: a real run made the same two reads 29 times
    // each across 36 cycles and died of token exhaustion with nothing done.
    const d = deps(Array(30).fill(read), { config: config({ steps: 50, tokens: 1_000_000 }) });
    const r = await runLoop(d);
    expect(r.status).toBe("blocked");
    expect(r.exitCode).toBe(2);
    expect(r.summary).toMatch(/no progress/);
    // it executed the call ONCE; the repeats never reached the tool
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(1);
  });

  it("no progress: a NEW call resets the counter", async () => {
    const d = deps(
      [read, read, { calls: [{ toolName: "s.read", args: { x: 1 } }], usage: u }, goal],
      {
        config: config({ steps: 50 }),
      },
    );
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(2);
  });

  it("budget: token budget exhausted → exit 4", async () => {
    const d = deps(reads(10), { config: config({ tokens: 250 }) });
    const r = await runLoop(d);
    expect(r.status).toBe("budget");
    expect(r.summary).toMatch(/token budget/);
  });

  it("blocked: verifier gaps → one retry with gaps in context → still gaps → exit 2", async () => {
    const verifier = new ScriptedVerifier([
      { done: false, gaps: [{ code: "AC_UNCOVERED", message: "AC-3 has no scenario" }] },
      { done: false, gaps: [{ code: "AC_UNCOVERED", message: "AC-3 has no scenario" }] },
    ]);
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [goal, read, goal],
    });
    const d = deps([], { model, skill: skill(verifier) });
    const r = await runLoop(d);
    expect(r.status).toBe("blocked");
    expect(r.exitCode).toBe(2);
    // The model saw the gaps on the retry cycle.
    expect(model.inputs[1]!.gaps).toEqual(["AC_UNCOVERED: AC-3 has no scenario"]);
    expect(d.ledger.read().filter((e) => e.kind === "verify")).toHaveLength(2);
  });

  it("done after retry: gaps closed on the second verify", async () => {
    const verifier = new ScriptedVerifier([
      { done: false, gaps: [{ code: "X", message: "m" }] },
      { done: true, gaps: [] },
    ]);
    const d = deps([goal, read, goal], { skill: skill(verifier) });
    expect((await runLoop(d)).status).toBe("done");
  });

  it("blocked: approval denied and nothing else in the cycle → exit 2", async () => {
    const d = deps([{ calls: [{ toolName: "s.write", args: { x: 1 } }], usage: u }], {
      approver: new ScriptedApprover([{ decision: "denied", by: "reviewer", at: "t" }]),
    });
    const r = await runLoop(d);
    expect(r.status).toBe("blocked");
    expect(r.summary).toMatch(/apr-0001 denied/);
    const ev = d.ledger.read();
    expect(ev.filter((e) => e.kind === "call")).toHaveLength(0);
    expect(kinds(ev)).toContain("approval_requested");
    expect(kinds(ev)).toContain("approval_resolved");
  });

  it("error: the model throws → exit 1 with the message", async () => {
    const d = deps([]); // ScriptedModel throws when asked beyond its script
    const r = await runLoop(d);
    expect(r.status).toBe("error");
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/no decision scripted/);
    expect(d.ledger.read().at(-1)!.kind).toBe("end");
  });
});

describe("gate feedback", () => {
  it("a refused (unknown) tool is never called and the model sees the refusal next cycle", async () => {
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [{ calls: [{ toolName: "s.delete_everything", args: {} }], usage: u }, goal],
    });
    const d = deps([], { model });
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    const ev = d.ledger.read();
    const policy = ev.find((e) => e.kind === "policy")!;
    expect(policy.kind === "policy" && policy.payload.decision).toBe("refuse");
    expect(policy.kind === "policy" && policy.payload.class).toBe("destructive");
    expect(ev.filter((e) => e.kind === "call")).toHaveLength(0);
    expect((d.tools as StubTools).calls).toHaveLength(0);
    const seen = model.inputs[1]!.history[0]!;
    expect(seen.gate?.decision).toBe("refuse");
    expect(seen.ok).toBe(false);
  });

  it("a tool not in the skill's allow-list is invisible and refused even if the client has it", async () => {
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [{ calls: [{ toolName: "s.write", args: {} }], usage: u }, goal],
    });
    const d = deps([], { model, skill: { ...skill(), allowedTools: ["s.read"] } });
    await runLoop(d);
    const policy = d.ledger.read().find((e) => e.kind === "policy")!;
    expect(policy.kind === "policy" && policy.payload.decision).toBe("refuse");
    expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["read"]);
  });

  it("a tool that throws becomes a failed observation, not a crashed run", async () => {
    const d = deps([{ calls: [{ toolName: "s.boom", args: {} }], usage: u }, goal]);
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    const obs = d.ledger.read().find((e) => e.kind === "observation")!;
    expect(obs.kind === "observation" && obs.payload.ok).toBe(false);
    expect(obs.kind === "observation" && JSON.stringify(obs.payload.result)).toContain(
      "tool exploded",
    );
  });

  it("one approval batches every ask in a cycle and executes them in order once approved", async () => {
    const approver = new ScriptedApprover([{ decision: "approved", by: "lead", at: "t" }]);
    const d = deps(
      [
        {
          calls: [
            { toolName: "s.read", args: {} },
            { toolName: "s.write", args: { a: 1 } },
            { toolName: "s.write", args: { a: 2 } },
          ],
          usage: u,
        },
        goal,
      ],
      { approver },
    );
    await runLoop(d);
    expect(approver.asked).toHaveLength(1);
    expect(approver.asked[0]!.calls).toHaveLength(2);
    expect(approver.asked[0]!.approvalId).toBe("apr-0001");
    const calls = (d.tools as StubTools).calls.map((c) => c.args);
    expect(calls).toEqual([{}, { a: 1 }, { a: 2 }]);
    const policies = d.ledger.read().filter((e) => e.kind === "policy");
    expect(policies).toHaveLength(3);
    expect(
      policies.filter((p) => p.kind === "policy" && p.payload.approvalId === "apr-0001"),
    ).toHaveLength(2);
  });

  it("ledger context events carry hashes and counts only, never content", async () => {
    const d = deps([read, goal], { requestText: "SECRET-REQUEST-TEXT" });
    await runLoop(d);
    const ctx = d.ledger.read().filter((e) => e.kind === "context");
    expect(ctx.length).toBeGreaterThan(0);
    for (const c of ctx) expect(JSON.stringify(c.payload)).not.toContain("SECRET-REQUEST-TEXT");
  });
});

describe("repeat memo vs state change", () => {
  it("allows a re-run after a workspace write — the world changed, so the call means something new", async () => {
    // The failure this encodes: the agent wrote the spec, ran the suite, fixed
    // the spec, and then could not re-run because the call looked identical.
    const t = new StubTools()
      .add(
        {
          server: "s",
          name: "run",
          description: "",
          inputSchema: {},
          policyClass: "write_workspace",
        },
        { ok: true, result: { green: false }, artefacts: [] },
      )
      .add(
        {
          server: "s",
          name: "edit",
          description: "",
          inputSchema: {},
          policyClass: "write_workspace",
        },
        { ok: true, result: { written: true }, artefacts: ["tests/a.spec.ts"] },
      );
    const run: ModelDecision = { calls: [{ toolName: "s.run", args: {} }], usage: u };
    const edit: ModelDecision = { calls: [{ toolName: "s.edit", args: {} }], usage: u };
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [run, edit, run, edit, run, goal],
    });
    const d = deps([], {
      model,
      tools: t,
      skill: {
        name: "t",
        instructions: "",
        allowedTools: ["s.run", "s.edit"],
        verifier: new ScriptedVerifier([{ done: true, gaps: [] }]),
      },
      config: config({ steps: 20 }),
    });
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    // all five calls executed: the repeats were legitimate
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(5);
  });
});

describe("an operation the environment refuses is closed for the rest of the run", () => {
  const DENIAL =
    "Error creating test plan: You are not authorized to access this API. " +
    "Please contact your project administrator";

  const planTools = () =>
    new StubTools().add(
      {
        server: "ado",
        name: "plan_write",
        description: "",
        inputSchema: {},
        policyClass: "write_record",
      },
      { ok: false, result: { message: DENIAL }, artefacts: [] },
    );

  const planSkill = (): Skill => ({
    name: "t",
    instructions: "",
    allowedTools: ["ado.plan_write"],
    verifier: new ScriptedVerifier([{ done: true, gaps: [] }]),
  });

  /**
   * The shape actually observed: the model varies the arguments between
   * attempts, so the exact-argument repeat memo never fires and every attempt
   * reaches the reviewer as a fresh approval.
   */
  const varied: ModelDecision[] = [
    { calls: [{ toolName: "ado.plan_write", args: { action: "create", name: "P" } }], usage: u },
    {
      calls: [
        { toolName: "ado.plan_write", args: { action: "create", name: "P", iteration: "i" } },
      ],
      usage: u,
    },
    {
      calls: [{ toolName: "ado.plan_write", args: { action: "create", name: "P", areaPath: "a" } }],
      usage: u,
    },
    goal,
  ];

  it("is attempted once, then refused without calling the tool again", async () => {
    const d = deps(varied, {
      tools: planTools(),
      skill: planSkill(),
      config: config({ steps: 20 }),
    });
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(1);
  });

  it("does not ask the reviewer to approve a call already known to be dead", async () => {
    const d = deps(varied, {
      tools: planTools(),
      skill: planSkill(),
      config: config({ steps: 20 }),
    });
    await runLoop(d);
    expect(d.ledger.read().filter((e) => e.kind === "approval_requested")).toHaveLength(1);
  });

  it("records the refusal as a policy decision quoting the environment", async () => {
    const d = deps(varied, {
      tools: planTools(),
      skill: planSkill(),
      config: config({ steps: 20 }),
    });
    await runLoop(d);
    const refusals = d.ledger
      .read()
      .filter((e) => e.kind === "policy")
      .map((e) => e.payload as { decision: string; reason: string })
      .filter((p) => p.decision === "refuse");
    expect(refusals).toHaveLength(2);
    expect(refusals[0]!.reason).toContain("not authorized to access this API");
    expect(refusals[0]!.reason).toContain("ado.plan_write#create");
  });

  it("closes the operation, not the tool: another action of the same tool still runs", async () => {
    const t = new StubTools()
      .add(
        {
          server: "ado",
          name: "plan_write",
          description: "",
          inputSchema: {},
          policyClass: "write_record",
        },
        (args: Record<string, unknown>) =>
          args["action"] === "create"
            ? { ok: false, result: { message: DENIAL }, artefacts: [] }
            : { ok: true, result: { updated: true }, artefacts: [] },
      )
      .add(
        { server: "s", name: "read", description: "", inputSchema: {}, policyClass: "read" },
        { ok: true, result: { v: 1 }, artefacts: [] },
      );
    const d = deps(
      [
        { calls: [{ toolName: "ado.plan_write", args: { action: "create" } }], usage: u },
        { calls: [{ toolName: "ado.plan_write", args: { action: "update" } }], usage: u },
        goal,
      ],
      {
        tools: t,
        skill: {
          name: "t",
          instructions: "",
          allowedTools: ["ado.plan_write", "s.read"],
          verifier: new ScriptedVerifier([{ done: true, gaps: [] }]),
        },
        config: config({ steps: 20 }),
      },
    );
    await runLoop(d);
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(2);
  });

  it("an ordinary failure is still retryable", async () => {
    const t = new StubTools().add(
      {
        server: "ado",
        name: "plan_write",
        description: "",
        inputSchema: {},
        policyClass: "write_record",
      },
      { ok: false, result: { message: "Required field 'name' was not supplied" }, artefacts: [] },
    );
    const d = deps(varied, { tools: t, skill: planSkill(), config: config({ steps: 20 }) });
    await runLoop(d);
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(3);
  });
});

describe("preflight: reads the RUNTIME makes before the model's first turn", () => {
  it("runs them through the gate and the ledger, and hands the model the digest", async () => {
    // Stage 1 was left to the model and the model skipped half of it. Moving it
    // into the runtime must not move it outside governance: every read is
    // judged and recorded exactly like a model-proposed call.
    const seenByModel: string[] = [];
    const d = deps([goal], {
      skill: {
        ...skill(),
        sourceTools: ["aqa.story_context"],
        preflight: async (readFn) => {
          const r = await readFn("s.read", { id: 1 });
          return {
            toolName: "aqa.story_context",
            text: `CONTEXT v=${JSON.stringify(r.result)}`,
            summary: { storyRead: r.ok ? 1 : 0 },
          };
        },
      },
      model: {
        model: "m",
        promptVersion: "p",
        plan: async (input) => {
          seenByModel.push(JSON.stringify(input));
          return { steps: ["a"], usage: u };
        },
        decide: async () => goal,
      },
    });
    await runLoop(d);
    const events = d.ledger.read();
    const policy = events.find((e) => e.kind === "policy");
    expect(policy?.payload).toMatchObject({ toolName: "s.read", decision: "execute" });
    const calls = events.filter((e) => e.kind === "call").map((e) => (e.payload as { toolName: string }).toolName);
    // The real read, then the digest recorded as the runtime's own result.
    expect(calls.slice(0, 2)).toEqual(["read", "story_context"]);
    // The model saw the digest BEFORE it planned.
    expect(seenByModel[0]).toContain("CONTEXT v=");
  });

  it("refuses anything that is not a read the gate would execute", async () => {
    // Preflight can observe and never act. A skill that tried to write through
    // it — by mistake or otherwise — gets a refusal in the ledger, not a write.
    const t = tools();
    const d = deps([goal], {
      tools: t,
      skill: {
        ...skill(),
        preflight: async (readFn) => {
          const r = await readFn("s.write", {});
          expect(r.ok).toBe(false);
          return undefined;
        },
      },
    });
    await runLoop(d);
    expect(t.calls.map((c) => c.toolName)).not.toContain("s.write");
    const policy = d.ledger.read().find((e) => e.kind === "policy");
    expect(policy?.payload).toMatchObject({ toolName: "s.write", decision: "refuse" });
  });
});

describe("bug proposals wait for the end of the run", () => {
  const bugCall = {
    toolName: "ado.wit_work_item_write",
    args: { action: "create", workItemType: "Bug", parentId: 1, tags: "agentic-qa", title: "AC-1: broken" },
  };

  it("holds a mid-run proposal, asks nobody, and drops it when the suite ends green", async () => {
    const t = tools()
      .add(
        { server: "ado", name: "wit_work_item_write", description: "", inputSchema: {}, policyClass: "write_record" },
        { ok: true, result: { id: 99 }, artefacts: [] },
      )
      .add(
        { server: "pw", name: "run_tests", description: "", inputSchema: {}, policyClass: "write_workspace" },
        { ok: true, result: { passed: 1, failed: 0, skipped: 0, green: true, tests: [{ title: "AC-1 x", status: "passed" }] }, artefacts: [] },
      );
    const approver = new ScriptedApprover([], { decision: "approved", by: "t", at: "" });
    const d = deps(
      [
        { calls: [{ toolName: bugCall.toolName, args: bugCall.args }], usage: u },
        { calls: [{ toolName: "pw.run_tests", args: {} }], usage: u },
        goal,
      ],
      {
        tools: t,
        approver,
        skill: { ...skill(), allowedTools: ["s.read", "ado.wit_work_item_write", "pw.run_tests"], workItem: "1" },
      },
    );
    await runLoop(d);
    // Nobody was asked, and nothing was filed.
    expect(approver.asked).toHaveLength(0);
    expect(t.calls.map((c) => c.toolName)).not.toContain("ado.wit_work_item_write");
  });

  it("asks ONCE at the end, beside the final result, when the test is still failing", async () => {
    const t = tools()
      .add(
        { server: "ado", name: "wit_work_item_write", description: "", inputSchema: {}, policyClass: "write_record" },
        { ok: true, result: { id: 99 }, artefacts: [] },
      )
      .add(
        { server: "pw", name: "run_tests", description: "", inputSchema: {}, policyClass: "write_workspace" },
        { ok: true, result: { passed: 0, failed: 1, skipped: 0, green: false, tests: [{ title: "AC-1 signs in", status: "failed" }] }, artefacts: [] },
      );
    const approver = new ScriptedApprover([], { decision: "approved", by: "t", at: "" });
    const d = deps(
      [
        { calls: [{ toolName: "pw.run_tests", args: {} }], usage: u },
        { calls: [{ toolName: bugCall.toolName, args: bugCall.args }], usage: u },
        goal,
      ],
      {
        tools: t,
        approver,
        skill: { ...skill(), allowedTools: ["s.read", "ado.wit_work_item_write", "pw.run_tests"], workItem: "1" },
      },
    );
    await runLoop(d);
    expect(approver.asked).toHaveLength(1);
    expect(approver.asked[0]?.note).toContain("Execution has FINISHED");
    expect(approver.asked[0]?.note).toContain("AC-1 signs in");
    expect(t.calls.map((c) => c.toolName)).toContain("ado.wit_work_item_write");
  });
});

describe("pinned arguments: the runtime, not the model, chooses the project", () => {
  it("overrides whatever project the model proposed, before the gate and the ledger", async () => {
    // Run 20260921T142549Z: four bug creations carried projects the model
    // invented — "AQA Sandbox", "JuiceShopTest". They failed only because no
    // such projects existed. The approval prompt never showed the project.
    const t = new StubTools().add(
      {
        server: "ado",
        name: "wit_work_item",
        description: "",
        inputSchema: {},
        policyClass: "read",
        pinnedArgs: { project: "agentic-qa-sandbox" },
      },
      { ok: true, result: {}, artefacts: [] },
    );
    const d = deps(
      [{ calls: [{ toolName: "ado.wit_work_item", args: { project: "JuiceShopTest", id: 1 } }], usage: u }, goal],
      { tools: t, skill: { ...skill(), allowedTools: ["ado.wit_work_item"] } },
    );
    await runLoop(d);
    expect(t.calls[0]?.args["project"]).toBe("agentic-qa-sandbox");
    const recorded = d.ledger.read().find((e) => e.kind === "call")?.payload as { args: Record<string, unknown> };
    expect(recorded.args["project"]).toBe("agentic-qa-sandbox");
  });

  it("still lets the model's arguments override a mere default", () => {
    const tool = {
      server: "s",
      name: "x",
      description: "",
      inputSchema: {},
      policyClass: "read" as const,
      defaultArgs: { top: 10 },
      pinnedArgs: { project: "p" },
    };
    expect(withRuntimeArgs({ toolName: "s.x", args: { top: 50, project: "q" } }, tool).args).toEqual({
      top: 50,
      project: "p",
    });
  });
});

describe("the runtime's own end-of-run writes", () => {
  it("posts the skill's final report once, after everything else, through one approval", async () => {
    const t = tools().add(
      { server: "ado", name: "wit_work_item_comment_write", description: "", inputSchema: {}, policyClass: "write_record" },
      { ok: true, result: { id: 1 }, artefacts: [] },
    );
    const approver = new ScriptedApprover([], { decision: "approved", by: "t", at: "" });
    const d = deps([{ calls: [], usage: u, note: "Covered AC-1 to AC-4." }], {
      tools: t,
      approver,
      skill: {
        ...skill(),
        allowedTools: ["s.read", "ado.wit_work_item_comment_write"],
        finalReport: (_events, ctx) => ({
          toolName: "ado.wit_work_item_comment_write",
          args: { action: "add", workItemId: 1, text: `report ${ctx.runId} / ${ctx.agentNote ?? ""}` },
        }),
      },
    });
    await runLoop(d);
    expect(approver.asked).toHaveLength(1);
    expect(approver.asked[0]?.note).toContain("The run is over");
    const posted = t.calls.find((c) => c.toolName === "ado.wit_work_item_comment_write");
    expect(String(posted?.args["text"])).toContain("Covered AC-1 to AC-4.");
    // It is the LAST thing before the end event.
    const kinds = d.ledger.read().map((e) => e.kind);
    expect(kinds.slice(-3)).toEqual(["call", "observation", "end"]);
  });

  it("posts nothing when the skill has nothing to report", async () => {
    const approver = new ScriptedApprover([], { decision: "approved", by: "t", at: "" });
    const d = deps([goal], { approver, skill: { ...skill(), finalReport: () => undefined } });
    await runLoop(d);
    expect(approver.asked).toHaveLength(0);
  });
});

describe("preflight: reads of items linked to the story", () => {
  it("allows a linked read the scope would refuse — and only a linked one", async () => {
    // Test cases get new ids every run; listing each in agent.scope.work_items
    // by hand does not scale. A read the RUNTIME makes of an item reached
    // through the in-scope story's own links is allowed. The model's own reads
    // still obey the scope exactly as written.
    const t = new StubTools().add(
      { server: "ado", name: "wit_work_item", description: "", inputSchema: {}, policyClass: "read", scopeArgs: { workItem: "id" } },
      { ok: true, result: { id: 42 }, artefacts: [] },
    );
    const results: boolean[] = [];
    const d = deps([goal], {
      tools: t,
      config: { ...config(), scope: { ...config().scope, work_items: ["1"] } },
      gate: new ScopedGate(DEFAULT_POLICY, { ...config().scope, work_items: ["1"] }),
      skill: {
        ...skill(),
        allowedTools: ["ado.wit_work_item"],
        preflight: async (read) => {
          results.push((await read("ado.wit_work_item", { id: 42 }, { linkedToStory: true })).ok);
          results.push((await read("ado.wit_work_item", { id: 43 })).ok);
          return undefined;
        },
      },
    });
    await runLoop(d);
    expect(results).toEqual([true, false]);
    const reasons = d.ledger
      .read()
      .filter((e) => e.kind === "policy")
      .map((e) => String((e.payload as { reason: string }).reason));
    expect(reasons[0]).toContain("reached from the in-scope story");
  });
});
