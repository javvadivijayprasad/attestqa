import { scrub } from "../governance/scrub.js";
import type { HistoryItem, ModelClient, ModelDecision, ModelInput, ModelUsage } from "./model.js";
import type { ToolDescriptor } from "./tools.js";

/**
 * The slice of the Anthropic SDK this package uses. Kept as our own interface
 * so the suite injects a fake and the SDK is imported only when a real run
 * happens (same approach as the MCP client).
 */
export interface MessagesApi {
  create(body: MessageRequest): Promise<MessageResponse>;
}

/**
 * A cache breakpoint. Everything BEFORE it, in the order tools → system →
 * messages, becomes a cacheable prefix.
 */
export interface CacheControl {
  type: "ephemeral";
}

export const CACHE_CONTROL: CacheControl = { type: "ephemeral" };

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  /** A plain string, or blocks so a cache breakpoint can be placed. */
  system: string | SystemBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: ToolDefinition[];
  tool_choice?: { type: "auto" | "any" | "none" };
  temperature?: number;
}

export interface MessageResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: string; [k: string]: unknown }
  >;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface TransportOptions {
  timeoutMs: number;
  maxRetries: number;
}

export type MessagesFactory = (
  apiKey: string,
  transport?: TransportOptions,
) => Promise<MessagesApi>;

/**
 * How long one model call may take before it is abandoned.
 *
 * Every other wait in this runtime is bounded — the step and token budgets, the
 * approval timeout, the adapters' command timeouts. The model call was not, and
 * a stalled connection therefore hung a run indefinitely: observed on run
 * `20260915T222657Z-73bb1bab`, where the ledger's last event is a `context` at
 * 22:44:17 and nothing followed it for 26 minutes. The loop could not stop it
 * because control never came back.
 *
 * The worse half of that bug is evidential. A hung request produces no event at
 * all, so the one artefact this project relies on to explain a run says only
 * that a cycle was assembled. A timeout turns silence into a recorded failure.
 *
 * Five minutes is generous for a single call — a large cycle with an 8k output
 * budget runs to a minute or two — and anything beyond it is pathological
 * rather than slow.
 */
export const DEFAULT_TRANSPORT: TransportOptions = { timeoutMs: 300_000, maxRetries: 2 };

/** Default: the official SDK, imported lazily so unit tests never need it. */
export const sdkMessagesFactory: MessagesFactory = async (apiKey, transport) => {
  const { timeoutMs, maxRetries } = transport ?? DEFAULT_TRANSPORT;
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (opts: { apiKey: string; timeout?: number; maxRetries?: number }) => {
      messages: MessagesApi;
    };
  };
  const Anthropic = mod.default;
  // The SDK retries a timed-out request itself; `maxRetries` bounds that, so the
  // worst case is (maxRetries + 1) × timeoutMs rather than forever.
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries }).messages;
};

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  promptVersion?: string;
  maxTokens?: number;
  /** Injected for tests. */
  factory?: MessagesFactory;
  /** Bounds on one model call. Defaults to DEFAULT_TRANSPORT. */
  transport?: Partial<TransportOptions>;
  /** Where to report non-fatal adapter problems. Scrubbed before writing. */
  warn?: (message: string) => void;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_PROMPT_VERSION = "aqa-prompt-v0.1.0";

/**
 * The runtime's own instructions, ahead of the skill's. These describe the
 * MACHINE the model is driving; the skill describes the JOB.
 */
export const RUNTIME_SYSTEM = `You are the reasoning step of an agentic QA runtime. You choose the next action; you do not perform it.

How a cycle works. You are given the request, the tools you may use, primary
sources you have already read, and a history of what has happened. You reply
with one or more tool calls, or with no tool calls at all — which means "I
believe the goal is reached" and hands over to a verifier that checks the run
ledger. The verifier decides done, not you.

What happens to your tool calls. Each one is classified by a governance gate
before it runs: it may execute, it may be put to a human for approval, or it may
be refused. A refusal is final for that call — the gate's decision will not
change on a retry, so read the reason and choose a different route. Refused and
denied calls come back to you in the history with their reason.

Rules.
- Call tools only from the provided list, with the exact names given.
- Fill in every argument the schema requires. A call missing an argument the gate
  needs to check scope is refused without being executed.
- Prefer several independent calls in one reply over one call per cycle; they are
  gated together and, where approval is needed, presented to the human as one
  request.
- Never claim a step succeeded. The ledger records what actually happened, and
  the verifier reads the ledger rather than your summary.
- If you cannot make progress, say so plainly with no tool calls and explain what
  is blocking you. An honest stop is a better outcome than invented progress.`;

/**
 * Anthropic Messages API adapter.
 *
 * Note what this deliberately does NOT do: it does not maintain an API-side
 * conversation with tool_result turns. Every cycle is a fresh, self-contained
 * request assembled from the ledger by the context builder. The ledger is the
 * memory, which is what makes a run replayable and auditable after the fact —
 * a conversation living inside the provider's message history would not be.
 */
export class AnthropicModel implements ModelClient {
  readonly model: string;
  readonly provider = "anthropic";
  readonly promptVersion: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly factory: MessagesFactory;
  private readonly transport: TransportOptions;
  private readonly warn: (m: string) => void;
  private api: MessagesApi | undefined;

  constructor(opts: AnthropicModelOptions) {
    if (!opts.apiKey) throw new Error("AnthropicModel requires an API key");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;
    // A generated spec for half a dozen scenarios does not fit in 4k.
    this.maxTokens = opts.maxTokens ?? 8192;
    this.factory = opts.factory ?? sdkMessagesFactory;
    this.transport = { ...DEFAULT_TRANSPORT, ...opts.transport };
    this.warn = opts.warn ?? (() => {});
  }

  private async messages(): Promise<MessagesApi> {
    this.api ??= await this.factory(this.apiKey, this.transport);
    return this.api;
  }

  async plan(input: ModelInput): Promise<{ steps: string[]; usage: ModelUsage }> {
    const res = await (
      await this.messages()
    ).create({
      model: this.model,
      max_tokens: Math.min(this.maxTokens, 1024),
      system: systemBlocks(input.skillInstructions),
      messages: [
        {
          role: "user",
          content: scrub(
            `${renderRequest(input)}\n\nOutline how you will approach this, as a short numbered list of steps. Do not call any tools yet.`,
          ).text,
        },
      ],
    });
    return { steps: parseSteps(textOf(res)), usage: usageOf(res) };
  }

  async decide(input: ModelInput): Promise<ModelDecision> {
    const { tools, toByWire } = wireTools(input.tools);
    const res = await (
      await this.messages()
    ).create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemBlocks(input.skillInstructions),
      messages: [{ role: "user", content: scrub(renderCycle(input)).text }],
      tools,
      tool_choice: { type: "auto" },
    });

    const calls: ModelDecision["calls"] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const b = block as { name: string; input: Record<string, unknown> };
      const qualified = toByWire.get(b.name);
      if (!qualified) {
        // The model invented a tool name. Drop it rather than passing it to the
        // gate as an unknown tool — but say so, because it means the schema
        // round-trip is wrong somewhere.
        this.warn(`model proposed unknown tool "${b.name}"; dropped`);
        continue;
      }
      calls.push({ toolName: qualified, args: b.input ?? {} });
    }

    const note = textOf(res).trim();
    const decision: ModelDecision = { calls, usage: usageOf(res) };
    if (note) decision.note = note;
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Tool names in the Messages API must match ^[a-zA-Z0-9_-]{1,128}$, but ours
 * are qualified with a dot ("ado.wit_work_item"). Map the dot to "__" on the
 * way out and back on the way in, so the ledger keeps the qualified name and
 * the API gets a legal one.
 */
export function toWireName(qualified: string): string {
  return qualified.replace(/\./g, "__");
}

export function fromWireName(wire: string): string {
  return wire.replace(/__/g, ".");
}

export function wireTools(descriptors: ToolDescriptor[]): {
  tools: NonNullable<MessageRequest["tools"]>;
  toByWire: Map<string, string>;
} {
  const toByWire = new Map<string, string>();
  const tools: ToolDefinition[] = descriptors.map((d) => {
    const qualified = `${d.server}.${d.name}`;
    const wire = toWireName(qualified);
    toByWire.set(wire, qualified);
    return {
      name: wire,
      description: describeTool(d),
      input_schema: normaliseSchema(d.inputSchema),
    };
  });

  // A breakpoint on the LAST tool makes the whole tools block a cacheable
  // prefix. This is the single largest saving available: the tool schemas are
  // byte-identical on every cycle of a run and are most of what a cycle sends —
  // a fix → run → fix cycle costs roughly 14k tokens, the bulk of it these.
  //
  // The order that matters is tools → system → messages. Anything before a
  // breakpoint is cached, so this one covers the tools and nothing else, and
  // the breakpoint at the end of the system block covers both.
  const last = tools[tools.length - 1];
  if (last) last.cache_control = CACHE_CONTROL;

  return { tools, toByWire };
}

/**
 * The system prompt as cacheable blocks.
 *
 * `RUNTIME_SYSTEM` and the skill's instructions do not change within a run, so
 * they are a prefix worth caching. Every cycle is assembled fresh from the
 * ledger rather than continuing a conversation — that is what makes a run
 * replayable — and the cost of that choice is re-sending this on every cycle.
 * Caching removes the cost without touching the property.
 */
export function systemBlocks(skillInstructions: string): SystemBlock[] {
  return [
    {
      type: "text",
      text: scrub(`${RUNTIME_SYSTEM}\n\n---\n\n${skillInstructions}`).text,
      cache_control: CACHE_CONTROL,
    },
  ];
}

/**
 * The description the model sees. Beyond the server's own text it states the
 * governance class and, for action-multiplexed tools, exactly which actions are
 * permitted — so the model learns the boundary from the tool definition rather
 * than by being refused.
 */
function describeTool(d: ToolDescriptor): string {
  const parts = [d.description || `${d.server} ${d.name}`];
  const actions = Object.entries(d.actions ?? {});
  if (actions.length > 0 && d.actionArg) {
    parts.push(
      `Permitted ${d.actionArg} values: ${actions
        .map(([name, a]) => `"${name}" (${a.policyClass})`)
        .join(", ")}. Any other ${d.actionArg} is refused.`,
    );
  } else {
    parts.push(`Governance class: ${d.policyClass}.`);
  }
  const scoped = [d.scopeArgs, ...actions.map(([, a]) => a.scopeArgs)].filter(Boolean);
  const args = [...new Set(scoped.flatMap((s) => Object.values(s ?? {})))];
  if (args.length > 0) {
    parts.push(
      `Scope-checked argument(s): ${args.join(", ")} — required, and checked against the run's allow-list.`,
    );
  }
  return parts.join(" ");
}

/** The API requires an object schema; some servers return an empty or odd one. */
export function normaliseSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema && schema["type"] === "object") return schema;
  const properties = schema && isObject(schema["properties"]) ? schema["properties"] : {};
  return { type: "object", properties };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function renderRequest(input: ModelInput): string {
  return `# Request\n\n${input.request}`;
}

/** One cycle's user message: request, sources, history, gaps — in that order. */
export function renderCycle(input: ModelInput): string {
  const sections: string[] = [renderRequest(input)];

  const sources = input.history.filter(isSourceLike);
  const steps = input.history.filter((h) => !isSourceLike(h));

  if (sources.length > 0) {
    sections.push(`# Sources already read\n\n${sources.map(renderItem).join("\n\n")}`);
  }
  if (steps.length > 0) {
    sections.push(`# What has happened so far\n\n${steps.map(renderItem).join("\n\n")}`);
  }
  if (input.notes && input.notes.length > 0) {
    sections.push(
      `# What you said in earlier cycles\n\nYour reasoning is not carried over automatically; this is it, oldest first. Continue from it rather than starting again.\n\n${input.notes
        .map((n) => `- ${n}`)
        .join("\n")}`,
    );
  }
  if (input.gaps && input.gaps.length > 0) {
    sections.push(
      `# The verifier rejected the run\n\nYou said the goal was reached; it is not. These gaps remain, and this is your last attempt:\n\n${input.gaps
        .map((g) => `- ${g}`)
        .join("\n")}`,
    );
  }
  sections.push(
    `# Now\n\nChoose the next action. Reply with tool calls, or with no tool calls if you believe the goal is reached. Re-reading something already shown above changes nothing and will be refused — if you have what you need, act on it.`,
  );
  return sections.join("\n\n");
}

/** Context assembly marks primary sources; the adapter does not re-decide. */
function isSourceLike(h: HistoryItem): boolean {
  return h.source === true;
}

function renderItem(h: HistoryItem): string {
  const args = briefArgs(h.args);
  const head = `## ${h.toolName}${args ? ` ${args}` : ""} (${h.ok ? "ok" : "failed"}, ${h.ledgerRef})`;
  if (h.gate) return `${head}\n\n${h.gate.decision.toUpperCase()}: ${h.gate.reason}`;
  return `${head}\n\n${h.summary}`;
}

/**
 * The arguments that tell one call of a tool from another — paths, urls, ids,
 * modes — on one line. Long text (file content, a comment body) is shown by
 * its length only; the history is not the place to repeat it.
 */
export function briefArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string")
      parts.push(v.length > 120 ? `${k}=<${v.length} chars>` : `${k}=${JSON.stringify(v)}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${String(v)}`);
    else if (
      Array.isArray(v) &&
      v.every((x) => typeof x === "number" || (typeof x === "string" && x.length <= 40))
    )
      parts.push(v.length <= 8 ? `${k}=${JSON.stringify(v)}` : `${k}=<${v.length} items>`);
    else parts.push(Array.isArray(v) ? `${k}=<${v.length} items>` : `${k}=<object>`);
  }
  const line = parts.join(", ");
  return line ? `(${line.length > 300 ? `${line.slice(0, 300)}…` : line})` : "";
}

function textOf(res: MessageResponse): string {
  return res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function usageOf(res: MessageResponse): ModelUsage {
  const usage: ModelUsage = {
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
  };
  // Emitted only when the API reports them. A zero is meaningful — it says the
  // prefix missed — but an ABSENT field says the provider does not report
  // caching at all, and the two should not be conflated in the evidence.
  const read = res.usage?.cache_read_input_tokens;
  const created = res.usage?.cache_creation_input_tokens;
  if (typeof read === "number") usage.cacheReadTokens = read;
  if (typeof created === "number") usage.cacheCreationTokens = created;
  return usage;
}

/** "1. Read the story" → ["Read the story"]; falls back to non-empty lines. */
export function parseSteps(text: string): string[] {
  const numbered = text
    .split(/\r?\n/)
    .map((l) => /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(l.trim())?.[1]?.trim())
    .filter((s): s is string => Boolean(s));
  if (numbered.length > 0) return numbered;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, 10);
}
