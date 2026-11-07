import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createBedrockMessagesFactory } from "../src/index.js";
import type { ModelInput } from "attestqa";

/**
 * End-to-end over the REAL Bedrock SDK, offline.
 *
 * The other Bedrock tests inject a fake client, so `@anthropic-ai/bedrock-sdk`'s
 * own code — SigV4 signing, the `/model/<id>/invoke` request, response parsing —
 * never runs. This test points the real SDK at a localhost server with
 * throwaway static AWS credentials: SigV4 signs with them (pure HMAC, no network
 * and no validation), the request reaches our server, and a canned Bedrock
 * (Anthropic Messages) response is parsed back through a real `decide()`. The one
 * thing it cannot prove is that live Bedrock accepts the signature — that needs a
 * real AWS account and is left to a manual smoke test.
 */

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

const input: ModelInput = {
  request: "test story 44",
  skillInstructions: "the skill",
  tools: [
    {
      server: "pw",
      name: "run_tests",
      description: "run",
      inputSchema: { type: "object", properties: { spec: { type: "string" } } },
      policyClass: "write_workspace",
    },
  ],
  history: [],
};

/** A canned Bedrock InvokeModel body: the Anthropic Messages response shape. */
const cannedMessage = {
  id: "msg_live",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [
    { type: "text", text: "reading the story" },
    { type: "tool_use", id: "t1", name: "pw__run_tests", input: { spec: "a.spec.ts" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 21, output_tokens: 7 },
};

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
}

async function startServer(): Promise<{
  baseURL: string;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.push({
        ...(req.method ? { method: req.method } : {}),
        ...(req.url ? { url: req.url } : {}),
        ...(req.headers["authorization"]
          ? { authorization: String(req.headers["authorization"]) }
          : {}),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cannedMessage));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe("@attestqa/provider-bedrock over the real Bedrock SDK (localhost)", () => {
  it("SigV4-signs and drives a real decide() end-to-end against a canned response", async () => {
    const server = await startServer();
    const saved = {
      base: process.env["ANTHROPIC_BEDROCK_BASE_URL"],
      ak: process.env["AWS_ACCESS_KEY_ID"],
      sk: process.env["AWS_SECRET_ACCESS_KEY"],
      region: process.env["AWS_REGION"],
    };
    try {
      // Throwaway, non-functional AWS example credentials: SigV4 signs with them
      // offline; they are never sent to or checked by AWS.
      process.env["ANTHROPIC_BEDROCK_BASE_URL"] = server.baseURL;
      process.env["AWS_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["AWS_SECRET_ACCESS_KEY"] = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      process.env["AWS_REGION"] = "us-east-1";

      // The REAL default loadClient: it imports @anthropic-ai/bedrock-sdk.
      const factory = createBedrockMessagesFactory({});
      const { AnthropicModel } = await import("attestqa");
      const model = new AnthropicModel({
        apiKey: "",
        model: MODEL,
        promptVersion: "v",
        factory,
      });

      const decision = await model.decide(input);

      expect(decision.calls).toEqual([{ toolName: "pw.run_tests", args: { spec: "a.spec.ts" } }]);
      expect(decision.usage).toEqual({ inputTokens: 21, outputTokens: 7 });
      expect(decision.note).toBe("reading the story");

      expect(server.seen[0]?.method).toBe("POST");
      expect(server.seen[0]?.url).toContain("/invoke");
      expect(server.seen[0]?.authorization).toMatch(/AWS4-HMAC-SHA256/);
    } finally {
      for (const [k, v] of Object.entries({
        ANTHROPIC_BEDROCK_BASE_URL: saved.base,
        AWS_ACCESS_KEY_ID: saved.ak,
        AWS_SECRET_ACCESS_KEY: saved.sk,
        AWS_REGION: saved.region,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await server.close();
    }
  });
});
