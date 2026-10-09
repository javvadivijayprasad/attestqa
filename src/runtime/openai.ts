import { scrub } from "../governance/scrub.js";
import type { ModelConfig } from "../types.js";
import {
  DEFAULT_PROMPT_VERSION,
  RUNTIME_SYSTEM,
  parseSteps,
  renderCycle,
  renderRequest,
  wireTools,
} from "./anthropic.js";
import type { ModelClient, ModelDecision, ModelInput, ModelUsage } from "./model.js";

/**
 * OpenAI-compatible chat-completions adapter: OpenAI, Azure OpenAI, and any
 * local server that speaks the same wire format (Ollama, vLLM, LM Studio).
 *
 * ── Why one adapter for three providers ──
 * They differ in two things — where the request goes and which header carries
 * the credential — and in nothing the runtime cares about. The request body,
 * the tool-call shape and the usage accounting are the same, so one adapter
 * with a small `endpointFor()` is the whole difference. A company on Copilot
 * almost always has an Azure tenant; this is the row of the provider table
 * that makes agentic-qa installable there.
 *
 * ── What is deliberately identical to the Anthropic adapter ──
 * The same `renderCycle`, the same `RUNTIME_SYSTEM`, the same `wireTools`
 * naming, the same `scrub` on every outgoing string, and the same stance: no
 * provider-side conversation. Every cycle is a fresh request assembled from the
 * ledger. The ledger is the memory, whichever model is reading it — which is
 * exactly the property a second-model run of the corpus has to hold constant.
 *
 * No SDK. `fetch` is in Node 18+, the request is one POST, and a dependency
 * would be a second thing to audit for every provider.
 */

export interface ChatRequest {
  model?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?: "auto" | "none";
  temperature?: number;
}

export interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string | number };
}

/** The one call this adapter makes. Injected for tests. */
export type ChatTransport = (
  url: string,
  headers: Record<string, string>,
  body: ChatRequest,
  timeoutMs: number,
) => Promise<{ status: number; json: ChatResponse }>;

export const fetchTransport: ChatTransport = async (url, headers, body, timeoutMs) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Typed locally: this package's tsconfig has no DOM lib, and Node's own
    // fetch types vary by @types/node version. Two fields are all that is used.
    const res = (await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })) as unknown as { status: number; json(): Promise<unknown> };
    const json = (await res.json().catch(() => ({}))) as ChatResponse;
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
};

export interface OpenAiModelOptions {
  config: ModelConfig;
  /** The credential, when the provider wants one. Local servers may need none. */
  apiKey?: string;
  promptVersion?: string;
  maxTokens?: number;
  timeoutMs?: number;
  transport?: ChatTransport;
  warn?: (message: string) => void;
}

export const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/**
 * Where the request goes, and how it is authenticated — the entire difference
 * between the three providers.
 */
export function endpointFor(
  config: ModelConfig,
  apiKey: string | undefined,
): { url: string; headers: Record<string, string>; bodyModel: string | undefined } {
  switch (config.provider) {
    case "azure-openai": {
      const base = (config.endpoint ?? "").replace(/\/+$/, "");
      const version = config.api_version ?? DEFAULT_AZURE_API_VERSION;
      return {
        url: `${base}/openai/deployments/${encodeURIComponent(config.name)}/chat/completions?api-version=${encodeURIComponent(version)}`,
        headers: apiKey ? { "api-key": apiKey } : {},
        // Azure routes by deployment in the path; a model in the body is ignored.
        bodyModel: undefined,
      };
    }
    case "local": {
      const base = (config.endpoint ?? "").replace(/\/+$/, "");
      return {
        url: `${base}/chat/completions`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        bodyModel: config.name,
      };
    }
    case "openai":
    default: {
      const base = (config.endpoint ?? "https://api.openai.com/v1").replace(/\/+$/, "");
      return {
        url: `${base}/chat/completions`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        bodyModel: config.name,
      };
    }
  }
}

export class OpenAiCompatibleModel implements ModelClient {
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  private readonly config: ModelConfig;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly transport: ChatTransport;
  private readonly warn: (m: string) => void;

  constructor(opts: OpenAiModelOptions) {
    this.config = opts.config;
    this.model = opts.config.name;
    this.provider = opts.config.provider;
    this.apiKey = opts.apiKey;
    this.promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.transport = opts.transport ?? fetchTransport;
    this.warn = opts.warn ?? (() => {});
    if (opts.config.provider !== "local" && !opts.apiKey)
      throw new Error(`provider ${opts.config.provider} requires an API key`);
  }

  private async send(body: ChatRequest): Promise<ChatResponse> {
    const { url, headers, bodyModel } = endpointFor(this.config, this.apiKey);
    const payload: ChatRequest = bodyModel ? { ...body, model: bodyModel } : body;
    const { status, json } = await this.transport(url, headers, payload, this.timeoutMs);
    if (status < 200 || status >= 300 || json.error) {
      const msg = json.error?.message ?? `HTTP ${status}`;
      throw new Error(`${this.provider} ${this.model}: ${scrub(msg).text}`);
    }
    return json;
  }

  async plan(input: ModelInput): Promise<{ steps: string[]; usage: ModelUsage }> {
    const res = await this.send({
      max_completion_tokens: Math.min(this.maxTokens, 1024),
      messages: [
        { role: "system", content: systemText(input.skillInstructions) },
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
    const res = await this.send({
      max_completion_tokens: this.maxTokens,
      messages: [
        { role: "system", content: systemText(input.skillInstructions) },
        { role: "user", content: scrub(renderCycle(input)).text },
      ],
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
      tool_choice: "auto",
    });

    const calls: ModelDecision["calls"] = [];
    for (const tc of res.choices?.[0]?.message?.tool_calls ?? []) {
      const wire = tc.function?.name ?? "";
      const qualified = toByWire.get(wire);
      if (!qualified) {
        this.warn(`model proposed unknown tool "${wire}"; dropped`);
        continue;
      }
      calls.push({ toolName: qualified, args: parseArgs(tc.function?.arguments, this.warn, wire) });
    }

    const note = textOf(res).trim();
    const decision: ModelDecision = { calls, usage: usageOf(res) };
    if (note) decision.note = note;
    return decision;
  }
}

/** The same two-part system prompt the Anthropic adapter sends, as one string. */
function systemText(skillInstructions: string): string {
  return `${RUNTIME_SYSTEM}\n\n${scrub(skillInstructions).text}`;
}

function textOf(res: ChatResponse): string {
  const c = res.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

function usageOf(res: ChatResponse): ModelUsage {
  const usage: ModelUsage = {
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
  // OpenAI reports cache HITS only; there is no creation figure. Recorded when
  // present, left absent otherwise — same convention as the Anthropic adapter.
  const cached = res.usage?.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cacheReadTokens = cached;
  return usage;
}

/**
 * Tool arguments arrive as a JSON STRING, not an object. A model that emits
 * malformed JSON gets an empty argument set and a warning, so the gate refuses
 * the call for its missing arguments rather than the run dying on a parse.
 */
function parseArgs(
  raw: string | undefined,
  warn: (m: string) => void,
  tool: string,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    warn(`model sent malformed JSON arguments for "${tool}"; treated as none`);
    return {};
  }
}
