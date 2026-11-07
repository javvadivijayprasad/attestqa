import { describe, it, expect, afterEach } from "vitest";
import type { ModelConfig, ModelInput } from "attestqa";
import { provider, factory, createBedrockMessagesFactory } from "../src/index.js";

// `bedrock` is a plug-in provider, so at the type level it is not in the
// built-in ModelProvider union; at runtime the loader has registered it. The
// config carries the name as an opaque string, as it does in a real run.
const bedrockConfig = (name: string): ModelConfig =>
  ({ provider: "bedrock", name }) as unknown as ModelConfig;

interface SeenRequest {
  model: string;
  max_tokens: number;
}

interface CtorOpts {
  awsRegion?: string;
  timeout?: number;
  maxRetries?: number;
}

/** A fake AnthropicBedrock: records the ctor options and the requests it is sent. */
function fakeBedrock(seen: SeenRequest[], ctorSeen: CtorOpts[]) {
  return class {
    messages = {
      create: async (body: SeenRequest) => {
        seen.push(body);
        return {
          content: [{ type: "text", text: "thinking about it" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 5 },
        };
      },
    };
    constructor(opts: CtorOpts) {
      ctorSeen.push(opts);
    }
  };
}

/** A fake AnthropicBedrock that replays scripted responses (or throws an Error from the list). */
function scriptedBedrock(responses: unknown[]) {
  let i = 0;
  return class {
    messages = {
      create: async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    };
    constructor(_opts: CtorOpts) {}
  };
}

/** Build the core AnthropicModel the way `factory` does, but over an injected Bedrock client. */
async function bedrockModel(responses: unknown[], warn?: (m: string) => void) {
  const { AnthropicModel } = await import("attestqa");
  const messages = createBedrockMessagesFactory({
    loadClient: async () => scriptedBedrock(responses) as never,
  });
  return new AnthropicModel({
    apiKey: "",
    model: MODEL,
    promptVersion: "v",
    factory: messages,
    ...(warn ? { warn } : {}),
  });
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

const env = { anthropicApiKey: "", sandbox: false };
const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

const savedRegion = process.env["AWS_REGION"];
afterEach(() => {
  if (savedRegion === undefined) delete process.env["AWS_REGION"];
  else process.env["AWS_REGION"] = savedRegion;
});

describe("@attestqa/provider-bedrock", () => {
  it("answers to the provider name the loader registers", () => {
    expect(provider).toBe("bedrock");
  });

  it("builds a model client whose id is the configured Bedrock model id", () => {
    const client = factory({
      config: bedrockConfig(MODEL),
      env,
      promptVersion: "v",
    });
    expect(client.model).toBe(MODEL);
  });

  it("constructs the Bedrock client with the AWS region and the call budget, and records usage", async () => {
    process.env["AWS_REGION"] = "us-east-1";
    const seen: SeenRequest[] = [];
    const ctorSeen: CtorOpts[] = [];
    const messages = createBedrockMessagesFactory({
      region: "us-east-1",
      loadClient: async () => fakeBedrock(seen, ctorSeen) as never,
    });
    // Drive it through the core's AnthropicModel by building the client the same
    // way `factory` does, but with the injected transport.
    const { AnthropicModel } = await import("attestqa");
    const client = new AnthropicModel({
      apiKey: "",
      model: MODEL,
      promptVersion: "v",
      maxTokens: 2048,
      factory: messages,
    });

    const decision = await client.decide(input);
    expect(decision.usage.inputTokens).toBe(12);
    expect(decision.usage.outputTokens).toBe(5);
    expect(decision.calls).toEqual([]);
    expect(ctorSeen[0]?.awsRegion).toBe("us-east-1");
    expect(seen[0]?.model).toBe(MODEL);
    expect(seen[0]?.max_tokens).toBe(2048);
  });

  it("omits the region when none is configured, letting the SDK resolve it", async () => {
    const ctorSeen: CtorOpts[] = [];
    const messages = createBedrockMessagesFactory({
      loadClient: async () => fakeBedrock([], ctorSeen) as never,
    });
    await messages("");
    expect(ctorSeen[0]?.awsRegion).toBeUndefined();
  });
});

/**
 * Provider conformance over the Bedrock transport. Bedrock reuses the core's
 * AnthropicModel verbatim and swaps only the transport, so these checks confirm
 * the Bedrock path does not regress AnthropicModel's contract: a tool_use block
 * maps to the runtime's qualified name, an invented tool is dropped with a
 * warning, and a transport error surfaces instead of an empty decision.
 */
describe("@attestqa/provider-bedrock conformance", () => {
  it("maps a tool_use block back to the runtime's qualified name and records usage", async () => {
    const model = await bedrockModel([
      {
        content: [
          { type: "text", text: "reading the story" },
          { type: "tool_use", id: "t1", name: "pw__run_tests", input: { spec: "a.spec.ts" } },
        ],
        usage: { input_tokens: 9, output_tokens: 4 },
      },
    ]);
    const d = await model.decide(input);
    expect(d.calls).toEqual([{ toolName: "pw.run_tests", args: { spec: "a.spec.ts" } }]);
    expect(d.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("drops a tool the runtime never offered, with a warning", async () => {
    const warnings: string[] = [];
    const model = await bedrockModel(
      [{ content: [{ type: "tool_use", id: "t1", name: "fs__delete_everything", input: {} }] }],
      (m) => warnings.push(m),
    );
    const d = await model.decide(input);
    expect(d.calls).toEqual([]);
    expect(warnings.join(" ")).toMatch(/unknown tool/);
  });

  it("surfaces a Bedrock error instead of returning an empty decision", async () => {
    const model = await bedrockModel([new Error("throttled by Bedrock")]);
    await expect(model.decide(input)).rejects.toThrow(/throttled/);
  });
});

/**
 * The loader wiring, against this package's REAL exports. Every other loader
 * test uses a fake importer; this one drives the core's own `resolveModelPlugins`
 * with an importer that returns this package's actual module, proving the real
 * { provider, factory } exports satisfy the loader contract and that a client
 * built through the registry carries the configured model id. No network: the
 * Bedrock SDK is only loaded when a request is sent, which this test never does.
 */
describe("@attestqa/provider-bedrock loader wiring", () => {
  it("registers the bedrock provider from the real package exports", async () => {
    const { resolveModelPlugins, registeredProviderNames, buildModel } = await import("attestqa");
    await resolveModelPlugins({ agent: { model: { provider: "bedrock", name: MODEL } } }, env, {
      importer: async (spec: string) =>
        spec === "@attestqa/provider-bedrock" ? await import("../src/index.js") : import(spec),
    });
    expect(registeredProviderNames()).toContain("bedrock");
    const client = buildModel({ config: bedrockConfig(MODEL), env, promptVersion: "v" });
    expect(client.model).toBe(MODEL);
  });
});
