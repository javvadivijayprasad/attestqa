import { describe, it, expect, afterEach } from "vitest";
import { agentConfigFromObject, modelConfig, type RuntimeEnv } from "../src/config.js";
import {
  buildModel,
  credentialVarFor,
  describeModel,
  registerProvider,
  clearRegisteredProviders,
  type TokenSource,
} from "../src/runtime/provider.js";
import {
  OpenAiCompatibleModel,
  type ChatRequest,
  type ChatTransport,
} from "../src/runtime/openai.js";
import type { ModelClient, ModelInput } from "../src/runtime/model.js";
import type { ModelConfig } from "../src/types.js";

/**
 * Provider conformance (AQ-04 §2.3).
 *
 * Every provider must behave the same towards the runtime, so that changing
 * `agent.model.provider` changes the model and nothing else — which is also
 * what a cross-model study needs to hold constant. These checks run against
 * each OpenAI-compatible provider with a fake transport; the Anthropic adapter
 * has the same checks in anthropic.test.ts against a fake SDK.
 */

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

const PROVIDERS: Array<{ label: string; config: ModelConfig }> = [
  { label: "openai", config: { provider: "openai", name: "gpt-4.1" } },
  {
    label: "azure-openai",
    config: {
      provider: "azure-openai",
      name: "gpt-4.1",
      endpoint: "https://acme.openai.azure.com",
    },
  },
  {
    label: "local",
    config: { provider: "local", name: "llama3", endpoint: "http://localhost:11434/v1" },
  },
  {
    label: "gateway",
    config: {
      provider: "gateway",
      name: "approved-large",
      endpoint: "https://llm-gateway.acme.internal/v1",
      headers: { "x-team": "qa" },
    },
  },
];

type Seen = { url: string; headers: Record<string, string>; body: ChatRequest };

function client(
  config: ModelConfig,
  replies: unknown[],
  seen: Seen[] = [],
  extra: Partial<{ tokenSource: TokenSource; warn: (m: string) => void }> = {},
): ModelClient {
  let i = 0;
  const transport: ChatTransport = async (url, headers, body) => {
    seen.push({ url, headers, body });
    const reply = replies[Math.min(i++, replies.length - 1)] as { status?: number; json?: unknown };
    return { status: reply.status ?? 200, json: (reply.json ?? reply) as never };
  };
  return new OpenAiCompatibleModel({ config, apiKey: "k", transport, ...extra });
}

const toolCall = (name: string, args: string) => ({
  choices: [
    {
      message: {
        content: "note",
        tool_calls: [{ type: "function", function: { name, arguments: args } }],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});

describe.each(PROVIDERS)("conformance: $label", ({ config }) => {
  it("maps a tool call back to the runtime's qualified name", async () => {
    const d = await client(config, [toolCall("pw__run_tests", '{"spec":"a.spec.ts"}')]).decide(
      input,
    );
    expect(d.calls).toEqual([{ toolName: "pw.run_tests", args: { spec: "a.spec.ts" } }]);
  });

  it("turns malformed arguments into none, with a warning, so the gate decides", async () => {
    const warnings: string[] = [];
    const d = await client(config, [toolCall("pw__run_tests", "{oops")], [], {
      warn: (w) => warnings.push(w),
    }).decide(input);
    expect(d.calls).toEqual([{ toolName: "pw.run_tests", args: {} }]);
    expect(warnings.join(" ")).toContain("malformed JSON");
  });

  it("drops a tool the runtime never offered", async () => {
    const warnings: string[] = [];
    const d = await client(config, [toolCall("fs__delete_everything", "{}")], [], {
      warn: (w) => warnings.push(w),
    }).decide(input);
    expect(d.calls).toEqual([]);
    expect(warnings.join(" ")).toContain("unknown tool");
  });

  it("throws on a provider error instead of returning an empty decision", async () => {
    await expect(
      client(config, [{ status: 429, json: { error: { message: "rate limited" } } }]).decide(input),
    ).rejects.toThrow(/rate limited/);
  });

  it("records usage", async () => {
    const d = await client(config, [toolCall("pw__run_tests", "{}")]).decide(input);
    expect(d.usage.inputTokens).toBe(10);
    expect(d.usage.outputTokens).toBe(2);
  });

  it("keeps no conversation between calls: each request is built from the input alone", async () => {
    const seen: Seen[] = [];
    const m = client(config, [toolCall("pw__run_tests", "{}")], seen);
    await m.decide(input);
    await m.decide(input);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body.messages).toEqual(seen[0]!.body.messages);
  });

  it("uses a token source when given one, fetching a fresh token for every request, and never the key", async () => {
    const seen: Seen[] = [];
    let n = 0;
    const tokenSource: TokenSource = {
      getToken: async () => ({ token: `t${++n}`, expiresAt: Date.now() + 3_600_000 }),
      describe: () => "test sign-in",
    };
    const m = client(config, [toolCall("pw__run_tests", "{}")], seen, { tokenSource });
    await m.decide(input);
    await m.decide(input);
    expect(seen.map((s) => s.headers["authorization"])).toEqual(["Bearer t1", "Bearer t2"]);
    expect(JSON.stringify(seen.map((s) => s.headers))).not.toContain('"k"');
    expect(JSON.stringify(seen.map((s) => s.headers))).not.toContain("Bearer k");
  });
});

describe("gateway", () => {
  const env: RuntimeEnv = { anthropicApiKey: "", sandbox: false, gatewayApiKey: "g" };
  const gw = (extra: Record<string, unknown> = {}) =>
    modelConfig(
      {
        provider: "gateway",
        name: "approved-large",
        endpoint: "https://llm-gateway.acme.internal/v1",
        ...extra,
      },
      "agent.model",
    );

  it("sends to the gateway's chat completions with its non-secret headers and the key from AQA_GATEWAY_API_KEY", async () => {
    const seen: Seen[] = [];
    const m = new OpenAiCompatibleModel({
      config: gw({ headers: { "x-team": "qa" } }),
      apiKey: "g",
      transport: async (url, headers, body) => {
        seen.push({ url, headers, body });
        return { status: 200, json: toolCall("pw__run_tests", "{}") as never };
      },
    });
    await m.decide(input);
    expect(seen[0]!.url).toBe("https://llm-gateway.acme.internal/v1/chat/completions");
    expect(seen[0]!.headers).toEqual({ "x-team": "qa", authorization: "Bearer g" });
    expect(seen[0]!.body.model).toBe("approved-large");
    expect(credentialVarFor(gw())).toBe("AQA_GATEWAY_API_KEY");
    expect(() => buildModel({ config: gw(), env, promptVersion: "v" })).not.toThrow();
  });

  it("requires an endpoint", () => {
    expect(() => modelConfig({ provider: "gateway", name: "x" }, "agent.model")).toThrow(
      /endpoint is required for provider gateway/,
    );
  });

  it("refuses a credential in a config header", () => {
    for (const h of ["Authorization", "x-api-key", "X-Gateway-Token", "api_key", "Cookie"]) {
      expect(() => gw({ headers: { [h]: "secret" } })).toThrow(/looks like a credential/);
    }
  });

  it("allows headers only for the gateway", () => {
    expect(() =>
      modelConfig(
        { provider: "openai", name: "gpt-4.1", headers: { "x-team": "qa" } },
        "agent.model",
      ),
    ).toThrow(/only for provider gateway/);
  });

  it("runs with no credential when auth is none", () => {
    expect(() =>
      buildModel({
        config: gw({ auth: "none" }),
        env: { anthropicApiKey: "", sandbox: false },
        promptVersion: "v",
      }),
    ).not.toThrow();
    expect(credentialVarFor(gw({ auth: "none" }))).toBeNull();
  });
});

describe("company sign-in", () => {
  const env: RuntimeEnv = { anthropicApiKey: "", sandbox: false };
  const azure = (auth: string) =>
    modelConfig(
      {
        provider: "azure-openai",
        name: "gpt-4.1",
        endpoint: "https://acme.openai.azure.com",
        auth,
      },
      "agent.model",
    );

  it("names the package to install when auth is entra or aws-sso and no token source is given", () => {
    expect(() => buildModel({ config: azure("entra"), env, promptVersion: "v" })).toThrow(
      /@attestqa\/auth-azure/,
    );
    expect(() =>
      buildModel({
        config: { provider: "openai", name: "gpt-4.1", auth: "aws-sso" },
        env,
        promptVersion: "v",
      }),
    ).toThrow(/@attestqa\/auth-aws/);
  });

  it("builds without any key when a token source is supplied, and says so", () => {
    const tokenSource: TokenSource = {
      getToken: async () => ({ token: "t", expiresAt: Date.now() + 600_000 }),
      describe: () => "Microsoft Entra ID: tester@acme.test",
    };
    expect(() =>
      buildModel({ config: azure("entra"), env, promptVersion: "v", tokenSource }),
    ).not.toThrow();
    expect(describeModel(azure("entra"), tokenSource)).toContain(
      "sign-in: Microsoft Entra ID: tester@acme.test",
    );
  });

  it("rejects an unknown auth mode", () => {
    expect(() => azure("password")).toThrow(/auth must be one of key, none, entra, aws-sso/);
  });

  it("keeps a token source away from Anthropic, which takes keys only", () => {
    const tokenSource: TokenSource = {
      getToken: async () => ({ token: "t", expiresAt: Date.now() + 600_000 }),
      describe: () => "x",
    };
    expect(() =>
      buildModel({
        config: { provider: "anthropic", name: "m" },
        env,
        promptVersion: "v",
        tokenSource,
      }),
    ).toThrow(/takes an API key/);
  });
});

describe("plug-in providers", () => {
  afterEach(() => clearRegisteredProviders());

  it("lets a plug-in register a provider the config can then name", () => {
    const fake = { model: "m", promptVersion: "v", provider: "acme" } as unknown as ModelClient;
    registerProvider("acme-llm", () => fake);
    const cfg = agentConfigFromObject({
      agent: {
        model: { provider: "acme-llm", name: "m" },
        scope: { work_items: ["44"], repos: [], test_plans: [], branches_writable: [], urls: [] },
      },
    });
    expect(
      buildModel({
        config: cfg.model,
        env: { anthropicApiKey: "", sandbox: false },
        promptVersion: "v",
      }),
    ).toBe(fake);
  });

  it("rejects an unregistered provider, listing what is available", () => {
    expect(() => modelConfig({ provider: "acme-llm", name: "m" }, "agent.model")).toThrow(
      /must be one of anthropic, openai, azure-openai, local, gateway/,
    );
  });

  it("does not let a plug-in replace a built-in provider", () => {
    expect(() => registerProvider("openai", () => ({}) as ModelClient)).toThrow(/built in/);
  });
});
