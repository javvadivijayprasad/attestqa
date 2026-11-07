/**
 * Loading the provider and sign-in plug-ins the config names.
 *
 * The seam (provider.ts, registry.ts, token.ts) is built into the core, but the
 * packages that fill it — a Bedrock provider, an Entra ID or AWS SSO sign-in —
 * are optional and live outside it, so a company that does not use them never
 * installs the AWS or Azure SDK. This module is the one place that turns a name
 * in the config into a loaded package:
 *
 *   - `agent.model.provider: bedrock`  → import `@attestqa/provider-bedrock`,
 *     which registers the `bedrock` provider (registry.ts) so the config
 *     validator then recognises it. `knownProvider` already allows "one a
 *     plug-in registered before the config was loaded" — this is what loads it.
 *   - `agent.model.auth: entra | aws-sso` → import the matching auth package and
 *     ask it for a TokenSource, which `buildModel` uses instead of a stored key.
 *
 * It runs BEFORE the config is validated, from the raw parsed object, because
 * validation rejects an unregistered provider. It reads only the two names it
 * needs and leaves every other error to the real validator. The importer is
 * injectable so the loader is testable without publishing a package.
 */

import { ConfigError, MODEL_PROVIDERS, type RuntimeEnv } from "../config.js";
import type { ModelConfig } from "../types.js";
import { isRegisteredProvider, registerProvider, type ProviderFactory } from "./registry.js";
import { TOKEN_PACKAGE, providerPackage } from "./provider.js";
import type { TokenSource } from "./token.js";

/** How a module is loaded. The default is a dynamic `import`; tests pass a stub. */
export type Importer = (specifier: string) => Promise<unknown>;
const dynamicImport: Importer = (specifier) => import(specifier);

/**
 * What a provider plug-in package exports: the provider name it answers to and
 * the factory that builds its model client. The loader registers the pair.
 */
export interface ProviderPluginModule {
  provider: string;
  factory: ProviderFactory;
}

/** What an auth plug-in is handed so it can read its non-secret settings (region, tenant, scope). */
export interface AuthOptions {
  env: RuntimeEnv;
  model: ModelConfig;
  warn: (message: string) => void;
}

/** What an auth plug-in package exports: a factory that signs in and returns a TokenSource. */
export interface AuthPluginModule {
  createTokenSource(options: AuthOptions): Promise<TokenSource>;
}

function isProviderPlugin(mod: unknown): mod is ProviderPluginModule {
  const m = mod as Record<string, unknown> | null;
  return !!m && typeof m["provider"] === "string" && typeof m["factory"] === "function";
}

function isAuthPlugin(mod: unknown): mod is AuthPluginModule {
  const m = mod as Record<string, unknown> | null;
  return !!m && typeof m["createTokenSource"] === "function";
}

/** A dynamic import that turns "module not found" into the install hint the seam already uses. */
async function importPackage(pkg: string, why: string, importer: Importer): Promise<unknown> {
  try {
    return await importer(pkg);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      throw new ConfigError(
        `${why} needs the package ${pkg}, which is not installed. Run: npm i ${pkg}`,
      );
    throw err;
  }
}

/**
 * Ensure a provider the config names is available: a built-in, an already
 * registered one, or a plug-in loaded here by convention. A no-op for the ones
 * the core builds in.
 */
export async function ensureProvider(
  name: string,
  importer: Importer = dynamicImport,
): Promise<void> {
  if ((MODEL_PROVIDERS as readonly string[]).includes(name) || isRegisteredProvider(name)) return;
  const pkg = providerPackage(name);
  const mod = await importPackage(pkg, `agent.model.provider "${name}"`, importer);
  if (!isProviderPlugin(mod))
    throw new ConfigError(
      `${pkg} is installed but does not export a provider plug-in (a { provider, factory } pair)`,
    );
  if (mod.provider !== name)
    throw new ConfigError(
      `agent.model.provider is "${name}" but ${pkg} registers the provider "${mod.provider}"`,
    );
  registerProvider(mod.provider, mod.factory);
}

/** Load the auth plug-in for a sign-in mode and build its TokenSource. */
export async function loadTokenSource(
  auth: string,
  options: AuthOptions,
  importer: Importer = dynamicImport,
): Promise<TokenSource> {
  const pkg = TOKEN_PACKAGE[auth];
  if (!pkg) throw new ConfigError(`agent.model.auth "${auth}" has no sign-in package`);
  const mod = await importPackage(pkg, `agent.model.auth "${auth}"`, importer);
  if (!isAuthPlugin(mod))
    throw new ConfigError(`${pkg} is installed but does not export createTokenSource()`);
  return mod.createTokenSource(options);
}

/** The model provider and auth names, read defensively from the raw config. */
function modelNames(raw: unknown): { provider?: string; auth?: string } {
  const agent = (raw as { agent?: unknown })?.agent as { model?: unknown } | undefined;
  const model = agent?.model;
  if (typeof model === "string" || model == null) return {};
  const m = model as Record<string, unknown>;
  return {
    ...(typeof m["provider"] === "string" ? { provider: m["provider"] } : {}),
    ...(typeof m["auth"] === "string" ? { auth: m["auth"] } : {}),
  };
}

export interface ResolvedPlugins {
  tokenSource?: TokenSource;
}

/**
 * The one call the CLI (and the app) make before validating the config: load
 * any provider plug-in the config names, and sign in if it asks for it. Returns
 * the TokenSource to pass to buildModel. Reads only the provider and auth names;
 * every other field is left to the config validator that runs next.
 */
export async function resolveModelPlugins(
  raw: unknown,
  env: RuntimeEnv,
  opts: { warn?: (message: string) => void; importer?: Importer; signIn?: boolean } = {},
): Promise<ResolvedPlugins> {
  const warn = opts.warn ?? (() => {});
  const importer = opts.importer ?? dynamicImport;
  const signIn = opts.signIn ?? true;
  const { provider, auth } = modelNames(raw);

  // A plug-in provider must be registered before the config validator checks
  // the name — always, even on a dry run or a rules-only command.
  if (provider) await ensureProvider(provider, importer);

  // Signing in is a network, often interactive, step and builds no model on a
  // dry run or a rules check, so it is skipped unless a real run asks for it.
  if (signIn && (auth === "entra" || auth === "aws-sso")) {
    const model = (raw as { agent?: { model?: ModelConfig } })?.agent?.model ?? ({} as ModelConfig);
    const tokenSource = await loadTokenSource(auth, { env, model, warn }, importer);
    return { tokenSource };
  }
  return {};
}
