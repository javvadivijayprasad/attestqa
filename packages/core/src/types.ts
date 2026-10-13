/**
 * Core types for @vijaypjavvadi/agentic-qa.
 *
 * Everything the platform tails or the paper cites is defined here. Changing any
 * exported shape in this file is a MAJOR version bump (see PLAN §0.6).
 */

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Discriminator for every ledger line. Order here is documentation only. */
export const EVENT_KINDS = [
  "request",
  "plan",
  "context",
  "inference",
  "policy",
  "approval_requested",
  "approval_resolved",
  "call",
  "observation",
  "triage",
  "verify",
  // Which path the run took, and the state that decided it. Written by the
  // runtime before the model's first turn, so a replay routes identically.
  "route",
  // Which ROLE the run is in — heal, or the skill's default — and why. Written
  // by the runtime when the role changes, so a replay says which agent acted.
  "agent",
  "end",
  // Ledger 2.0 (attestqa 2.0.0). A person's decision about what the software
  // SHOULD do, recorded so later runs can cite it and no run can claim it.
  "ruling",
  // A change a person made through the UI, so the agent can never present a
  // human's wording as its own.
  "user_edit",
  // Written by the host when a run's process exits without an `end` event, so
  // a crashed run still has a readable, closed ledger.
  "run_aborted",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Governance classes. Each proposed tool call is assigned exactly one. */
export const POLICY_CLASSES = [
  "read",
  "write_workspace",
  "write_branch",
  "write_record",
  "destructive",
] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];

export type PolicyDecision = "execute" | "ask" | "refuse";
export type ApprovalDecision = "approved" | "denied";
export type RunStatus = "done" | "blocked" | "refused" | "budget" | "error";

/** Exit codes per PLAN §0.1. */
export const EXIT_CODES: Record<RunStatus, number> = {
  done: 0,
  error: 1,
  blocked: 2,
  refused: 3,
  budget: 4,
};

export interface RequestPayload {
  text: string;
  skill: string;
  configHash: string;
}

export interface PlanPayload {
  steps: string[];
}

/** Hashes and counts only — never content (SECRETS-CHECKLIST). */
export interface ContextPayload {
  /** `dropped` counts history items trimmed from that section by a token cap (A6, additive). */
  sections: Array<{ name: string; sha256: string; tokens: number; dropped?: number }>;
  totalTokens: number;
  /** Total history items trimmed this cycle, when any (A6, additive). */
  droppedItems?: number;
}

export interface InferencePayload {
  model: string;
  /**
   * Which provider served this inference (additive and optional). Absent on
   * every ledger written before the provider seam existed; those were all
   * Anthropic. Recorded so a corpus run on a second model is distinguishable
   * from the first without reading the model name.
   */
  provider?: string;
  promptVersion: string;
  /** `null` when the model declared the goal reached instead of choosing a tool. */
  toolName: string | null;
  args: Record<string, unknown> | null;
  /**
   * The model's own words when it declared the goal reached (A7, additive and
   * optional). Recorded so the ledger shows the CLAIM next to the verifier's
   * verdict — the two disagreeing is the most informative thing in a failed run.
   */
  note?: string;
  /**
   * `cacheReadTokens` / `cacheCreationTokens` are additive and optional (A10):
   * written only when the provider reports prompt-cache accounting, so older
   * ledgers and non-caching models produce exactly the shape they always did.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export interface PolicyPayload {
  toolName: string;
  class: PolicyClass;
  decision: PolicyDecision;
  reason: string;
  approvalId?: string;
}

export interface ApprovalRequestedPayload {
  approvalId: string;
  /** One human sentence, e.g. "Create 4 test cases in plan Sandbox Plan, linked to #1". */
  summary: string;
  calls: Array<{ toolName: string; args: Record<string, unknown> }>;
}

export interface ApprovalResolvedPayload {
  approvalId: string;
  decision: ApprovalDecision;
  by: string;
  at: string;
}

export interface CallPayload {
  server: string;
  toolName: string;
  args: Record<string, unknown>;
  startedAt: number;
  /**
   * Who decided to make this call. Absent means the model proposed it, which is
   * the ordinary case and keeps every existing ledger readable.
   *
   * `runtime` is a call the runtime made itself because the conditions for it
   * were met in code (`Skill.autoRun`) — running the suite once a design is
   * approved and something has changed. Without this field the two are
   * distinguishable only by the absence of a preceding `inference` event, which
   * is how 20260928T082428Z had to be read by hand. The cost half of the
   * argument for executing as code is a count, so the ledger should carry it.
   */
  origin?: "runtime";
  /** Why the runtime made it, in one line — recorded and shown on screen. */
  why?: string;
}

export interface ObservationPayload {
  eventIdOfCall: number;
  ok: boolean;
  /** Full tool result. Compaction happens in context assembly, never here. */
  result: unknown;
  artefacts: string[];
  durationMs: number;
}

export interface Gap {
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
}

/**
 * What kind of red this was.
 *
 * Its own event rather than a field on `verify`, for two reasons that are
 * mechanical rather than aesthetic. Triage runs more than once in a run — a
 * flake verdict means a retry, and the retry's results must be triaged again —
 * and there is only one verify event to hang it on. And the end-of-run
 * quarantine check reads back what an earlier triage recorded, which is exactly
 * what the ledger is for; folding it into `verify` would have the verifier
 * reading its own earlier output with no independent record in between.
 *
 * A run from before triage existed simply has no event of this kind, which is
 * the correct answer to "what did triage decide here" rather than a missing
 * field needing an edge case.
 */
export interface TriagePayload {
  /** 1 for the first triage of a run, 2 after a flake retry, and so on. */
  attempt: number;
  /**
   * Set when this triage read a report with NO failures after an earlier one
   * had some — the suite went green and every prior verdict is withdrawn.
   * Recorded explicitly rather than inferred from an empty verdict list, so a
   * reader of the ledger can see that the quarantine was released and why.
   */
  cleared?: boolean;
  /**
   * Set when the failures say the run itself was not measurable —
   * `"environmental"` or `"infrastructure"` — so no other verdict in this run
   * can be trusted. Null when every verdict is a statement about one test.
   */
  runLevel: string | null;
  verdicts: Array<{
    test: string;
    category: string;
    confidence: number;
    /** Pattern sources that matched, so two implementations can be compared. */
    matchedPatterns: string[];
    /** The words from the failure that decided it. */
    evidence: string;
    rationale: string;
    triagedBy: "builtin" | "service";
    serviceVersion?: string;
  }>;
  /**
   * Tests the agent may not modify: those triaged `real-defect`. Recorded here
   * because the end-of-run check compares against it, and a quarantine that
   * lives only in the agent's instructions is not a quarantine.
   */
  quarantined: string[];
  /**
   * Identifies the execution report this verdict was drawn from.
   *
   * Triage runs after every suite execution, not only at the end of a run, so
   * the same unchanged report would otherwise be classified again on every
   * cycle — inflating `attempt`, filling the ledger with duplicates, and making
   * the quarantine check compare a report against itself. Re-triaging a report
   * with the same fingerprint is a no-op.
   */
  reportFingerprint: string;
  /**
   * Where the built-in rules and the defect-analysis service reached different
   * verdicts on the same failure. Present only when both ran.
   *
   * Recorded rather than resolved. A disagreement is the training signal for
   * the service and the drift alarm for the port — the one thing two
   * implementations buy that one does not — and it is worth nothing if the
   * losing verdict is thrown away at the moment it disagrees.
   */
  disagreements?: Array<{ test: string; builtin: string; service: string }>;
  /**
   * Failures grouped by fingerprint, from the defect-analysis service. Present
   * only when the service answered.
   *
   * `existingBugKey` is the field that changes behaviour: it says a bug has
   * already been filed for this exact failure. Without it every run proposes
   * the same bug again, and a reviewer approving twice files the same defect
   * twice. `suppressedReason` says a human has already decided this one is not
   * worth filing — asking again is asking them to repeat themselves.
   */
  groups?: Array<{
    fingerprint: string;
    category: string;
    count: number;
    firstTestId: string;
    sampleTestIds: string[];
    state?: string;
    existingBugKey?: string;
    existingBugUrl?: string;
    suppressedReason?: string;
    proposedSummary?: string;
    proposedDescription?: string;
  }>;
}

export interface VerifyPayload {
  done: boolean;
  gaps: Gap[];
  /**
   * Checks the verifier did NOT make, and why (A8b, additive and optional). A
   * run can be done without being complete — an account without the Test Plans
   * access level cannot put cases in a suite — and the difference belongs in
   * the ledger rather than in a footnote, so that a reader of the evidence can
   * see what was verified and what was merely not required.
   */
  limitations?: string[];
}

export interface EndPayload {
  status: RunStatus;
  summary: string;
  exitCode: number;
}

/** Why this run took the path it took (S2). */
export interface RoutePayload {
  /** P0 stop · A author · A2 complete what is missing · B execute what exists. */
  path: string;
  reason: string;
  /** The observable state the decision was made from. */
  because: Record<string, unknown>;
  /** Tools removed from the model's view because this path does not need them. */
  denied: string[];
}

/** A change of role within a run (S5). */
export interface AgentPayload {
  /** The role now in force: "heal", "default", … */
  role: string;
  /** The observation that put the run in it. */
  because: string;
  /** The tools this role may see; empty means the skill's own list. */
  tools: string[];
}

/** Who decided, and why: a ruling a later run may cite but never author. */
export interface RulingPayload {
  subject: { type: "test" | "question" | "ac" | "bug"; ref: string };
  decision: string;
  reason: string;
  author: string;
  source: "ui" | "cli" | "tracker-comment";
}

/** A file change made by a person through attestqa, not by the agent. */
export interface UserEditPayload {
  path: string;
  before?: string;
  after: string;
  author: string;
  reason?: string;
}

/** The run's process ended without writing `end`. Written by the host. */
export interface RunAbortedPayload {
  reason: string;
  lastEventId: number;
  exitCode?: number | null;
  signal?: string;
}

export interface PayloadByKind {
  request: RequestPayload;
  plan: PlanPayload;
  context: ContextPayload;
  inference: InferencePayload;
  policy: PolicyPayload;
  approval_requested: ApprovalRequestedPayload;
  approval_resolved: ApprovalResolvedPayload;
  call: CallPayload;
  observation: ObservationPayload;
  triage: TriagePayload;
  verify: VerifyPayload;
  route: RoutePayload;
  agent: AgentPayload;
  end: EndPayload;
  ruling: RulingPayload;
  user_edit: UserEditPayload;
  run_aborted: RunAbortedPayload;
}

/**
 * One ledger line. Mirrors the pw-extensions `RunEvent` envelope so the three
 * tool families are cross-readable.
 *
 * Ledger 2.0: new ledgers are written with `tool: "attestqa"`. Ledgers written
 * before the rename say "agentic-qa" — including every run in the Paper I
 * corpus — and must keep loading, replaying and reporting exactly as before.
 */
export const LEDGER_TOOLS = ["attestqa", "agentic-qa"] as const;
export type LedgerTool = (typeof LEDGER_TOOLS)[number];
/** What this version writes. */
export const LEDGER_TOOL: LedgerTool = "attestqa";

export interface RunEvent<K extends EventKind = EventKind> {
  tool: LedgerTool;
  runId: string;
  eventId: number;
  timestamp: number;
  kind: K;
  payload: PayloadByKind[K];
}

export type AnyRunEvent = { [K in EventKind]: RunEvent<K> }[EventKind];

// ---------------------------------------------------------------------------
// Config (PLAN §0.3)
// ---------------------------------------------------------------------------

export interface ScopeConfig {
  work_items: string[];
  repos: string[];
  test_plans: string[];
  branches_writable: string[];
  /**
   * Origins (or URL prefixes/globs) the agent may point a browser at (A8).
   * Empty means the agent may not browse at all. Enforced by the gate on every
   * navigation; see `ScopedGate` for what this does and does not cover.
   */
  urls: string[];
}

export type PolicyTable = Record<PolicyClass, PolicyDecision>;

/**
 * What the ENVIRONMENT can do, as opposed to what the agent is allowed to do
 * (`policy`) or where it may act (`scope`). A capability that is off is not a
 * permission the operator withheld; it is a thing this Azure DevOps account
 * cannot do at all, and the run should neither attempt it nor be failed for
 * not having done it.
 */
export interface CapabilitiesConfig {
  /**
   * Whether test PLANS and SUITES may be created. Creating a test *case* is an
   * ordinary work-item write and needs only Basic access; creating a plan or a
   * suite goes through the Test Plans service, which needs the Test Plans
   * access level (a paid extension) and answers "You are not authorized to
   * access this API" without it. Set false on an account that does not have it:
   * the run then records cases linked to the story and reports the missing
   * suite membership as an environment limitation rather than a gap.
   */
  test_plans: boolean;
}

export const DEFAULT_CAPABILITIES: CapabilitiesConfig = { test_plans: true };

/**
 * Where the model comes from.
 *
 * ── Why this is a seam and not a string ──
 * Every run in the corpus used one provider through one SDK, so "governance
 * works" could be read as "one model happens to respect refusals". And a
 * company standardised on GitHub Copilot has no Anthropic account and often no
 * procurement path to one — "add an API key" loses most of the market before
 * the first run. The provider is therefore configuration, set once per
 * environment in `ai-quality.config.yaml`, and the runtime does not care which.
 *
 * `openai`, `azure-openai` and `local` share one wire format (OpenAI-compatible
 * chat completions with tools) and differ only in URL and authentication.
 */
export type ModelProvider = "anthropic" | "openai" | "azure-openai" | "local" | "gateway";

/**
 * How the credential is obtained. Never the credential itself.
 *
 *   key      a key read from the environment (the default)
 *   none     no credential (a local server, or a gateway that trusts the network)
 *   entra    a short-lived Microsoft Entra ID token, supplied by @attestqa/auth-azure
 *   aws-sso  a short-lived AWS SSO credential, supplied by @attestqa/auth-aws
 *
 * `entra` and `aws-sso` need a TokenSource passed to buildModel(); without one
 * the run stops before any model is called, naming the package to install.
 */
export type ModelAuth = "key" | "none" | "entra" | "aws-sso";

export interface ModelConfig {
  provider: ModelProvider;
  /** The model's name — or, for azure-openai, the DEPLOYMENT name. */
  name: string;
  /**
   * Where to send requests. Required for azure-openai (the resource URL) and
   * for local (e.g. http://localhost:11434/v1); optional for openai.
   */
  endpoint?: string;
  /** azure-openai only. */
  api_version?: string;
  /** How the credential is obtained; default "key". */
  auth?: ModelAuth;
  /**
   * gateway only: extra request headers a company's gateway needs, such as a
   * team or cost-centre name. Never secrets — config files are committed, so
   * a header whose name looks like a credential is refused at load time.
   */
  headers?: Record<string, string>;
}

export interface AgentConfig {
  model: ModelConfig;
  prompt_version: string;
  budgets: { steps: number; tokens: number };
  scope: ScopeConfig;
  policy: PolicyTable;
  /** Additive and optional (A8b); defaults to `DEFAULT_CAPABILITIES`. */
  capabilities: CapabilitiesConfig;
  /**
   * ISTQB test types in scope for stage 2's test design — any of functional,
   * security, accessibility, confirmation. Absent or empty: no design stage.
   */
  test_types?: string[];
  /**
   * bdd2pw's LLM fallback for steps its rule table cannot bind. Passed to the
   * generator only when AI_GOVERNANCE_URL is also set: bdd2pw sanitises every
   * prompt through that sidecar and fails closed without it.
   */
  llm_fallback?: "anthropic" | "openai" | "gemini";
  /**
   * Ask a person before the first suite run of a run. Later runs in the same
   * run (re-runs after a repair) go ahead under that approval. Absent or false:
   * the suite runs without asking, as before.
   */
  approve_execution?: boolean;
}

export const DEFAULT_POLICY: PolicyTable = {
  read: "execute",
  write_workspace: "execute",
  write_branch: "ask",
  write_record: "ask",
  destructive: "refuse",
};

// ---------------------------------------------------------------------------
// Skills and verifiers
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  /** System-prompt fragment appended to the runtime instructions. */
  instructions: string;
  /** Tool names (server-qualified, e.g. "ado.wit_work_item") the model may call. */
  allowedTools: string[];
  /**
   * Tools whose observations are primary sources for this skill (A6, additive
   * and optional). Context assembly orders them ahead of the step history and
   * trims them last.
   */
  sourceTools?: string[];
  verifier: Verifier;
  /**
   * Reads the RUNTIME makes before the model's first turn, instead of asking
   * the model to make them.
   *
   * The skill told the agent to read the epic, the tasks, the comments and the
   * open bugs; the ledger of a green run showed it read the story and the
   * comments, queried the open bugs for their ids and never looked at one, and
   * skipped the epic and the tasks entirely. An instruction the model may
   * weigh against its own sense of what is worthwhile is not a guarantee.
   *
   * `read` goes through the same gate and the same ledger as any model-proposed
   * call — only `read`-class tools that the gate would EXECUTE are allowed, so
   * this can observe and never act. What the skill returns is handed to the
   * model as a primary source before it plans.
   */
  preflight?: (read: PreflightRead) => Promise<PreflightDigest | undefined>;
  /**
   * A call the RUNTIME should make itself, before the model's next turn —
   * today, running the suite.
   *
   * Executing a suite is not a judgement: once a design is approved and a spec
   * exists, the suite runs, and a model turn spent deciding to run it is a turn
   * spent on a foregone conclusion — one that can also be got wrong (the wrong
   * spec, a filtered run treated as the result, or no run at all: all three
   * observed). The call goes through the gate, the approval and the ledger like
   * any other; only the decision to make it has moved into code.
   *
   * Returns undefined when there is nothing to do — nothing has changed since
   * the last run, or there is nothing to run yet.
   */
  autoRun?: (
    events: AnyRunEvent[],
  ) => { toolName: string; args: Record<string, unknown>; why: string } | undefined;
  /**
   * The path this run should take, decided from the ledger AFTER preflight and
   * BEFORE the first model turn. Pure: same events, same route.
   *
   * Returning a decision with `stop` ends the run there — the state it found is
   * not something a run can work with (no framework at all). Otherwise `deny`
   * names the tools this path does not need, and the loop removes them from
   * what the model is shown.
   */
  route?: (events: AnyRunEvent[]) => {
    path: string;
    reason: string;
    because: Record<string, unknown>;
    deny: string[];
    stop?: string;
  };
  /**
   * A second routing decision, taken after the run has learned something the
   * first could not know — today, that the approved test design adds items no
   * existing scenario covers. Returns undefined to keep the current route.
   *
   * Run 20261011T232250Z: path B ("execute existing tests") was chosen before
   * the design, the design then approved one new item, and every attempt to
   * add its scenario was refused as authoring. The agent relabelled a
   * different failing test as that bug's expected failure instead.
   */
  reroute?: (events: AnyRunEvent[]) =>
    | {
        path: string;
        reason: string;
        because: Record<string, unknown>;
        deny: string[];
      }
    | undefined;
  /**
   * Context the reviewer should see ABOVE a proposed call, decided from the
   * ledger and the workspace — e.g. which items of a test design are already
   * covered by tests on disk. Returns undefined when there is nothing to add.
   */
  approvalNote?: (
    calls: Array<{ toolName: string; args: Record<string, unknown> }>,
    events: AnyRunEvent[],
  ) =>
    | {
        /** Shown above the calls. */
        note: string;
        /** For a test design: which items already have tests, keyed by item id. */
        covered?: Map<string, { scenario: string; how: string }>;
      }
    | undefined;
  /** The work item this run is for, when the skill has one — bugs must link to it. */
  workItem?: string;
  /**
   * A skill-specific refusal, decided from the ledger: return a reason to
   * refuse the call, or undefined to let the gate's verdict stand. Used for
   * rules that depend on what the run has already seen — e.g. "this acceptance
   * criterion already has a test case".
   */
  refuse?: (
    call: { toolName: string; args: Record<string, unknown> },
    events: AnyRunEvent[],
  ) => string | undefined;
  /**
   * The report the RUNTIME posts at the very end, after execution and the bug
   * decision — or undefined when there is nothing a reader needs to know. It
   * goes through the gate and an approval like any other write.
   */
  /**
   * Calls the RUNTIME makes straight after a person approved a batch, covered
   * by that same approval — e.g. posting an approved test design to the
   * tracker. They still pass the gate (a refusal stands); they are not put to
   * the reviewer a second time, and the approval prompt says they will happen.
   */
  afterApproved?: (
    executed: Array<{ toolName: string; args: Record<string, unknown> }>,
    events: AnyRunEvent[],
  ) => Array<{ toolName: string; args: Record<string, unknown> }>;
  finalReport?: (
    events: AnyRunEvent[],
    ctx: { runId: string; agentNote?: string; status?: string },
  ) => { toolName: string; args: Record<string, unknown> } | undefined;
}

/** A governed read, executed and recorded by the loop. */
export type PreflightRead = (
  toolName: string,
  args: Record<string, unknown>,
  opts?: {
    /**
     * The item was reached through the in-scope story's own links (its epic,
     * the epic's other stories, its tasks, its test cases). Such a read is
     * allowed even when the item is outside `agent.scope.work_items` — see the
     * preflight block in the loop for why that is bounded.
     */
    linkedToStory?: boolean;
  },
) => Promise<{ ok: boolean; result: unknown }>;

export interface PreflightDigest {
  /** Name the digest appears under in the model's history, e.g. "aqa.story_context". */
  toolName: string;
  /** The context, already filtered and formatted for the model. */
  text: string;
  /** Counts for the ledger and the live terminal line. */
  summary: Record<string, number>;
  /**
   * The same context as structured facts — the criteria, bugs and tasks — for
   * rules that check later work against what was read (stage 2's test design).
   */
  facts?: unknown;
}

export interface VerifierInput {
  events: AnyRunEvent[];
  workspaceDir: string;
}

export interface Verifier {
  name: string;
  /**
   * Optional step that runs BEFORE `verify` and whose result the loop appends
   * to the ledger. `verify` then sees it in `input.events` like any other
   * event.
   *
   * It is separate from `verify` rather than folded into it because verifiers
   * do not write to the ledger — the loop does — and because triage's output
   * outlives the verdict it informs: the end-of-run quarantine check reads what
   * an earlier attempt recorded. Returning `undefined` means there was nothing
   * to triage, and no event is written.
   */
  triage?(input: VerifierInput): Promise<TriagePayload | undefined>;
  verify(input: VerifierInput): Promise<VerifyPayload>;
}
