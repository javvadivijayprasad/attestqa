import type { JiraConnection } from "./mcp/adapters/jira.js";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type {
  AgentConfig,
  CapabilitiesConfig,
  ModelAuth,
  ModelConfig,
  ModelProvider,
  PolicyDecision,
  PolicyTable,
  ScopeConfig,
} from "./types.js";
import { DEFAULT_CAPABILITIES, DEFAULT_POLICY, POLICY_CLASSES } from "./types.js";
import { isRegisteredProvider, registeredProviderNames } from "./runtime/registry.js";

/**
 * Loads the `agent:` section of `ai-quality.config.yaml` (PLAN §0.3). JSON is
 * accepted too (same shape) so tests and the platform can hand over a generated
 * file without a YAML dependency on their side.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const LLM_PROVIDERS = ["anthropic", "openai", "gemini"];
export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  "anthropic",
  "openai",
  "azure-openai",
  "local",
  "gateway",
];
export const MODEL_AUTHS: readonly ModelAuth[] = ["key", "none", "entra", "aws-sso"];

/** A built-in provider, or one a plug-in registered before the config was loaded. */
export function knownProvider(name: string): boolean {
  return (MODEL_PROVIDERS as readonly string[]).includes(name) || isRegisteredProvider(name);
}

/** Header names that carry credentials. They belong in the environment or a vault, never in config. */
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|password|cookie|^x-.*-key$/i;
export const DEFAULT_MODEL_NAME = "claude-sonnet-4-6";

export const DEFAULT_BUDGETS = { steps: 40, tokens: 400_000 };

export async function loadAgentConfig(file: string): Promise<AgentConfig> {
  const path = resolve(file);
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const raw = await parseConfigText(text, extname(path));
  return agentConfigFromObject(raw, path);
}

export async function parseConfigText(text: string, ext: string): Promise<unknown> {
  if (ext === ".json") return JSON.parse(text);
  // YAML — `yaml` is a runtime dependency; imported lazily so JSON users never load it.
  const { parse } = await import("yaml");
  return parse(text);
}

export function agentConfigFromObject(raw: unknown, source = "<config>"): AgentConfig {
  if (!isObject(raw)) throw new ConfigError(`${source}: top level must be a mapping`);
  const agent = raw["agent"];
  if (!isObject(agent)) throw new ConfigError(`${source}: missing "agent:" section`);

  const model = modelConfig(agent["model"], `${source}: agent.model`);
  const prompt_version = str(agent["prompt_version"]) ?? "aqa-prompt-v0.1.0";

  const b = isObject(agent["budgets"]) ? agent["budgets"] : {};
  const budgets = {
    steps: posInt(b["steps"], DEFAULT_BUDGETS.steps, `${source}: agent.budgets.steps`),
    tokens: posInt(b["tokens"], DEFAULT_BUDGETS.tokens, `${source}: agent.budgets.tokens`),
  };

  const s = agent["scope"];
  if (!isObject(s)) throw new ConfigError(`${source}: agent.scope is required`);
  const scope: ScopeConfig = {
    work_items: strList(s["work_items"], `${source}: agent.scope.work_items`),
    repos: strList(s["repos"], `${source}: agent.scope.repos`),
    test_plans: strList(s["test_plans"], `${source}: agent.scope.test_plans`),
    branches_writable: strList(s["branches_writable"], `${source}: agent.scope.branches_writable`),
    urls: strList(s["urls"], `${source}: agent.scope.urls`),
  };

  const p = isObject(agent["policy"]) ? agent["policy"] : {};
  const policy = { ...DEFAULT_POLICY } as PolicyTable;
  for (const cls of POLICY_CLASSES) {
    const v = p[cls];
    if (v === undefined) continue;
    if (v !== "execute" && v !== "ask" && v !== "refuse")
      throw new ConfigError(`${source}: agent.policy.${cls} must be execute | ask | refuse`);
    policy[cls] = v as PolicyDecision;
  }
  for (const key of Object.keys(p)) {
    if (!(POLICY_CLASSES as readonly string[]).includes(key))
      throw new ConfigError(`${source}: agent.policy has unknown class "${key}"`);
  }

  const c = isObject(agent["capabilities"]) ? agent["capabilities"] : {};
  const capabilities: CapabilitiesConfig = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(c)) {
    if (!(key in DEFAULT_CAPABILITIES))
      throw new ConfigError(`${source}: agent.capabilities has unknown key "${key}"`);
  }
  if (c["test_plans"] !== undefined) {
    if (typeof c["test_plans"] !== "boolean")
      throw new ConfigError(`${source}: agent.capabilities.test_plans must be true or false`);
    capabilities.test_plans = c["test_plans"];
  }

  let test_types: string[] | undefined;
  if (agent["test_types"] !== undefined) {
    const known = ["functional", "security", "accessibility", "confirmation"];
    const list = strList(agent["test_types"], `${source}: agent.test_types`);
    for (const t of list) {
      if (!known.includes(t))
        throw new ConfigError(
          `${source}: agent.test_types has unknown type "${t}" (known: ${known.join(", ")})`,
        );
    }
    test_types = list;
  }

  // bdd2pw's own LLM fallback for steps its deterministic rules cannot bind.
  // Named for what it is: a FALLBACK. The rule table is still tried first, and
  // this only decides whether an unbound step becomes a TODO or a generated
  // binding. The sidecar URL is not configurable here — it comes from the
  // environment (AI_GOVERNANCE_URL), so no config file can nominate where
  // prompts are sent.
  let llm_fallback: AgentConfig["llm_fallback"];
  if (agent["llm_fallback"] !== undefined) {
    const v = str(agent["llm_fallback"]);
    if (v === undefined || !LLM_PROVIDERS.includes(v))
      throw new ConfigError(
        `${source}: agent.llm_fallback must be one of ${LLM_PROVIDERS.join(", ")}`,
      );
    llm_fallback = v as AgentConfig["llm_fallback"];
  }

  return {
    model,
    prompt_version,
    budgets,
    scope,
    policy,
    capabilities,
    ...(test_types ? { test_types } : {}),
    ...(llm_fallback ? { llm_fallback } : {}),
  };
}

/**
 * `agent.model`, in either of its two forms.
 *
 *   model: claude-sonnet-4-6                 # the original: a name, Anthropic implied
 *   model:                                   # the seam: a provider, set once per environment
 *     provider: azure-openai
 *     name: gpt-4.1                          # deployment name on Azure
 *     endpoint: https://acme.openai.azure.com
 *     api_version: 2024-10-21
 *
 * The string form is kept so every existing config and every ledger in the
 * corpus still loads. It means exactly what it always meant.
 */
export function modelConfig(raw: unknown, where: string): ModelConfig {
  if (raw === undefined) return { provider: "anthropic", name: DEFAULT_MODEL_NAME };
  const asString = str(raw);
  if (asString !== undefined) return { provider: "anthropic", name: asString };
  if (!isObject(raw))
    throw new ConfigError(`${where} must be a model name or a mapping with provider and name`);

  const provider = str(raw["provider"]);
  if (provider === undefined || !knownProvider(provider))
    throw new ConfigError(
      `${where}.provider must be one of ${[...MODEL_PROVIDERS, ...registeredProviderNames()].join(", ")}`,
    );
  const name = str(raw["name"]);
  if (!name)
    throw new ConfigError(`${where}.name is required (the model, or on Azure the deployment)`);

  const endpoint = str(raw["endpoint"]);
  if ((provider === "azure-openai" || provider === "local" || provider === "gateway") && !endpoint)
    throw new ConfigError(
      `${where}.endpoint is required for provider ${provider}` +
        (provider === "azure-openai"
          ? " (the resource URL, e.g. https://<resource>.openai.azure.com)"
          : provider === "gateway"
            ? " (your company gateway's OpenAI-compatible base URL, e.g. https://llm-gateway.acme.internal/v1)"
            : " (e.g. http://localhost:11434/v1)"),
    );
  if (endpoint) {
    try {
      new URL(endpoint);
    } catch {
      throw new ConfigError(`${where}.endpoint is not a URL: ${endpoint}`);
    }
  }
  const api_version = str(raw["api_version"]);

  const auth = str(raw["auth"]);
  if (auth !== undefined && !(MODEL_AUTHS as readonly string[]).includes(auth))
    throw new ConfigError(`${where}.auth must be one of ${MODEL_AUTHS.join(", ")}`);

  let headers: Record<string, string> | undefined;
  if (raw["headers"] !== undefined) {
    if (provider !== "gateway")
      throw new ConfigError(`${where}.headers is only for provider gateway`);
    if (!isObject(raw["headers"]))
      throw new ConfigError(`${where}.headers must be a mapping of header name to value`);
    headers = {};
    for (const [k, v] of Object.entries(raw["headers"])) {
      if (SECRET_HEADER.test(k))
        throw new ConfigError(
          `${where}.headers.${k} looks like a credential. Config files are committed; put credentials in the environment (AQA_GATEWAY_API_KEY) or use auth: entra / aws-sso.`,
        );
      if (typeof v !== "string") throw new ConfigError(`${where}.headers.${k} must be a string`);
      headers[k] = v;
    }
  }

  return {
    provider: provider as ModelProvider,
    name,
    ...(endpoint ? { endpoint } : {}),
    ...(api_version ? { api_version } : {}),
    ...(auth ? { auth: auth as ModelAuth } : {}),
    ...(headers ? { headers } : {}),
  };
}

// ---------------------------------------------------------------------------
// .env loader (tiny, dependency-free). Never logs values.
// ---------------------------------------------------------------------------

export function loadDotEnv(file = ".env", env: NodeJS.ProcessEnv = process.env): string[] {
  const path = resolve(file);
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    // Standard dotenv precedence: a variable already in the environment wins.
    // An EMPTY ambient variable does not, though — `setx FOO ""` leaves a
    // defined-but-blank value that would otherwise shadow a real one in the
    // file and fail later as "not set", which is a maddening way to lose an
    // afternoon.
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/** The environment the runtime needs (PLAN §0.2). Values are never printed. */
export interface RuntimeEnv {
  anthropicApiKey: string;
  /** OPENAI_API_KEY — for provider openai, and for local servers that want one. */
  openaiApiKey?: string;
  /** AZURE_OPENAI_API_KEY — for provider azure-openai. */
  azureOpenAiApiKey?: string;
  /** AQA_GATEWAY_API_KEY — for provider gateway, when the gateway takes a key. */
  gatewayApiKey?: string;
  model?: string;
  azureDevOps?: { orgUrl: string; org: string; pat: string; project: string };
  /**
   * Jira, from JIRA_BASE_URL plus either JIRA_EMAIL + JIRA_API_TOKEN (Cloud,
   * basic auth) or JIRA_PAT (Data Center, bearer). Read-only except Bug
   * creation; see mcp/adapters/jira.ts.
   */
  jira?: JiraConnection;
  tcgUrl?: string;
  governanceUrl?: string;
  synthdataCmd?: string;
  sandbox: boolean;
}

export function readRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { requireAnthropic?: boolean } = {},
): RuntimeEnv {
  const key = env["ANTHROPIC_API_KEY"];
  if (opts.requireAnthropic !== false && !key)
    throw new ConfigError("ANTHROPIC_API_KEY is not set");
  const orgUrl = env["AZURE_DEVOPS_ORG_URL"];
  let azureDevOps: RuntimeEnv["azureDevOps"];
  if (orgUrl) {
    const pat = env["AZURE_DEVOPS_PAT"];
    const project = env["AZURE_DEVOPS_PROJECT"];
    if (!pat) throw new ConfigError("AZURE_DEVOPS_PAT is not set (AZURE_DEVOPS_ORG_URL is)");
    if (!project)
      throw new ConfigError("AZURE_DEVOPS_PROJECT is not set (AZURE_DEVOPS_ORG_URL is)");
    azureDevOps = { orgUrl, org: orgNameFromUrl(orgUrl), pat, project };
  }
  const out: RuntimeEnv = { anthropicApiKey: key ?? "", sandbox: env["AQA_SANDBOX"] === "1" };
  if (env["OPENAI_API_KEY"]) out.openaiApiKey = env["OPENAI_API_KEY"];
  if (env["AZURE_OPENAI_API_KEY"]) out.azureOpenAiApiKey = env["AZURE_OPENAI_API_KEY"];
  if (env["AQA_GATEWAY_API_KEY"]) out.gatewayApiKey = env["AQA_GATEWAY_API_KEY"];
  if (env["AQA_MODEL"]) out.model = env["AQA_MODEL"];
  if (azureDevOps) out.azureDevOps = azureDevOps;
  const jira = readJiraEnv(env);
  if (jira) out.jira = jira;
  if (env["TCG_URL"]) out.tcgUrl = env["TCG_URL"];
  if (env["AI_GOVERNANCE_URL"]) out.governanceUrl = env["AI_GOVERNANCE_URL"];
  if (env["SYNTHDATA_CMD"]) out.synthdataCmd = env["SYNTHDATA_CMD"];
  return out;
}

/**
 * The Jira connection from the environment, or undefined when JIRA_BASE_URL is
 * not set. Credentials come from the environment (normally the git-ignored
 * .env) and nowhere else — never from the config file, a work item or an
 * argument.
 */
export function readJiraEnv(env: NodeJS.ProcessEnv): JiraConnection | undefined {
  const baseUrl = env["JIRA_BASE_URL"];
  if (!baseUrl) return undefined;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new ConfigError(`JIRA_BASE_URL is not a URL: ${baseUrl}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new ConfigError(
      "JIRA_BASE_URL must be https (plain http is accepted only for localhost) — the token travels on every request",
    );
  const pat = env["JIRA_PAT"];
  const email = env["JIRA_EMAIL"];
  const token = env["JIRA_API_TOKEN"];
  if (pat && token)
    throw new ConfigError(
      "set JIRA_PAT (Data Center) or JIRA_EMAIL + JIRA_API_TOKEN (Cloud), not both",
    );
  let auth: JiraConnection["auth"];
  if (pat) auth = { kind: "bearer", token: pat };
  else if (email && token) auth = { kind: "basic", email, token };
  else
    throw new ConfigError(
      "JIRA_BASE_URL is set but no credential is: set JIRA_EMAIL and JIRA_API_TOKEN (Cloud) " +
        "or JIRA_PAT (Data Center)",
    );
  const versionRaw = env["JIRA_API_VERSION"];
  let apiVersion: 2 | 3 = pat ? 2 : 3;
  if (versionRaw) {
    if (versionRaw !== "2" && versionRaw !== "3")
      throw new ConfigError(`JIRA_API_VERSION must be 2 or 3, not "${versionRaw}"`);
    apiVersion = versionRaw === "2" ? 2 : 3;
  }
  const out: JiraConnection = { baseUrl: baseUrl.replace(/\/+$/, ""), auth, apiVersion };
  const ac = env["JIRA_AC_FIELD"];
  if (ac) {
    if (!/^customfield_\d+$/.test(ac))
      throw new ConfigError(`JIRA_AC_FIELD must look like customfield_10042, not "${ac}"`);
    out.acceptanceCriteriaField = ac;
  }
  return out;
}

/** `https://dev.azure.com/jvijayprasad` → `jvijayprasad`; `https://org.visualstudio.com` → `org`. */
export function orgNameFromUrl(orgUrl: string): string {
  const u = new URL(orgUrl);
  if (u.hostname === "dev.azure.com") {
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg) throw new ConfigError(`AZURE_DEVOPS_ORG_URL has no organisation segment: ${orgUrl}`);
    return seg;
  }
  const m = /^([^.]+)\.visualstudio\.com$/.exec(u.hostname);
  if (m?.[1]) return m[1];
  throw new ConfigError(`AZURE_DEVOPS_ORG_URL is not a recognised Azure DevOps URL: ${orgUrl}`);
}

// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function posInt(v: unknown, dflt: number, where: string): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    throw new ConfigError(`${where} must be a positive integer`);
  return v;
}
function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" || typeof x === "number"))
    throw new ConfigError(`${where} must be a list of strings`);
  return v.map(String);
}
