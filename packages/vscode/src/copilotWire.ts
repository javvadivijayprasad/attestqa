/**
 * The translation between the engine's OpenAI-style request and VS Code's
 * Language Model API, kept free of the `vscode` module so it can be tested on
 * its own. The engine sends each cycle as one fresh request — a system message,
 * a user message and the tool list — and reads back text and tool calls.
 */

export interface WireRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: unknown;
}

export interface Prompt {
  /** The model family asked for; undefined means "the first Copilot model VS Code offers". */
  family: string | undefined;
  /** VS Code's API has no system role: the system text leads the one user message. */
  text: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  requireTool: boolean;
}

export function toPrompt(body: WireRequest): Prompt {
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string" && m.content.trim()) parts.push(m.content);
  }
  if (parts.length === 0) throw new Error("the request has no message text");
  const family = typeof body.model === "string" && body.model.trim() && body.model !== "auto" ? body.model.trim() : undefined;
  const tools = (body.tools ?? [])
    .map((t) => t.function)
    .filter((f): f is NonNullable<typeof f> => Boolean(f?.name))
    .map((f) => ({
      name: f.name as string,
      description: f.description ?? "",
      inputSchema: f.parameters ?? { type: "object", properties: {} },
    }));
  return { family, text: parts.join("\n\n"), tools, requireTool: body.tool_choice === "required" };
}

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
}

/** Copilot reports no usage. Four characters a token is the usual rough measure; marked as an estimate. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function toResponse(
  model: string,
  text: string,
  calls: ToolCall[],
  promptChars: number,
): Record<string, unknown> {
  const outChars = text.length + calls.reduce((n, c) => n + c.name.length + JSON.stringify(c.input ?? {}).length, 0);
  const prompt = estimateTokens(promptChars);
  const completion = estimateTokens(outChars);
  return {
    id: `aqa-copilot-${Date.now()}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((c) => ({
                  id: c.callId,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
                })),
              }
            : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { estimated: true, prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

export function errorBody(message: string): Record<string, unknown> {
  return { error: { message, type: "vscode_copilot" } };
}

/** Compares the bearer token without leaking how much of it matched through timing. */
export function sameToken(header: string | undefined, token: string): boolean {
  const got = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "";
  if (got.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export interface ModelInfo {
  family: string;
  maxInputTokens: number;
}

/**
 * Which Copilot model a run uses. The family the config or the chat named, if
 * it is offered; otherwise ("auto") the one that takes the most input. The
 * engine's cycles carry its rules and tool list, so a small model — the first
 * one VS Code happens to list — overflows on the first real step.
 */
export function pickModel<T extends ModelInfo>(models: T[], family: string | undefined): T | undefined {
  if (family) return models.find((m) => m.family === family);
  return [...models].sort((a, b) => b.maxInputTokens - a.maxInputTokens)[0];
}

/** Undefined when the prompt fits; otherwise a sentence saying what to do instead. */
export function tooLarge(promptChars: number, model: ModelInfo, all: ModelInfo[]): string | undefined {
  const need = estimateTokens(promptChars);
  if (need <= model.maxInputTokens) return undefined;
  const bigger = all
    .filter((m) => m.maxInputTokens >= need)
    .sort((a, b) => b.maxInputTokens - a.maxInputTokens)
    .map((m) => `${m.family} (${m.maxInputTokens})`);
  return (
    `this step needs about ${need} input tokens and ${model.family} takes ${model.maxInputTokens}. ` +
    (bigger.length
      ? `Choose a larger Copilot model — ${bigger.join(", ")} — in the config's agent.model.name or the chat's model menu.`
      : "No Copilot model available to you takes that much; use another model route for this project.")
  );
}
