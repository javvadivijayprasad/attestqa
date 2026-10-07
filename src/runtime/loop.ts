import { Ledger, sha256 } from "../ledger/ledger.js";
import { renderMarkdown } from "../ledger/replay.js";
import type { Gate, GateVerdict } from "../governance/policy.js";
import type { AgentConfig, PreflightRead, RunStatus, Skill, VerifyPayload } from "../types.js";
import { triageAction } from "../triage/step.js";
import { bugTitle, settleBugs } from "../triage/settle.js";
import { EXIT_CODES } from "../types.js";
import type { Approver } from "./approval.js";
import { summarizeCalls } from "./approval.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { ContextBuilder } from "./context.js";
import { OrderedContextBuilder, compactResult, SOURCE_CHARS, STEP_CHARS } from "./context.js";
import { authorizationFailure, deniedOperationReason, operationKey } from "./denials.js";
import { roleFor } from "../agents/roles.js";
import type { HistoryItem, ModelClient, ProposedCall } from "./model.js";
import type { ToolClient, ToolDescriptor } from "./tools.js";
import { splitQualified } from "./tools.js";

/**
 * How many times a reviewer may send the test design back before the run
 * stops. Two revisions is generous for a wording objection and short of the
 * loop where a reviewer and a model argue through the terminal.
 */
const MAX_DESIGN_DENIALS = 2;

export interface LoopDeps {
  /** The natural-language request from the engineer. */
  requestText: string;
  model: ModelClient;
  tools: ToolClient;
  gate: Gate;
  approver: Approver;
  skill: Skill;
  ledger: Ledger;
  config: AgentConfig;
  workspaceDir: string;
  clock?: Clock;
  context?: ContextBuilder;
  /** Deterministic approval ids for fixtures/tests; default is apr-0001, apr-0002, … */
  approvalIdFor?: (n: number) => string;
}

/** Cycles of pure repetition tolerated before the run is ended as blocked. */
export const MAX_STALE_CYCLES = 3;

/** Key-order-independent signature of a call's arguments. */
function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
  );
}

export interface LoopResult {
  status: RunStatus;
  exitCode: number;
  summary: string;
  runId: string;
  events: number;
}

/**
 * The plan → act → observe → verify cycle (design §4). Owns the stop rules and
 * the ledger; owns no QA knowledge. The model decides the next action only;
 * the gate decides whether it may happen; the verifier decides "done".
 */
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const clock = deps.clock ?? systemClock;
  const ctx =
    deps.context ??
    new OrderedContextBuilder(
      deps.skill.sourceTools ? { sourceTools: deps.skill.sourceTools } : {},
    );
  const { ledger, model, tools, gate, approver, skill, config } = deps;
  const approvalIdFor = deps.approvalIdFor ?? ((n) => `apr-${String(n).padStart(4, "0")}`);

  const history: HistoryItem[] = [];
  let steps = 0;
  let tokens = 0;
  let approvals = 0;
  let gaps: string[] | undefined;
  let retriedAfterGaps = false;
  /**
   * Signatures of calls already executed, and how many cycles have produced
   * nothing new. A model that cannot make progress tends to repeat itself
   * rather than stop, and without this the run simply burns its budget doing
   * the same read over and over (observed: the same two files read 29 times).
   */
  const executed = new Set<string>();
  let staleCycles = 0;
  /**
   * Operations the environment has refused on authorization grounds, and the
   * sentence it refused them with. These are closed for the rest of the run:
   * the gate would allow them, the reviewer might approve them, and they would
   * fail again identically (see `denials.ts`).
   */
  const deniedOps = new Map<string, string>();
  /** How many times the reviewer has sent the test design back this run. */
  let designDenials = 0;
  /** The model's own words, cycle by cycle — fed back so it can follow a plan. */
  const notes: string[] = [];
  /**
   * The latest contagious triage verdict: "infrastructure", "environmental", or
   * null. While it is set, NOTHING in the run measured the application, so no
   * failure in it can support a claim about the product.
   */
  let runLevel: string | null = null;
  /**
   * Bugs the agent proposed during the run, held until execution finishes.
   * Put to a human once, at the end, and only if their test is still failing
   * — see `settleBugs` for the run that made this necessary.
   */
  const deferredBugs: ProposedCall[] = [];
  let byName = new Map<string, ToolDescriptor>();

  /** Settle held bug proposals against the FINAL result, then ask once. */
  async function settleDeferredBugs(): Promise<void> {
    if (deferredBugs.length === 0) return;
    const pending = deferredBugs.splice(0);
    const s = settleBugs(pending, ledger.read(), {
      ...(skill.workItem !== undefined ? { workItem: skill.workItem } : {}),
      runLevel,
      workspaceDir: deps.workspaceDir,
    });
    for (const d of s.drop) {
      ledger.append(
        "policy",
        {
          toolName: d.call.toolName,
          class: "write_record",
          decision: "refuse",
          reason: `dropped at end of run — "${bugTitle(d.call)}": ${d.reason}`,
        },
        clock.now(),
      );
    }
    if (s.keep.length === 0) return;

    await askThenExecute(
      s.keep,
      "Execution has FINISHED. These bugs are for tests that are still failing in the final run" +
        (s.stillFailing.length > 0 ? `:\n  - ${s.stillFailing.join("\n  - ")}` : "."),
    );
  }

  /**
   * A call the RUNTIME makes on its own account, mid-run — today, the suite.
   *
   * Judged by the gate, put to a reviewer when the policy says `ask`, written
   * to the ledger as an ordinary call, and pushed into the model's history so
   * its next turn reads the result as a fact rather than as something it must
   * remember to ask for. The only difference from a model-proposed call is who
   * decided to make it.
   */
  async function runtimeCall(
    toolName: string,
    args: Record<string, unknown>,
    why?: string,
  ): Promise<boolean> {
    const tool = byName.get(toolName);
    const call = withRuntimeArgs({ toolName, args }, tool);
    const verdict = gate.judge(call, tool);
    const approvalId = verdict.decision === "ask" ? approvalIdFor(++approvals) : undefined;
    ledger.append(
      "policy",
      {
        toolName: call.toolName,
        class: verdict.class,
        decision: verdict.decision,
        reason: verdict.reason,
        ...(approvalId ? { approvalId } : {}),
      },
      clock.now(),
    );
    if (verdict.decision === "refuse") {
      history.push({
        toolName: call.toolName,
        ok: false,
        summary: `the runtime tried to run this and the gate refused it: ${verdict.reason}`,
        ledgerRef: `ledger://${ledger.runId}/policy`,
        gate: { decision: "refuse", reason: verdict.reason },
      });
      return false;
    }
    if (approvalId) {
      const summary = summarizeCalls([call]);
      ledger.append("approval_requested", { approvalId, summary, calls: [call] }, clock.now());
      const result = await approver.ask({ approvalId, summary, calls: [call] });
      ledger.append(
        "approval_resolved",
        {
          approvalId,
          decision: result.decision,
          by: result.by,
          at: result.at,
          ...(result.reason ? { reason: result.reason } : {}),
        },
        clock.now(),
      );
      if (result.decision !== "approved") {
        history.push({
          toolName: call.toolName,
          ok: false,
          summary: `the reviewer declined the run${result.reason ? `: ${result.reason}` : ""}`,
          ledgerRef: `ledger://${ledger.runId}/approval/${approvalId}`,
          gate: { decision: "denied", reason: result.reason ?? "approval denied" },
        });
        return false;
      }
    }
    const target = splitQualified(call.toolName);
    if (!target) return false;
    const startedAt = clock.now();
    const callEvent = ledger.append(
      "call",
      {
        server: target.server,
        toolName: target.name,
        args: call.args,
        startedAt,
        origin: "runtime",
        ...(why ? { why } : {}),
      },
      startedAt,
    );
    let ok = false;
    let result: unknown;
    let artefacts: string[] = [];
    try {
      const r = await tools.call(target.server, target.name, call.args);
      ok = r.ok;
      result = r.result;
      artefacts = r.artefacts;
    } catch (e) {
      result = { message: (e as Error).message };
    }
    const endedAt = clock.now();
    const obs = ledger.append(
      "observation",
      { eventIdOfCall: callEvent.eventId, ok, result, artefacts, durationMs: endedAt - startedAt },
      endedAt,
    );
    history.push({
      toolName: call.toolName,
      ok,
      summary: compactResult(result, STEP_CHARS),
      ledgerRef: `ledger://${ledger.runId}/${obs.eventId}`,
    });
    return ok;
  }

  /** Triage whatever the last run produced, and note what it asks for. */
  async function triageNow(): Promise<void> {
    if (!skill.verifier.triage) return;
    const triaged = await skill.verifier.triage({
      events: ledger.read(),
      workspaceDir: deps.workspaceDir,
    });
    if (!triaged) return;
    ledger.append("triage", triaged, clock.now());
    runLevel = triaged.runLevel;
    const action = triageAction(triaged);
    if (action.notes.length > 0) gaps = [...(gaps ?? []), ...action.notes];
  }

  /**
   * Put calls to the reviewer once, and execute them if approved. Used only at
   * the END of a run — for held bugs and for the run report — where there is no
   * model turn left to feed a refusal back to.
   */
  async function askThenExecute(proposed: ProposedCall[], note: string): Promise<void> {
    const calls = proposed.map((c) => withRuntimeArgs(c, byName.get(c.toolName)));
    const approvalId = approvalIdFor(++approvals);
    const verdicts = calls.map((call) => ({ call, v: gate.judge(call, byName.get(call.toolName)) }));
    for (const { call, v } of verdicts) {
      ledger.append(
        "policy",
        {
          toolName: call.toolName,
          class: v.class,
          decision: v.decision === "refuse" ? "refuse" : "ask",
          reason: v.reason,
          ...(v.decision === "refuse" ? {} : { approvalId }),
        },
        clock.now(),
      );
    }
    const askable = verdicts.filter((x) => x.v.decision !== "refuse").map((x) => x.call);
    if (askable.length === 0) return;
    const summary = summarizeCalls(askable);
    ledger.append("approval_requested", { approvalId, summary, calls: askable }, clock.now());
    const result = await approver.ask({ approvalId, summary, calls: askable, note });
    ledger.append(
      "approval_resolved",
      {
        approvalId,
        decision: result.decision,
        by: result.by,
        at: result.at,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      clock.now(),
    );
    if (result.decision !== "approved") return;

    for (const call of askable) {
      const target = splitQualified(call.toolName);
      if (!target) continue;
      const startedAt = clock.now();
      const callEvent = ledger.append(
        "call",
        { server: target.server, toolName: target.name, args: call.args, startedAt },
        startedAt,
      );
      let ok = false;
      let r: unknown;
      let artefacts: string[] = [];
      try {
        const out = await tools.call(target.server, target.name, call.args);
        ok = out.ok;
        r = out.result;
        artefacts = out.artefacts;
      } catch (e) {
        r = { message: (e as Error).message };
      }
      const endedAt = clock.now();
      ledger.append(
        "observation",
        { eventIdOfCall: callEvent.eventId, ok, result: r, artefacts, durationMs: endedAt - startedAt },
        endedAt,
      );
    }
  }

  /** The run report, posted by the runtime once everything else is over. */
  async function postFinalReport(): Promise<void> {
    if (!skill.finalReport) return;
    const agentNote = notes[notes.length - 1];
    const call = skill.finalReport(ledger.read(), {
      runId: ledger.runId,
      ...(agentNote ? { agentNote } : {}),
    });
    if (!call) return;
    await askThenExecute(
      [call],
      "The run is over. This is its report, composed from the ledger, for the story's discussion.",
    );
  }

  const finish = async (status: RunStatus, summary: string): Promise<LoopResult> => {
    // Execution is over, whatever the reason: now, and only now, is there a
    // final result to judge a proposed bug against.
    if (status !== "error") {
      try {
        await settleDeferredBugs();
      } catch {
        /* a failure here must not lose the end-of-run record */
      }
      // Last of all, so the report can say how the bug decision went.
      try {
        await postFinalReport();
      } catch {
        /* likewise */
      }
    }
    ledger.append("end", { status, summary, exitCode: EXIT_CODES[status] }, clock.now());
    ledger.writeSummary(renderMarkdown(ledger.read()));
    return {
      status,
      exitCode: EXIT_CODES[status],
      summary,
      runId: ledger.runId,
      events: ledger.read().length,
    };
  };

  try {
    // ---- request -----------------------------------------------------------
    const text = deps.requestText;
    ledger.append(
      "request",
      { text, skill: skill.name, configHash: `sha256:${sha256(JSON.stringify(config))}` },
      clock.now(),
    );

    // Tools visible to this skill only.
    const all = await tools.listTools();
    const allowed = new Set(skill.allowedTools);
    const visible: ToolDescriptor[] = all.filter((t) => allowed.has(`${t.server}.${t.name}`));
    byName = new Map<string, ToolDescriptor>(visible.map((t) => [`${t.server}.${t.name}`, t]));
    // Primary sources are what the job is ABOUT — the story, a file, a parsed
    // feature — so they get a much larger window than a step result.
    const sourceTools = new Set(skill.sourceTools ?? []);

    // ---- preflight ---------------------------------------------------------
    // Context the RUNTIME gathers, before the model's first turn.
    //
    // A skill can name reads that must happen on every run; asking the model to
    // make them proved unreliable (it read the story and the comments, took the
    // open bugs' ids without reading one, and skipped the epic and the tasks).
    // Each read below is judged by the gate and written to the ledger exactly
    // like a model-proposed call; only a `read`-class tool that the gate would
    // execute is allowed, so preflight can observe and never act.
    if (skill.preflight) {
      const read: PreflightRead = async (toolName, requested, readOpts) => {
        let args = requested;
        const tool = byName.get(toolName);
        const call = withRuntimeArgs({ toolName, args }, tool);
        args = call.args;
        const judged = gate.judge(call, tool);
        // A read of an item reached through the story's OWN links — its epic,
        // the epic's other stories, its tasks, its test cases — is allowed even
        // when the item is outside agent.scope.work_items. Bounded three ways:
        // it is a read, it is made by the runtime and not the model, and the
        // item was reached from the in-scope story rather than named freely.
        // Listing every test case id in the config by hand does not scale; they
        // get new ids every run. The model's own calls still obey the scope
        // exactly as written.
        const linkedOverride =
          readOpts?.linkedToStory === true &&
          judged.class === "read" &&
          judged.decision === "refuse" &&
          /not in the allowed work_items/i.test(judged.reason);
        const verdict = linkedOverride
          ? {
              ...judged,
              decision: "execute" as const,
              reason:
                `reached from the in-scope story — its epic, its tasks, its test cases, or the ` +
                `project's own open-bug query (${judged.reason}; runtime reads of linked items are allowed)`,
            }
          : judged;
        const allowed = verdict.decision === "execute" && verdict.class === "read";
        ledger.append(
          "policy",
          {
            toolName,
            class: verdict.class,
            decision: allowed ? "execute" : "refuse",
            reason: allowed
              ? `preflight: ${verdict.reason}`
              : `preflight may only make reads the gate would execute (${verdict.class}/${verdict.decision}): ${verdict.reason}`,
          },
          clock.now(),
        );
        if (!allowed) return { ok: false, result: { message: verdict.reason } };
        const target = splitQualified(toolName);
        if (!target) return { ok: false, result: { message: `not a qualified tool: ${toolName}` } };
        const startedAt = clock.now();
        const callEvent = ledger.append(
          "call",
          { server: target.server, toolName: target.name, args, startedAt },
          startedAt,
        );
        let ok = false;
        let result: unknown;
        try {
          const r = await tools.call(target.server, target.name, args);
          ok = r.ok;
          result = r.result;
        } catch (e) {
          result = { message: (e as Error).message };
        }
        const endedAt = clock.now();
        ledger.append(
          "observation",
          { eventIdOfCall: callEvent.eventId, ok, result, artefacts: [], durationMs: endedAt - startedAt },
          endedAt,
        );
        // The model re-proposing a read the runtime already made is repetition,
        // not progress, and the stale-cycle detector should see it that way.
        executed.add(`${toolName} ${stableArgs(args)}`);
        return { ok, result };
      };

      const digest = await skill.preflight(read);
      if (digest) {
        const at = clock.now();
        const callEvent = ledger.append(
          "call",
          { server: "aqa", toolName: digest.toolName.replace(/^aqa\./, ""), args: {}, startedAt: at },
          at,
        );
        const obs = ledger.append(
          "observation",
          {
            eventIdOfCall: callEvent.eventId,
            ok: true,
            result: {
              kind: "preflight",
              summary: digest.summary,
              text: digest.text,
              ...(digest.facts !== undefined ? { facts: digest.facts } : {}),
            },
            artefacts: [],
            durationMs: 0,
          },
          at,
        );
        sourceTools.add(digest.toolName);
        history.push({
          toolName: digest.toolName,
          ok: true,
          summary: digest.text,
          ledgerRef: `ledger://${ledger.runId}/${obs.eventId}`,
        });
      }
    }

    // ---- route -------------------------------------------------------------
    // The path, chosen by code from what preflight just observed. Recorded
    // before the model has had a turn, so what the run did with the project it
    // found is a fact and not an inference about a prompt.
    let visibleAfterRoute = visible;
    /**
     * The role the previous turn was in, so a change is written down once.
     * Starts as nothing, not as "default": every run records the role its first
     * turn belongs to, so a reader never has to infer which agent acted from
     * the absence of an event.
     */
    let currentRole = "";
    if (skill.route) {
      const decision = skill.route(ledger.read());
      ledger.append(
        "route",
        {
          path: decision.path,
          reason: decision.reason,
          because: decision.because,
          denied: decision.deny,
        },
        clock.now(),
      );
      if (decision.stop) return finish("blocked", decision.stop);
      if (decision.deny.length > 0) {
        const denied = new Set(decision.deny);
        visibleAfterRoute = visible.filter((t) => !denied.has(`${t.server}.${t.name}`));
        byName = new Map(visibleAfterRoute.map((t) => [`${t.server}.${t.name}`, t]));
      }
    }

    // ---- plan --------------------------------------------------------------
    const planInput = ctx.build({
      request: text,
      skillInstructions: skill.instructions,
      tools: visibleAfterRoute,
      history,
    }).input;
    const plan = await model.plan(planInput);
    tokens += plan.usage.inputTokens + plan.usage.outputTokens;
    ledger.append("plan", { steps: plan.steps }, clock.now());

    // ---- cycles ------------------------------------------------------------
    for (;;) {
      if (steps >= config.budgets.steps)
        return finish(
          "budget",
          `step budget of ${config.budgets.steps} exhausted after ${steps} steps`,
        );
      if (tokens >= config.budgets.tokens)
        return finish(
          "budget",
          `token budget of ${config.budgets.tokens} exhausted (${tokens} used)`,
        );
      steps++;

      // ---- the runtime's own call ------------------------------------------
      // Running the suite is not a decision, so it is not a turn. The skill
      // says WHEN (a design is approved, a spec exists, something changed since
      // the last run); the gate, the approval and the ledger are the same as
      // for any model-proposed call.
      const auto = skill.autoRun?.(ledger.read());
      if (auto) {
        await runtimeCall(auto.toolName, auto.args, auto.why);
        // Triage after it, exactly as after a model-proposed run: the verdicts
        // are what the next turn reads.
        await triageNow();
      }

      // ---- role -----------------------------------------------------------
      // Which agent this turn belongs to, decided from the ledger. A role
      // narrows the tools AND the instructions: the healer is shown five tools
      // and twenty lines, not the whole skill, so the instructions for
      // authoring cannot be read as permission while repairing.
      const role = roleFor(ledger.read());
      if (role.name !== currentRole) {
        currentRole = role.name;
        ledger.append(
          "agent",
          {
            role: role.name,
            because: role.because || "the skill's own tools and instructions",
            tools: role.tools,
          },
          clock.now(),
        );
      }
      const roleTools =
        role.tools.length === 0
          ? visibleAfterRoute
          : visibleAfterRoute.filter((t) => role.tools.includes(`${t.server}.${t.name}`));
      byName = new Map(roleTools.map((t) => [`${t.server}.${t.name}`, t]));

      const built = ctx.build({
        request: text,
        skillInstructions: role.instructions
          ? `${skill.instructions}\n\n${role.instructions}`
          : skill.instructions,
        tools: roleTools,
        history,
        ...(gaps ? { gaps } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
      ledger.append("context", built.event, clock.now());

      const decision = await model.decide(built.input);
      tokens += decision.usage.inputTokens + decision.usage.outputTokens;
      if (decision.note) notes.push(decision.note);

      // Goal reached → verify.
      if (decision.calls.length === 0) {
        ledger.append(
          "inference",
          {
            model: model.model,
            promptVersion: model.promptVersion,
            toolName: null,
            args: null,
            usage: decision.usage,
            ...(decision.note ? { note: decision.note } : {}),
          },
          clock.now(),
        );
        // Triage first, and write it down before anything reads it. The
        // verifier then sees the verdicts in `events` like any other fact about
        // the run, rather than being handed them — which is what lets a later
        // attempt compare itself against an earlier one.
        if (skill.verifier.triage) {
          const triaged = await skill.verifier.triage({
            events: ledger.read(),
            workspaceDir: deps.workspaceDir,
          });
          if (triaged) {
            ledger.append("triage", triaged, clock.now());
            runLevel = triaged.runLevel;
          }
        }
        const verdict: VerifyPayload = await skill.verifier.verify({
          events: ledger.read(),
          workspaceDir: deps.workspaceDir,
        });
        ledger.append("verify", verdict, clock.now());
        if (verdict.done) return finish("done", decision.note ?? "goal verified");
        if (retriedAfterGaps)
          return finish(
            "blocked",
            `verifier gaps remain after retry: ${verdict.gaps.map((g) => g.code).join(", ")}`,
          );
        retriedAfterGaps = true;
        gaps = verdict.gaps.map((g) => `${g.code}: ${g.message}`);
        continue;
      }
      gaps = undefined;

      // One inference event per proposed call (parallel tool use), then gate each.
      // Server-configured defaults are merged FIRST, so the gate judges — and
      // the ledger records — the arguments that will actually be sent.
      const verdicts: Array<{ call: ProposedCall; verdict: GateVerdict }> = [];
      for (const proposed of decision.calls) {
        const tool = byName.get(proposed.toolName);
        const call = withRuntimeArgs(proposed, tool);
        ledger.append(
          "inference",
          {
            model: model.model,
            promptVersion: model.promptVersion,
            toolName: call.toolName,
            args: call.args,
            usage: decision.usage,
            // On the first call of the cycle only: the reasoning belongs to the
            // decision, not to each call it produced.
            ...(decision.note && verdicts.length === 0 ? { note: decision.note } : {}),
          },
          clock.now(),
        );
        // An operation the environment has already refused is refused here,
        // BEFORE the approval batch is assembled — so the reviewer is never
        // asked to approve a call that is known to be dead on arrival.
        const gateVerdict = gate.judge(call, tool);
        const quoted = deniedOps.get(operationKey(call.toolName, call.args));
        verdicts.push({
          call,
          verdict: quoted
            ? {
                ...gateVerdict,
                decision: "refuse",
                reason: deniedOperationReason(operationKey(call.toolName, call.args), quoted),
              }
            : gateVerdict,
        });
      }

      // Stop rule: a cycle whose calls were ALL made before has advanced
      // nothing. Feed that back once, then end the run rather than spending the
      // remaining budget on repetition.
      const signatures = verdicts.map((v) => `${v.call.toolName} ${stableArgs(v.call.args)}`);
      const allRepeats = signatures.length > 0 && signatures.every((sig) => executed.has(sig));
      if (allRepeats) {
        staleCycles++;
        if (staleCycles >= MAX_STALE_CYCLES) {
          return finish(
            "blocked",
            `no progress: the same call(s) were proposed ${staleCycles} cycles running (${signatures[0]}). Their results are already in the ledger.`,
          );
        }
        for (const { call } of verdicts) {
          history.push({
            toolName: call.toolName,
            ok: false,
            summary: "",
            ledgerRef: `e${ledger.read().length}`,
            gate: {
              decision: "refuse",
              reason:
                "you have already made this exact call and its result is in your context; repeating it cannot change anything — do something different or stop and explain what is blocking you",
            },
          });
        }
        continue;
      }
      staleCycles = 0;
      for (const sig of signatures) executed.add(sig);

      // A defect claim is never batched with anything else.
      //
      // Approvals are batched per cycle so a reviewer sees one request rather
      // than four (design §7). That is right for four test cases — same kind,
      // same question, one answer. It is wrong the moment a proposed BUG joins
      // them, because the reviewer is then being asked two questions with one
      // key: "may I record what these tests check" and "do you accept that the
      // product is broken". Those carry different stakes and routinely deserve
      // opposite answers.
      //
      // Observed in apr-0001 of run 20260918T231318Z: four sound test cases
      // batched with a bug that turned out to be a test defect. Approving would
      // have filed a false defect; denying threw away four good test cases. The
      // reviewer had no way to answer correctly, which means the gate was not
      // really asking.
      //
      // So a bug in a mixed cycle is refused HERE, with a reason that tells the
      // agent to propose it alone. It costs one cycle and keeps the loop's
      // one-approval-per-cycle shape intact.
      // Skill-specific refusals decided from what the run has already seen.
      if (skill.refuse) {
        const seen = ledger.read();
        for (const v of verdicts) {
          if (v.verdict.decision === "refuse") continue;
          const reason = skill.refuse(v.call, seen);
          if (reason) v.verdict = { ...v.verdict, decision: "refuse", reason };
        }
      }

      // Bugs wait for the end of the run.
      //
      // A proposal made mid-run is recorded and held; it is put to a human
      // after execution finishes, and only if its test is still failing then
      // (`settleDeferredBugs`). The agent is told so and carries on.
      for (const v of verdicts) {
        if (v.verdict.decision === "refuse" || !isBugCreation(v.call)) continue;
        const title = bugTitle(v.call);
        const already = deferredBugs.some((b) => bugTitle(b) === title);
        if (!already) deferredBugs.push(v.call);
        v.verdict = {
          ...v.verdict,
          decision: "refuse",
          reason: already
            ? `deferred: a bug titled "${title}" is already held for the end of the run — do not propose it again.`
            : `deferred until execution finishes: "${title}" is recorded and will be put to the reviewer ` +
              "at the end of the run, and only if its test is still failing in the final report. " +
              "Carry on with the rest of the suite.",
        };
      }

      // A run that measured nothing cannot claim a defect.
      //
      // When triage returns a contagious verdict — `infrastructure` or
      // `environmental` — the suite did not exercise the application at all, so
      // every failure in it is a statement about the harness. A bug filed from
      // that describes the test environment while pointing at the product, and
      // it lands in a backlog someone has to triage by hand.
      //
      // Observed in run 20260918T233715Z: all ten tests died before loading a
      // page because the Playwright browsers were not installed, and the agent
      // filed a Bug titled "Playwright browser binaries not installed in test
      // environment" whose own body reads "This is NOT an application defect...
      // The application itself was not tested and cannot be judged from this
      // failure." It filed a defect record that argues it is not a defect. The
      // instruction in step 8 did not stop it, so the capability is withdrawn
      // instead: the environment is fixed and the suite re-run, and only then
      // is there anything to have an opinion about.
      if (runLevel) {
        for (const v of verdicts) {
          if (v.verdict.decision === "refuse" || !isBugCreation(v.call)) continue;
          v.verdict = {
            ...v.verdict,
            decision: "refuse",
            reason:
              `triage classified this run "${runLevel}": the suite never exercised the ` +
              "application, so nothing in it is evidence about the product and no bug can be " +
              "raised from it. Report the environment problem and what it blocked in your " +
              "final summary — that reaches a human without putting a false defect in the " +
              "backlog.",
          };
        }
      }

      const mixedBug =
        verdicts.some((v) => v.verdict.decision === "ask" && isBugCreation(v.call)) &&
        verdicts.some((v) => v.verdict.decision === "ask" && !isBugCreation(v.call));
      if (mixedBug) {
        for (const v of verdicts) {
          if (v.verdict.decision !== "ask" || !isBugCreation(v.call)) continue;
          v.verdict = {
            ...v.verdict,
            decision: "refuse",
            reason:
              "a bug must be proposed on its own, not alongside other writes: batching them " +
              "asks the reviewer to answer two different questions with one key. The other " +
              "calls in this cycle are going ahead — propose the bug again by itself.",
          };
        }
      }

      // Batch every "ask" in this cycle into ONE approval (design §7).
      const asks = verdicts.filter((v) => v.verdict.decision === "ask");
      let approvalId: string | undefined;
      let approved = true;
      let denialReason = "";
      if (asks.length > 0) approvalId = approvalIdFor(++approvals);

      for (const { verdict } of verdicts) {
        const payload = {
          toolName: verdict.toolName,
          class: verdict.class,
          decision: verdict.decision,
          reason: verdict.reason,
        };
        ledger.append(
          "policy",
          verdict.decision === "ask" && approvalId ? { ...payload, approvalId } : payload,
          clock.now(),
        );
      }

      if (asks.length > 0 && approvalId) {
        const calls = asks.map((a) => a.call);
        const summary = summarizeCalls(calls);
        ledger.append("approval_requested", { approvalId, summary, calls }, clock.now());
        // What the reviewer needs to know about these calls before deciding —
        // for a test design, which items are already covered by tests on disk.
        const extra = skill.approvalNote?.(calls, ledger.read());
        const result = await approver.ask({
          approvalId,
          summary,
          calls,
          ...(extra ? { note: extra.note } : {}),
          ...(extra?.covered ? { covered: extra.covered } : {}),
        });
        ledger.append(
          "approval_resolved",
          {
            approvalId,
            decision: result.decision,
            by: result.by,
            at: result.at,
            ...(result.reason ? { reason: result.reason } : {}),
          },
          clock.now(),
        );
        approved = result.decision === "approved";
        denialReason = result.reason ?? "";
      }

      // Execute in order; refused/denied calls are fed back to the model as history.
      for (const { call, verdict } of verdicts) {
        if (verdict.decision === "refuse") {
          history.push({
            toolName: call.toolName,
            ok: false,
            summary: `refused by governance gate: ${verdict.reason}`,
            ledgerRef: `ledger://${ledger.runId}/policy`,
            gate: { decision: "refuse", reason: verdict.reason },
          });
          continue;
        }
        if (verdict.decision === "ask" && !approved) {
          history.push({
            toolName: call.toolName,
            ok: false,
            summary: denialReason
              ? `approval denied by reviewer: ${denialReason}`
              : "approval denied by reviewer",
            ledgerRef: `ledger://${ledger.runId}/approval/${approvalId}`,
            gate: {
              decision: "denied",
              reason: denialReason ? `approval denied — ${denialReason}` : "approval denied",
            },
          });
          continue;
        }
        const target = splitQualified(call.toolName)!; // gate refused unknown tools already
        const startedAt = clock.now();
        const callEvent = ledger.append(
          "call",
          { server: target.server, toolName: target.name, args: call.args, startedAt },
          startedAt,
        );
        let ok = false;
        let result: unknown;
        let artefacts: string[] = [];
        try {
          const r = await tools.call(target.server, target.name, call.args);
          ok = r.ok;
          result = r.result;
          artefacts = r.artefacts;
        } catch (e) {
          ok = false;
          result = { message: (e as Error).message };
        }
        const endedAt = clock.now();
        const obs = ledger.append(
          "observation",
          {
            eventIdOfCall: callEvent.eventId,
            ok,
            result,
            artefacts,
            durationMs: endedAt - startedAt,
          },
          endedAt,
        );
        // A failure the environment will repeat for any arguments closes the
        // operation for the rest of the run, and the model is told so in the
        // same breath as the failure — otherwise it does the reasonable thing
        // and tries again with different arguments (observed: four times).
        const refusedForever = ok ? undefined : authorizationFailure(result);
        const opKey = operationKey(call.toolName, call.args);
        if (refusedForever) deniedOps.set(opKey, refusedForever);
        history.push({
          toolName: call.toolName,
          ok,
          summary: refusedForever
            ? deniedOperationReason(opKey, refusedForever)
            : compactResult(result, sourceTools.has(call.toolName) ? SOURCE_CHARS : STEP_CHARS),
          ledgerRef: `ledger://${ledger.runId}/${obs.eventId}`,
        });

        // A call that CHANGED something invalidates the repeat memo: running
        // the same suite again after editing a spec is the same call with a
        // different meaning, and refusing it strands the agent — observed, with
        // the model rewriting the file thirteen times trying to get a re-run
        // past the rule.
        const changedTheWorld =
          artefacts.length > 0 || (byName.get(call.toolName)?.policyClass ?? "read") !== "read";
        if (ok && changedTheWorld) executed.clear();
      }

      // If a denied approval blocked every call this cycle and nothing else can happen, stop.
      //
      // With ONE exception: the test design exists to be reviewed, and a
      // reviewer saying "not like that" is the mechanism working, not the run
      // failing. Denying a design ended the run outright (20260925T194528Z) —
      // the reviewer rejected one hedged expectation and lost the whole run,
      // which teaches a reviewer to approve rather than to read. A denied design
      // goes back to the model with the reason, twice; a third denial stops the
      // run, because by then the disagreement is not something another draft
      // settles.
      if (asks.length > 0 && !approved && asks.length === verdicts.length) {
        const allDesign = asks.every((a) => a.call.toolName === "aqa.test_design");
        if (allDesign && designDenials < MAX_DESIGN_DENIALS) {
          designDenials++;
          notes.push(
            `The reviewer DENIED the test design${
              denialReason ? `: ${denialReason}` : ""
            }. Revise it and submit again — change what was objected to, keep the rest.`,
          );
        } else {
          return finish(
            "blocked",
            allDesign
              ? `the test design was denied ${designDenials + 1} times${
                  denialReason ? ` (last reason: ${denialReason})` : ""
                } — a person and the runtime disagree about what these tests should check, and that is not something another draft settles`
              : `approval ${approvalId} denied by reviewer`,
          );
        }
      }

      // ---- triage ----------------------------------------------------------
      // After every cycle, not only when the model says it is finished.
      //
      // The first version of this ran inside the verifier, which the loop only
      // reaches once the model declares the goal reached. On a run where the
      // model keeps repairing, that moment never comes: run
      // 20260918T154354Z-1f5d7538 spent 33 inferences, four suite runs and
      // fifteen rewrites of one spec without producing a single triage event.
      // A stop rule that can only speak after the loop has ended is not a stop
      // rule, so it speaks here instead.
      //
      // It is cheap — a file hash, and a no-op when the report has not changed
      // since the last verdict — so the loop does not need to know which tool
      // produces a report or when.
      // Triage never ends the run. It asks for a re-run the first time, and
      // after that tells the agent what is off limits and what to propose.
      // Whether a persistent failure is a defect is a person's call, put to
      // them as an approval — not a rule decided here.
      await triageNow();
    }
  } catch (e) {
    return finish("error", (e as Error).message);
  }
}

/**
 * A proposal to CREATE a Bug — the one call that must never share an approval.
 *
 * Matched on the action and the work item type rather than the tool name alone:
 * `ado.wit_work_item_write` is also how a run would create anything else, and
 * the manifest already confines it to "create" + "Bug". This is the loop
 * recognising the same shape so it can keep the question separate.
 */
function isBugCreation(call: ProposedCall): boolean {
  if (call.toolName !== "ado.wit_work_item_write") return false;
  const a = call.args;
  return a["action"] === "create" && a["workItemType"] === "Bug";
}

/**
 * The arguments that will actually be sent: runtime defaults, then the model's
 * arguments, then the runtime's PINNED arguments — which win.
 *
 * Done before the gate sees the call, so the policy decision, the approval
 * prompt and the ledger all describe what is sent rather than what was asked.
 */
export function withRuntimeArgs(proposed: ProposedCall, tool: ToolDescriptor | undefined): ProposedCall {
  if (!tool?.defaultArgs && !tool?.pinnedArgs) return proposed;
  return {
    toolName: proposed.toolName,
    args: { ...(tool.defaultArgs ?? {}), ...proposed.args, ...(tool.pinnedArgs ?? {}) },
  };
}
