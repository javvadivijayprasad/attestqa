import type { RuntimeEnv } from "../config.js";
import { ConfigError } from "../config.js";
import type { ModelConfig } from "../types.js";
import { AnthropicModel } from "./anthropic.js";
import type { ModelClient } from "./model.js";
import { OpenAiCompatibleModel } from "./openai.js";
import { registeredProvider } from "./registry.js";
import type { TokenSource } from "./token.js";

export type { TokenSource, Token } from "./token.js";
export {
  registerProvider,
  registeredProviderNames,
  clearRegisteredProviders,
  type ProviderFactory,
} from "./registry.js";

/**
 * The one place a provider name becomes a model client.
 *
 * The CLI, the MCP server, the desktop app and a library caller all come
 * through here, so the rule "where does the credential for this provider come
 * from" is written once, and the error for a missing one names the variable or
 * the package rather than the symptom. `agent.model.provider` is set in the
 * config, once per environment; the credential comes from the environment or a
 * token source, never from the config file.
 */
export interface BuildModelOptions {
  config: ModelConfig;
  env: RuntimeEnv;
  promptVersion: string;
  /** AQA_MODEL, when set: overrides the model NAME, never the provider. */
  modelOverride?: string;
  /** Company sign-in. When present, it wins over any key in the environment. */
  tokenSource?: TokenSource;
  warn?: (message: string) => void;
}

/** Which environment variable each built-in provider reads its key from. */
export const CREDENTIAL_VAR: Record<string, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  gateway: "AQA_GATEWAY_API_KEY",
  "vscode-copilot": "AQA_VSCODE_LM_TOKEN",
  local: null,
};

/** The package that supplies a token source for each sign-in mode. */
const TOKEN_PACKAGE: Record<string, string> = {
  entra: "@attestqa/auth-azure",
  "aws-sso": "@attestqa/auth-aws",
};

/**
 * The environment variable a run will read its key from, or null when it reads
 * none (a local model, auth: none, or a token source).
 */
export function credentialVarFor(
  config: ModelConfig,
  hasTokenSource = false,
  env?: RuntimeEnv,
): string | null {
  const auth = config.auth ?? "key";
  if (auth !== "key" || hasTokenSource) return null;
  // Claude through a company gateway, the way Claude Code reaches it.
  if (config.provider === "anthropic" && env?.anthropicAuthToken && !env.anthropicApiKey)
    return "ANTHROPIC_AUTH_TOKEN";
  return CREDENTIAL_VAR[config.provider] ?? null;
}

/** Where calls to Claude go: agent.model.endpoint, else ANTHROPIC_BASE_URL, else the Anthropic API. */
export function anthropicBaseUrl(config: ModelConfig, env?: RuntimeEnv): string | undefined {
  return config.endpoint ?? env?.anthropicBaseUrl;
}

export function credentialFor(config: ModelConfig, env: RuntimeEnv): string | undefined {
  switch (config.provider) {
    case "anthropic":
      return env.anthropicApiKey || env.anthropicAuthToken || undefined;
    case "openai":
      return env.openaiApiKey;
    case "azure-openai":
      return env.azureOpenAiApiKey;
    case "gateway":
      return env.gatewayApiKey;
    case "vscode-copilot":
      return env.vscodeLmToken;
    case "local":
      return env.openaiApiKey; // optional: some local servers accept a bearer token
    default:
      return undefined;
  }
}

export function buildModel(opts: BuildModelOptions): ModelClient {
  const config: ModelConfig = opts.modelOverride
    ? { ...opts.config, name: opts.modelOverride }
    : opts.config;
  const warn = opts.warn ?? (() => {});

  const plugin = registeredProvider(config.provider);
  if (plugin) return plugin({ ...opts, config, warn });

  const auth = config.auth ?? "key";
  if ((auth === "entra" || auth === "aws-sso") && !opts.tokenSource)
    throw new ConfigError(
      `agent.model.auth is "${auth}", which needs a token source from ${TOKEN_PACKAGE[auth]}. ` +
        "Install it and sign in, or use auth: key with the provider's API key in the environment.",
    );
  if (opts.tokenSource && config.provider === "anthropic")
    throw new ConfigError(
      "provider anthropic takes an API key, not a sign-in token; remove agent.model.auth or use auth: key",
    );

  if (config.provider === "vscode-copilot" && !opts.env.vscodeLmEndpoint)
    throw new ConfigError(
      "agent.model.provider is vscode-copilot: GitHub Copilot is reached through the attestqa VS Code " +
        "extension. Run this story from VS Code (attestqa: Run story…); a terminal or CI process has no " +
        "supported way to reach Copilot — use another model route there (see the user guide, 'Which model').",
    );

  const key = opts.tokenSource || auth === "none" ? undefined : credentialFor(config, opts.env);
  const needs = credentialVarFor(config, Boolean(opts.tokenSource), opts.env);
  if (needs && !key)
    throw new ConfigError(
      `${needs} is not set — agent.model.provider is "${config.provider}", which reads its credential from ${needs}`,
    );

  if (config.provider === "anthropic") {
    const viaGateway = !opts.env.anthropicApiKey && Boolean(opts.env.anthropicAuthToken);
    const baseURL = anthropicBaseUrl(config, opts.env);
    return new AnthropicModel({
      apiKey: viaGateway ? "" : (key as string),
      ...(viaGateway ? { authToken: opts.env.anthropicAuthToken as string } : {}),
      ...(baseURL ? { baseURL } : {}),
      model: config.name,
      promptVersion: opts.promptVersion,
      warn,
    });
  }
  return new OpenAiCompatibleModel({
    config:
      config.provider === "vscode-copilot"
        ? { ...config, endpoint: opts.env.vscodeLmEndpoint as string }
        : config,
    ...(key ? { apiKey: key } : {}),
    ...(opts.tokenSource ? { tokenSource: opts.tokenSource } : {}),
    promptVersion: opts.promptVersion,
    warn,
  });
}

/** One line for the terminal: which provider, which model, where the credential comes from. */
export function describeModel(
  config: ModelConfig,
  tokenSource?: TokenSource,
  env?: RuntimeEnv,
): string {
  if (config.provider === "vscode-copilot")
    return `GitHub Copilot ${config.name} (through the attestqa VS Code extension)`;
  const base = config.provider === "anthropic" ? anthropicBaseUrl(config, env) : config.endpoint;
  const endpoint = base ? ` at ${base}` : "";
  const gatewayVar = credentialVarFor(config, Boolean(tokenSource), env);
  const auth = config.auth ?? "key";
  const where = tokenSource
    ? `sign-in: ${tokenSource.describe()}`
    : auth === "entra" || auth === "aws-sso"
      ? `sign-in: ${auth} (needs ${TOKEN_PACKAGE[auth]})`
      : auth === "none"
        ? "no credential"
        : gatewayVar
          ? `credential: ${gatewayVar}`
          : "no credential";
  return `${config.provider} ${config.name}${endpoint} (${where})`;
}
