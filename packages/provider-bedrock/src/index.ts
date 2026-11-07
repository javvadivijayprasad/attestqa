/**
 * AWS Bedrock provider plug-in for attestqa.
 *
 * `agent.model.provider: bedrock` runs the agent on Claude through Amazon
 * Bedrock. The core's loader imports this package by convention and registers
 * the `bedrock` provider; `buildModel` then calls `factory` below.
 *
 * Authentication is the AWS credential chain, resolved inside the Bedrock SDK:
 * environment variables, a shared profile (`AWS_PROFILE`), the SSO cache written
 * by `aws sso login`, or an instance/task role. attestqa stores no API key — the
 * "no stored key" company sign-in for AWS. Requests are signed with SigV4, not a
 * bearer token, so there is no `TokenSource` here; a sign-in `auth` mode set on a
 * Bedrock model is ignored in favour of the chain.
 *
 * Only the transport differs from a direct Anthropic run: all message assembly,
 * tool-call mapping, usage accounting and ret/timeout behaviour are the core's
 * own `AnthropicModel`, so a Bedrock run and an Anthropic run behave identically
 * towards the runtime (the provider-conformance contract).
 */

import {
  AnthropicModel,
  type BuildModelOptions,
  type MessagesApi,
  type MessagesFactory,
  type ModelClient,
  type ProviderFactory,
} from "attestqa";

/** The provider name this package answers to; the loader registers it under this. */
export const provider = "bedrock";

/** The slice of `@anthropic-ai/bedrock-sdk`'s client this plug-in uses. */
interface BedrockClient {
  messages: MessagesApi;
}

type BedrockCtor = new (opts: {
  awsRegion?: string;
  timeout?: number;
  maxRetries?: number;
}) => BedrockClient;

/** The AWS region for Bedrock, from the standard AWS variables; the SDK resolves it when unset. */
function resolveRegion(): string | undefined {
  return process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? undefined;
}

export interface BedrockFactoryOptions {
  /** AWS region; when unset the Bedrock SDK resolves it from the environment/profile. */
  region?: string;
  /** Injected for tests; the default loads `@anthropic-ai/bedrock-sdk` lazily. */
  loadClient?: () => Promise<BedrockCtor>;
}

/**
 * A `MessagesFactory` backed by Amazon Bedrock. The API key argument is unused —
 * Bedrock authenticates with AWS credentials — and the connection argument does
 * not apply (no base URL or workspace header on Bedrock).
 */
export function createBedrockMessagesFactory(opts: BedrockFactoryOptions = {}): MessagesFactory {
  const loadClient =
    opts.loadClient ??
    (async () => {
      const mod = (await import("@anthropic-ai/bedrock-sdk")) as unknown as {
        AnthropicBedrock: BedrockCtor;
      };
      return mod.AnthropicBedrock;
    });
  return async (_apiKey, transport) => {
    const Ctor = await loadClient();
    const client = new Ctor({
      ...(opts.region ? { awsRegion: opts.region } : {}),
      ...(transport?.timeoutMs ? { timeout: transport.timeoutMs } : {}),
      ...(transport?.maxRetries !== undefined ? { maxRetries: transport.maxRetries } : {}),
    });
    return client.messages;
  };
}

/**
 * The provider plug-in. `agent.model.name` is the Bedrock model id — for example
 * `anthropic.claude-3-5-sonnet-20241022-v2:0`, or a cross-region inference
 * profile id such as `us.anthropic.claude-3-5-sonnet-20241022-v2:0`.
 */
export const factory: ProviderFactory = (opts: BuildModelOptions): ModelClient => {
  const region = resolveRegion();
  return new AnthropicModel({
    apiKey: "", // Bedrock signs with AWS credentials; there is no API key.
    model: opts.config.name,
    promptVersion: opts.promptVersion,
    ...(opts.maxOutputTokens ? { maxTokens: opts.maxOutputTokens } : {}),
    ...(opts.warn ? { warn: opts.warn } : {}),
    factory: createBedrockMessagesFactory({ ...(region ? { region } : {}) }),
  });
};
