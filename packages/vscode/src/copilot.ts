import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import { errorBody, sameToken, toPrompt, toResponse, type ToolCall, type WireRequest } from "./copilotWire";

/**
 * Lets the attestqa engine use the person's GitHub Copilot models.
 *
 * VS Code gives extensions Copilot's models through its Language Model API,
 * with the person's consent; it gives a separate program (the `aqa` engine)
 * nothing. So for the length of one run this opens a private address on
 * 127.0.0.1, guarded by a token made for that run, and relays each model call
 * the engine makes to `vscode.lm`. Every rule stays in the engine: this decides
 * nothing, only carries the request and the answer, and logs which model
 * answered — never the prompt or the reply.
 */
export class CopilotBridge implements vscode.Disposable {
  private server: Server | undefined;
  readonly token = randomBytes(24).toString("hex");

  /**
   * @param pinned the model picked in Copilot Chat's own model menu, when the run
   *   was started from there with @attestqa; every call of the run then goes to
   *   it, whatever family the config names.
   */
  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly pinned?: vscode.LanguageModelChat,
  ) {}

  /** Starts listening on a free port; returns the endpoint for AQA_VSCODE_LM_ENDPOINT. */
  async start(): Promise<string> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!sameToken(req.headers.authorization, this.token)) return send(401, errorBody("not this run's token"));
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions"))
      return send(404, errorBody("only POST /v1/chat/completions is served"));

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 20_000_000) return send(413, errorBody("request too large"));
    }
    let body: WireRequest;
    try {
      body = JSON.parse(raw) as WireRequest;
    } catch {
      return send(400, errorBody("request is not JSON"));
    }

    try {
      const prompt = toPrompt(body);
      const model =
        this.pinned ??
        (
          await vscode.lm.selectChatModels({
            vendor: "copilot",
            ...(prompt.family ? { family: prompt.family } : {}),
          })
        )[0];
      if (!model) {
        const all = await vscode.lm.selectChatModels({ vendor: "copilot" });
        return send(
          400,
          errorBody(
            all.length
              ? `Copilot has no model family "${prompt.family}" here; available: ${all.map((m) => m.family).join(", ")}`
              : "no Copilot models are available — sign in to GitHub Copilot in VS Code",
          ),
        );
      }
      const cancel = new vscode.CancellationTokenSource();
      const timer = setTimeout(() => cancel.cancel(), 290_000); // under the engine's 300 s
      try {
        const response = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(prompt.text)],
          {
            justification: "attestqa writes and checks Playwright tests for the story you started, under your approvals.",
            tools: prompt.tools,
            toolMode: prompt.requireTool ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
          },
          cancel.token,
        );
        let text = "";
        const calls: ToolCall[] = [];
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) text += part.value;
          else if (part instanceof vscode.LanguageModelToolCallPart)
            calls.push({ callId: part.callId, name: part.name, input: part.input });
        }
        this.log.appendLine(`copilot: ${model.family} answered (${calls.length} tool call(s))`);
        return send(200, toResponse(model.family, text, calls, prompt.text.length + JSON.stringify(prompt.tools).length));
      } finally {
        clearTimeout(timer);
        cancel.dispose();
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      const status = e instanceof vscode.LanguageModelError && err.code === "NoPermissions" ? 403 : 502;
      this.log.appendLine(`copilot: ${err.code ?? "error"} — ${err.message}`);
      return send(status, errorBody(`Copilot: ${err.message}`));
    }
  }
}

/** True when the config routes the model to Copilot — read as text, so nothing else is parsed here. */
export function usesCopilot(configText: string): boolean {
  return /^\s*provider:\s*vscode-copilot\b/m.test(configText);
}

/**
 * Asks VS Code for the Copilot models now, while the person has just clicked a
 * command: VS Code shows its consent prompt only for a user-initiated action.
 */
export async function copilotModels(): Promise<vscode.LanguageModelChat[]> {
  return vscode.lm.selectChatModels({ vendor: "copilot" });
}
