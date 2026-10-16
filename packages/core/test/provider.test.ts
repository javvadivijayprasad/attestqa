import { describe, it, expect } from "vitest";
import { agentConfigFromObject, modelConfig, ConfigError, type RuntimeEnv } from "../src/config.js";
import { buildModel, credentialFor, describeModel } from "../src/runtime/provider.js";
import {
  OpenAiCompatibleModel,
  endpointFor,
  type ChatTransport,
  type ChatRequest,
} from "../src/runtime/openai.js";
import type { ModelInput } from "../src/runtime/model.js";

/**
 * The model is a provider, not a dependency.
 *
 * Every run in the corpus used one provider through one SDK. A company
 * standardised on Copilot has no Anthropic account. Both problems have the same
 * fix: `agent.model.provider`, set once per environment, with the credential
 * read from wherever the runtime runs — never from the config file.
 */

const BASE = {
  agent: {
    scope: { work_items: ["44"], repos: [], test_plans: [], branches_writable: [], urls: [] },
  },
};

const withModel = (model: unknown) => ({ agent: { ...BASE.agent, model } });

describe("agent.model in the config", () => {
  it("still accepts the original string form, meaning Anthropic", () => {
    const c = agentConfigFromObject(withModel("claude-sonnet-4-6"));
    expect(c.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4-6" });
  });

  it("defaults to Anthropic when absent, so every existing config still loads", () => {
    const c = agentConfigFromObject(BASE);
    expect(c.model.provider).toBe("anthropic");
  });

  it("accepts the provider form", () => {
    const c = agentConfigFromObject(
      withModel({
        provider: "azure-openai",
        name: "gpt-4.1",
        endpoint: "https://acme.openai.azure.com",
        api_version: "2024-10-21",
      }),
    );
    expect(c.model).toEqual({
      provider: "azure-openai",
      name: "gpt-4.1",
      endpoint: "https://acme.openai.azure.com",
      api_version: "2024-10-21",
    });
  });

  it("names the allowed providers when given an unknown one", () => {
    expect(() => modelConfig({ provider: "copilot", name: "x" }, "agent.model")).toThrow(
      /provider must be one of anthropic, openai, azure-openai, local/,
    );
  });

  it("requires an endpoint for azure-openai and local, and says what it looks like", () => {
    expect(() => modelConfig({ provider: "azure-openai", name: "gpt-4.1" }, "agent.model")).toThrow(
      /openai\.azure\.com/,
    );
    expect(() => modelConfig({ provider: "local", name: "llama3" }, "agent.model")).toThrow(
      /localhost:11434/,
    );
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(() =>
      modelConfig({ provider: "local", name: "llama3", endpoint: "not a url" }, "agent.model"),
    ).toThrow(ConfigError);
  });
});

describe("the credential comes from the environment, per provider", () => {
  const env = (over: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
    anthropicApiKey: "",
    sandbox: false,
    ...over,
  });

  it("reads each provider's own variable", () => {
    expect(credentialFor({ provider: "anthropic", name: "m" }, env({ anthropicApiKey: "a" }))).toBe(
      "a",
    );
    expect(credentialFor({ provider: "openai", name: "m" }, env({ openaiApiKey: "o" }))).toBe("o");
    expect(
      credentialFor(
        { provider: "azure-openai", name: "m", endpoint: "https://x.openai.azure.com" },
        env({ azureOpenAiApiKey: "z" }),
      ),
    ).toBe("z");
  });

  it("names the missing variable, not the symptom", () => {
    expect(() =>
      buildModel({
        config: {
          provider: "azure-openai",
          name: "gpt-4.1",
          endpoint: "https://x.openai.azure.com",
        },
        env: env(),
        promptVersion: "v",
      }),
    ).toThrow(/AZURE_OPENAI_API_KEY is not set/);
    expect(() =>
      buildModel({ config: { provider: "anthropic", name: "m" }, env: env(), promptVersion: "v" }),
    ).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("builds a local model with no credential at all", () => {
    const m = buildModel({
      config: { provider: "local", name: "llama3", endpoint: "http://localhost:11434/v1" },
      env: env(),
      promptVersion: "v",
    });
    expect(m.provider).toBe("local");
    expect(m.model).toBe("llama3");
  });

  it("AQA_MODEL overrides the name and never the provider", () => {
    const m = buildModel({
      config: { provider: "openai", name: "gpt-4.1" },
      env: env({ openaiApiKey: "o" }),
      promptVersion: "v",
      modelOverride: "gpt-4.1-mini",
    });
    expect(m.provider).toBe("openai");
    expect(m.model).toBe("gpt-4.1-mini");
  });

  it("describes itself for the terminal with the variable it reads", () => {
    expect(
      describeModel({
        provider: "azure-openai",
        name: "gpt-4.1",
        endpoint: "https://x.openai.azure.com",
      }),
    ).toBe("azure-openai gpt-4.1 at https://x.openai.azure.com (credential: AZURE_OPENAI_API_KEY)");
    expect(
      describeModel({ provider: "local", name: "llama3", endpoint: "http://localhost:11434/v1" }),
    ).toContain("no credential");
  });
});

describe("one wire format, three endpoints", () => {
  it("routes Azure by deployment in the path with the api-key header", () => {
    const e = endpointFor(
      { provider: "azure-openai", name: "gpt-4.1", endpoint: "https://acme.openai.azure.com/" },
      "k",
    );
    expect(e.url).toBe(
      "https://acme.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2024-10-21",
    );
    expect(e.headers).toEqual({ "api-key": "k" });
    expect(e.bodyModel).toBeUndefined();
  });

  it("routes OpenAI and local with a bearer token and the model in the body", () => {
    const o = endpointFor({ provider: "openai", name: "gpt-4.1" }, "k");
    expect(o.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(o.headers).toEqual({ authorization: "Bearer k" });
    expect(o.bodyModel).toBe("gpt-4.1");
    const l = endpointFor(
      { provider: "local", name: "llama3", endpoint: "http://localhost:11434/v1" },
      undefined,
    );
    expect(l.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(l.headers).toEqual({});
  });
});

describe("the OpenAI-compatible adapter speaks the runtime's protocol", () => {
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

  function fake(reply: unknown, seen: ChatRequest[] = []): ChatTransport {
    return async (_url, _headers, body) => {
      seen.push(body);
      return { status: 200, json: reply as never };
    };
  }

  it("maps a tool_call back to the qualified name and parses its JSON arguments", async () => {
    const seen: ChatRequest[] = [];
    const m = new OpenAiCompatibleModel({
      config: { provider: "openai", name: "gpt-4.1" },
      apiKey: "k",
      transport: fake(
        {
          choices: [
            {
              message: {
                content: "Running the suite.",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "pw__run_tests", arguments: '{"spec":"tests/e.spec.ts"}' },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        },
        seen,
      ),
    });
    const d = await m.decide(input);
    expect(d.calls).toEqual([{ toolName: "pw.run_tests", args: { spec: "tests/e.spec.ts" } }]);
    expect(d.note).toBe("Running the suite.");
    expect(d.usage).toEqual({ inputTokens: 120, outputTokens: 8, cacheReadTokens: 100 });
    // The tools went out in OpenAI's function shape, under the wire name.
    expect(seen[0]?.tools?.[0]?.function.name).toBe("pw__run_tests");
    expect(seen[0]?.messages[0]?.role).toBe("system");
    expect(seen[0]?.model).toBe("gpt-4.1");
  });

  it("no tool calls means goal reached, same as the Anthropic adapter", async () => {
    const m = new OpenAiCompatibleModel({
      config: { provider: "openai", name: "gpt-4.1" },
      apiKey: "k",
      transport: fake({
        choices: [{ message: { content: "Done." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    const d = await m.decide(input);
    expect(d.calls).toEqual([]);
    expect(d.note).toBe("Done.");
  });

  it("drops a tool the runtime never offered, with a warning, instead of passing it to the gate", async () => {
    const warnings: string[] = [];
    const m = new OpenAiCompatibleModel({
      config: { provider: "openai", name: "gpt-4.1" },
      apiKey: "k",
      warn: (w) => warnings.push(w),
      transport: fake({
        choices: [
          {
            message: {
              tool_calls: [
                { type: "function", function: { name: "fs__delete_everything", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    });
    const d = await m.decide(input);
    expect(d.calls).toEqual([]);
    expect(warnings[0]).toContain("unknown tool");
  });

  it("treats malformed JSON arguments as none, so the gate refuses the call rather than the run dying", async () => {
    const warnings: string[] = [];
    const m = new OpenAiCompatibleModel({
      config: { provider: "openai", name: "gpt-4.1" },
      apiKey: "k",
      warn: (w) => warnings.push(w),
      transport: fake({
        choices: [
          {
            message: {
              tool_calls: [
                { type: "function", function: { name: "pw__run_tests", arguments: "{spec: oops" } },
              ],
            },
          },
        ],
      }),
    });
    const d = await m.decide(input);
    expect(d.calls).toEqual([{ toolName: "pw.run_tests", args: {} }]);
    expect(warnings[0]).toContain("malformed JSON");
  });

  it("surfaces the provider's error as an error, scrubbed, not as an empty decision", async () => {
    const m = new OpenAiCompatibleModel({
      config: { provider: "azure-openai", name: "gpt-4.1", endpoint: "https://x.openai.azure.com" },
      apiKey: "k",
      transport: async () => ({
        status: 401,
        json: { error: { message: "Access denied due to invalid subscription key" } },
      }),
    });
    await expect(m.decide(input)).rejects.toThrow(/azure-openai gpt-4.1: Access denied/);
  });

  it("plans with the same request text and parses the numbered steps", async () => {
    const m = new OpenAiCompatibleModel({
      config: { provider: "openai", name: "gpt-4.1" },
      apiKey: "k",
      transport: fake({
        choices: [{ message: { content: "1. Read the story\n2. Run the suite" } }],
        usage: {},
      }),
    });
    const p = await m.plan(input);
    expect(p.steps).toEqual(["Read the story", "Run the suite"]);
  });
});

describe("Claude through a company gateway, the way Claude Code reaches it", () => {
  const base = { provider: "anthropic" as const, name: "claude-sonnet-4-6" };

  it("accepts ANTHROPIC_AUTH_TOKEN in place of an API key, and reads ANTHROPIC_BASE_URL", async () => {
    const { readRuntimeEnv } = await import("../src/config.js");
    const env = readRuntimeEnv({
      ANTHROPIC_AUTH_TOKEN: "gw-token",
      ANTHROPIC_BASE_URL: "https://llm.acme.internal",
    });
    expect(env.anthropicAuthToken).toBe("gw-token");
    expect(env.anthropicBaseUrl).toBe("https://llm.acme.internal");
    expect(() => readRuntimeEnv({})).toThrow(/ANTHROPIC_AUTH_TOKEN with ANTHROPIC_BASE_URL/);
  });

  it("says where calls go and which variable carries the credential — never the value", () => {
    const env: RuntimeEnv = {
      anthropicApiKey: "",
      anthropicAuthToken: "gw-token",
      anthropicBaseUrl: "https://llm.acme.internal",
      sandbox: false,
    };
    const line = describeModel(base, undefined, env);
    expect(line).toBe(
      "anthropic claude-sonnet-4-6 at https://llm.acme.internal (credential: ANTHROPIC_AUTH_TOKEN)",
    );
    expect(line).not.toContain("gw-token");
    expect(buildModel({ config: base, env, promptVersion: "p" }).provider).toBe("anthropic");
  });

  it("an API key still wins when both are set, as it does for Claude Code", () => {
    const env: RuntimeEnv = {
      anthropicApiKey: "sk-ant-x",
      anthropicAuthToken: "gw-token",
      sandbox: false,
    };
    expect(describeModel(base, undefined, env)).toContain("credential: ANTHROPIC_API_KEY");
  });

  it("agent.model.endpoint overrides ANTHROPIC_BASE_URL for one project", () => {
    const env: RuntimeEnv = {
      anthropicApiKey: "",
      anthropicAuthToken: "t",
      anthropicBaseUrl: "https://from-env.example",
      sandbox: false,
    };
    expect(
      describeModel({ ...base, endpoint: "https://from-config.example" }, undefined, env),
    ).toContain("at https://from-config.example");
  });
});

describe("GitHub Copilot, through the attestqa VS Code extension", () => {
  const copilot = { provider: "vscode-copilot" as const, name: "gpt-4.1" };
  const plain: RuntimeEnv = { anthropicApiKey: "", sandbox: false };

  it("refuses with a plain explanation outside VS Code (terminal, CI)", () => {
    expect(() => buildModel({ config: copilot, env: plain, promptVersion: "p" })).toThrow(
      /reached through the attestqa VS Code extension.*Run this story from VS Code/s,
    );
  });

  it("goes to the extension's private address with its token, and nowhere else", () => {
    const env: RuntimeEnv = {
      ...plain,
      vscodeLmEndpoint: "http://127.0.0.1:51234/v1",
      vscodeLmToken: "one-run-secret",
    };
    const m = buildModel({ config: copilot, env, promptVersion: "p" });
    expect(m.provider).toBe("vscode-copilot");
    const e = endpointFor({ ...copilot, endpoint: "http://127.0.0.1:51234/v1" }, "one-run-secret");
    expect(e.url).toBe("http://127.0.0.1:51234/v1/chat/completions");
    expect(e.headers).toEqual({ authorization: "Bearer one-run-secret" });
    expect(describeModel(copilot, undefined, env)).toBe(
      "GitHub Copilot gpt-4.1 (through the attestqa VS Code extension)",
    );
  });

  it("keeps the bridge's 'estimated' mark on the usage it records", async () => {
    const m = new OpenAiCompatibleModel({
      config: { ...copilot, endpoint: "http://127.0.0.1:1/v1" },
      apiKey: "t",
      transport: async () => ({
        status: 200,
        json: {
          choices: [{ message: { content: "1. read the story" } }],
          usage: { estimated: true, prompt_tokens: 900, completion_tokens: 40 },
        },
      }),
    });
    const { usage } = await m.plan({
      request: "r",
      tools: [],
      history: [],
      skillInstructions: "",
    } as never);
    expect(usage).toEqual({ inputTokens: 900, outputTokens: 40, estimated: true });
  });
});
