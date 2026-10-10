import type { BuildModelOptions } from "./provider.js";
import type { ModelClient } from "./model.js";

/**
 * Providers added by plug-ins (for example @attestqa/provider-bedrock).
 *
 * Kept in its own module, with no runtime imports, so the config loader can ask
 * "is this provider known?" without importing the provider builders. A plug-in
 * registers once at start-up, before the config is loaded; the core never
 * imports a plug-in, so a company that does not use Bedrock never installs the
 * AWS SDK.
 */
export type ProviderFactory = (options: BuildModelOptions) => ModelClient;

const registry = new Map<string, ProviderFactory>();

const BUILT_IN = new Set(["anthropic", "openai", "azure-openai", "local", "gateway"]);

export function registerProvider(name: string, factory: ProviderFactory): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`provider name "${name}" must be lower-case letters, digits and hyphens`);
  if (BUILT_IN.has(name)) throw new Error(`provider "${name}" is built in and cannot be replaced`);
  registry.set(name, factory);
}

export function registeredProvider(name: string): ProviderFactory | undefined {
  return registry.get(name);
}

export function isRegisteredProvider(name: string): boolean {
  return registry.has(name);
}

export function registeredProviderNames(): string[] {
  return [...registry.keys()].sort();
}

/** For tests: forget every registered provider. */
export function clearRegisteredProviders(): void {
  registry.clear();
}
