import type { RuntimeEnv } from "../config.js";
import { ConfigError } from "../config.js";
import type { ModelConfig } from "../types.js";
import { AnthropicModel } from "./anthropic.js";
import type { ModelClient } from "./model.js";
import { OpenAiCompatibleModel } from "./openai.js";

/**
 * The one place a provider name becomes a model client.
 *
 * The CLI, the MCP server and a library caller all come through here, so the
 * rule "which environment variable carries the credential for which provider"
 * is written once and the error for a missing one names the variable rather
 * than the symptom. `agent.model.provider` is set in the config, once per
 * environment; the credential comes from the environment where the runtime
 * runs and never from the config file.
 */
export interface BuildModelOptions {
  config: ModelConfig;
  env: RuntimeEnv;
  promptVersion: string;
  /** AQA_MODEL, when set: overrides the model NAME, never the provider. */
  modelOverride?: string;
  warn?: (message: string) => void;
}

/** Which environment variable each provider reads its credential from. */
export const CREDENTIAL_VAR: Record<ModelConfig["provider"], string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  local: null,
};

export function credentialFor(config: ModelConfig, env: RuntimeEnv): string | undefined {
  switch (config.provider) {
    case "anthropic":
      return env.anthropicApiKey || undefined;
    case "openai":
      return env.openaiApiKey;
    case "azure-openai":
      return env.azureOpenAiApiKey;
    case "local":
      return env.openaiApiKey; // optional: some local servers accept a bearer token
  }
}

export function buildModel(opts: BuildModelOptions): ModelClient {
  const config: ModelConfig = opts.modelOverride
    ? { ...opts.config, name: opts.modelOverride }
    : opts.config;
  const key = credentialFor(config, opts.env);
  const needs = CREDENTIAL_VAR[config.provider];
  if (needs && !key)
    throw new ConfigError(
      `${needs} is not set — agent.model.provider is "${config.provider}", which reads its credential from ${needs}`,
    );

  const warn = opts.warn ?? (() => {});
  if (config.provider === "anthropic")
    return new AnthropicModel({
      apiKey: key as string,
      model: config.name,
      promptVersion: opts.promptVersion,
      warn,
    });
  return new OpenAiCompatibleModel({
    config,
    ...(key ? { apiKey: key } : {}),
    promptVersion: opts.promptVersion,
    warn,
  });
}

/** One line for the terminal: which provider, which model, which variable the key came from. */
export function describeModel(config: ModelConfig): string {
  const where = CREDENTIAL_VAR[config.provider];
  const endpoint = config.endpoint ? ` at ${config.endpoint}` : "";
  return `${config.provider} ${config.name}${endpoint}${where ? ` (credential: ${where})` : " (no credential)"}`;
}
