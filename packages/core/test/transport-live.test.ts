import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleModel } from "../src/runtime/openai.js";
import type { TokenSource } from "../src/runtime/token.js";
import type { ModelConfig } from "../src/types.js";
import type { ModelInput } from "../src/runtime/model.js";

/**
 * End-to-end over the REAL transport.
 *
 * Every other provider test injects a fake ChatTransport, so the `fetch` path a
 * signed-in run actually uses is never exercised. These tests stand up a
 * localhost server and drive a real `decide()` through the default transport,
 * proving the company sign-in bearer reaches a genuine HTTP request, a fresh
 * token is fetched per request, and a real JSON response is parsed. What it does
 * NOT prove is that a live Entra/AWS endpoint accepts the token — that needs
 * real cloud credentials and is left to a manual smoke test.
 */

interface Captured {
  authorization?: string;
  contentType?: string;
  body: { model?: string; messages?: unknown[] };
}

interface Harness {
  url: string;
  seen: Captured[];
  close: () => Promise<void>;
}

/** A one-request-at-a-time JSON server that records what it was sent and replies with `reply`. */
async function startServer(reply: unknown): Promise<Harness> {
  const seen: Captured[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        ...(req.headers["authorization"]
          ? { authorization: String(req.headers["authorization"]) }
          : {}),
        ...(req.headers["content-type"]
          ? { contentType: String(req.headers["content-type"]) }
          : {}),
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

/** A token source that hands out a fresh, numbered token each time it is asked. */
function countingTokens(): TokenSource {
  let n = 0;
  return {
    getToken: async () => ({ token: `live-${++n}`, expiresAt: Date.now() + 3_600_000 }),
    describe: () => "test sign-in",
  };
}

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

const reply = {
  choices: [
    {
      message: {
        content: "working on it",
        tool_calls: [
          {
            type: "function",
            function: { name: "pw__run_tests", arguments: '{"spec":"a.spec.ts"}' },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 3 },
};

describe("live transport (localhost)", () => {
  it("attaches the sign-in bearer to a real HTTP request and parses the real response", async () => {
    const server = await startServer(reply);
    try {
      const config = {
        provider: "gateway",
        name: "approved-large",
        endpoint: server.url,
      } as ModelConfig;
      const model = new OpenAiCompatibleModel({
        config,
        tokenSource: countingTokens(),
        promptVersion: "v",
      });

      const decision = await model.decide(input);

      expect(server.seen[0]?.authorization).toBe("Bearer live-1");
      expect(server.seen[0]?.contentType).toContain("application/json");
      expect(server.seen[0]?.body.model).toBe("approved-large");
      expect(decision.calls).toEqual([{ toolName: "pw.run_tests", args: { spec: "a.spec.ts" } }]);
      expect(decision.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    } finally {
      await server.close();
    }
  });

  it("fetches a fresh token for every request over the real transport, never reusing one", async () => {
    const server = await startServer(reply);
    try {
      const config = {
        provider: "gateway",
        name: "approved-large",
        endpoint: server.url,
      } as ModelConfig;
      const model = new OpenAiCompatibleModel({
        config,
        tokenSource: countingTokens(),
        promptVersion: "v",
      });

      await model.decide(input);
      await model.decide(input);

      expect(server.seen.map((s) => s.authorization)).toEqual(["Bearer live-1", "Bearer live-2"]);
    } finally {
      await server.close();
    }
  });
});
