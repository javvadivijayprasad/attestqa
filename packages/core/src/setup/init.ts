import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `aqa init`: set up a Playwright project for attestqa in one step.
 *
 * A new user otherwise had to find the example config inside the installed
 * package, copy it and edit it by hand — the step most likely to stop them.
 * This writes the two files a run needs, with the right names, and nothing
 * else: `ai-quality.config.yaml` (no secrets; meant to be committed) and a
 * `.env` holding EMPTY credential lines for the user to fill in. It never
 * writes a value it was not given, never reads a value out of an existing
 * `.env`, and never overwrites a file unless asked to.
 */

import type { Tracker } from "../design/ids.js";
export type { Tracker };

export interface InitOptions {
  /** The Playwright project folder; the files are written here. */
  dir: string;
  tracker: Tracker;
  /** Jira: a project key ("SHOP"). Azure DevOps: an id or a range ("100-199"). */
  scope: string;
  /** Where the application under test runs, e.g. http://localhost:3000. */
  url: string;
  /** How the company reaches a model. Default: Claude with an Anthropic API key. */
  model?: ModelRoute;
  /** Gateway / Azure OpenAI address; for claude-gateway, ANTHROPIC_BASE_URL (optional). */
  modelEndpoint?: string;
  /** The model name the gateway exposes, or the Azure OpenAI deployment name. */
  modelName?: string;
  /** Overwrite an existing ai-quality.config.yaml. Never applies to .env. */
  force?: boolean;
  /** The process environment, checked for which names are set — never for values. */
  env?: NodeJS.ProcessEnv;
}

/**
 * How a company reaches a model. Most do not hand out personal Anthropic keys:
 * Claude arrives through the company's LLM gateway (the route Claude Code is
 * configured with), or a model through Azure OpenAI or an OpenAI-compatible
 * gateway — or GitHub Copilot, which is reachable only inside VS Code, through the
 * attestqa extension (VS Code's Language Model API); a terminal process has no
 * supported access to it.
 */
export type ModelRoute = "anthropic" | "claude-gateway" | "azure-openai" | "gateway" | "copilot";
export const MODEL_ROUTES: readonly ModelRoute[] = [
  "anthropic",
  "claude-gateway",
  "azure-openai",
  "gateway",
  "copilot",
];

export function modelRoute(raw: string): ModelRoute {
  const s = raw.trim().toLowerCase();
  const byNumber: Record<string, ModelRoute> = {
    "1": "anthropic",
    "2": "claude-gateway",
    "3": "azure-openai",
    "4": "gateway",
    "5": "copilot",
  };
  const r = byNumber[s] ?? (MODEL_ROUTES as readonly string[]).find((m) => m === s);
  if (!r)
    throw new Error(`"${raw}" is not a model route — one of ${MODEL_ROUTES.join(", ")} (or 1-5).`);
  return r as ModelRoute;
}

function modelBlock(o: Pick<InitOptions, "model" | "modelEndpoint" | "modelName">): string {
  const route = o.model ?? "anthropic";
  if (route === "anthropic")
    return `  # Claude with an Anthropic API key (ANTHROPIC_API_KEY in .env).
  model: claude-sonnet-4-6`;
  if (route === "copilot")
    return `  # GitHub Copilot, through the attestqa VS Code extension: run stories from VS Code
  # (attestqa: Run story…). The extension asks once for your consent to use Copilot and
  # relays the calls; usage counts against your Copilot plan and its token figures are
  # estimates. A terminal or CI run cannot reach Copilot: use another route there.
  model:
    provider: vscode-copilot
    name: ${o.modelName?.trim() || "auto"} # a Copilot model family, or auto for VS Code's first`;
  if (route === "claude-gateway")
    return `  # Claude through your company's LLM gateway — the same two settings Claude Code
  # uses: ANTHROPIC_BASE_URL (the gateway) and ANTHROPIC_AUTH_TOKEN (your gateway
  # credential). If Claude Code already works on this machine through the gateway,
  # attestqa picks them up from the environment. Use the model name the gateway accepts.
  model: ${o.modelName?.trim() || "claude-sonnet-4-6"}`;
  const endpoint = normaliseUrl(o.modelEndpoint ?? "");
  const name = o.modelName?.trim();
  if (!name)
    throw new Error(
      route === "azure-openai"
        ? "Azure OpenAI needs the deployment name (--model-name)"
        : "a company gateway needs the model name it exposes (--model-name)",
    );
  if (route === "azure-openai")
    return `  # Azure OpenAI (AZURE_OPENAI_API_KEY in .env, or company sign-in: see the guide).
  model:
    provider: azure-openai
    name: ${name} # the deployment name
    endpoint: ${endpoint}
    api_version: 2024-10-21`;
  return `  # Your company's OpenAI-compatible gateway (AQA_GATEWAY_API_KEY in .env if it takes a key).
  model:
    provider: gateway
    name: ${name}
    endpoint: ${endpoint}`;
}

export interface InitResult {
  written: string[];
  kept: string[];
  notes: string[];
}

export const CONFIG_FILE = "ai-quality.config.yaml";

/** Turn what the user typed into a work_items entry, or say why it will not do. */
export function scopeEntry(tracker: Tracker, raw: string): string {
  const s = raw.trim();
  if (tracker === "jira") {
    const key = s.replace(/-\*$/, "").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]+$/.test(key))
      throw new Error(`"${raw}" is not a Jira project key (letters and digits, e.g. SHOP)`);
    return `${key}-*`;
  }
  if (!/^\d+(-\d+)?$/.test(s))
    throw new Error(`"${raw}" is not an Azure DevOps work item id or range (e.g. 1 or 100-199)`);
  return s;
}

export function normaliseUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`"${raw}" is not a URL (e.g. http://localhost:3000)`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`"${raw}" must start with http:// or https://`);
  return s;
}

export function renderConfig(
  o: Pick<InitOptions, "tracker" | "scope" | "url" | "model" | "modelEndpoint" | "modelName">,
): string {
  const work = scopeEntry(o.tracker, o.scope);
  const url = normaliseUrl(o.url);
  const jira = o.tracker === "jira";
  return `# attestqa — what the agent may do, and where. Written by \`aqa init\`.
# No secrets go in this file: credentials live in .env. Commit this file.
# Full reference: https://github.com/javvadivijayprasad/attestqa/blob/main/packages/core/docs/USAGE.md
agent:
${modelBlock(o)}
  prompt_version: aqa-prompt-v0.1.0
  budgets:
    steps: 150
    tokens: 1500000
  # The kinds of test every design must cover, or exclude with a reason.
  # accessibility needs @axe-core/playwright in this project.
  test_types: ["functional", "security", "accessibility", "confirmation"]
  # Ask before the first run of the suite in each run (re-runs after a repair go ahead).
  approve_execution: true
  scope:
    # The stories the agent may read and work on. A story outside this list is
    # refused before anything is spent.${jira ? " Jira: a project key with -*." : " Azure DevOps: ids or ranges."}
    work_items: ["${work}"]
    repos: []
    test_plans: []${jira ? " # Jira keeps no test plans" : ""}
    branches_writable: ["agent/*"]
    # Where the agent may point a browser. Empty means no browsing at all.
    urls: ["${url}"]
  capabilities:
${
  jira
    ? "    test_plans: false # Jira has no test plans; test cases go to the story's QA sub-task"
    : "    # Test plans and suites need the paid Test Plans access level in Azure DevOps.\n    # With Basic access leave this false: test cases are linked to the story instead.\n    test_plans: false"
}
  policy:
    read: execute
    write_workspace: execute # writing tests in this project
    write_branch: ask
    write_record: ask # anything written to ${jira ? "Jira" : "Azure DevOps"} asks you first
    destructive: refuse
`;
}

const MODEL_VARS: Record<ModelRoute, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  "claude-gateway": ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  "azure-openai": ["AZURE_OPENAI_API_KEY"],
  gateway: ["AQA_GATEWAY_API_KEY"],
  copilot: [],
};

export function envNames(tracker: Tracker, model: ModelRoute = "anthropic"): string[] {
  return [
    ...MODEL_VARS[model],
    ...(tracker === "jira"
      ? ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]
      : ["AZURE_DEVOPS_ORG_URL", "AZURE_DEVOPS_PROJECT", "AZURE_DEVOPS_PAT"]),
    "AQA_APP_URL",
    "AQA_APP_USER",
    "AQA_APP_PASS",
  ];
}

function modelEnv(model: ModelRoute, endpoint?: string): string {
  switch (model) {
    case "anthropic":
      return "# The model: Claude with an Anthropic API key\nANTHROPIC_API_KEY=";
    case "claude-gateway":
      return (
        "# The model: Claude through your company's gateway — the same values Claude Code uses.\n" +
        "# If Claude Code already works on this machine through the gateway, these are set in\n" +
        "# your environment already and you can delete both lines.\n" +
        `ANTHROPIC_BASE_URL=${endpoint ? normaliseUrl(endpoint) : ""}\nANTHROPIC_AUTH_TOKEN=`
      );
    case "azure-openai":
      return "# The model: Azure OpenAI\nAZURE_OPENAI_API_KEY=";
    case "gateway":
      return "# The model: your company's OpenAI-compatible gateway (leave empty if it takes no key)\nAQA_GATEWAY_API_KEY=";
    case "copilot":
      return "# The model: GitHub Copilot — nothing to set here; the attestqa VS Code extension\n# supplies the connection when you run a story from VS Code.";
  }
}

export function renderEnv(
  tracker: Tracker,
  url: string,
  model: ModelRoute = "anthropic",
  modelEndpoint?: string,
): string {
  const jira = tracker === "jira";
  return `# attestqa credentials — written by \`aqa init\`. NEVER commit this file.
# Fill in each value. Test accounts only.

${modelEnv(model, modelEndpoint)}

${
  jira
    ? `# Jira Cloud (an API token from id.atlassian.com → Security → API tokens)
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=
JIRA_API_TOKEN=
# Jira Data Center instead: JIRA_PAT=`
    : `# Azure DevOps (a PAT with Work Items: Read & write, Test Management: Read & write)
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org
AZURE_DEVOPS_PROJECT=
AZURE_DEVOPS_PAT=`
}

# The application under test — read by playwright.config.ts, never written into a test
AQA_APP_URL=${normaliseUrl(url)}
AQA_APP_USER=
AQA_APP_PASS=
`;
}

const IGNORE_LINES = [".env", ".env.*", "!.env.example", ".aqa/"];

/** Lines .gitignore is missing, so credentials and run records stay out of git. */
export function missingIgnores(gitignore: string): string[] {
  const have = new Set(gitignore.split(/\r?\n/).map((l) => l.trim()));
  return IGNORE_LINES.filter((l) => !have.has(l));
}

/** Names (never values) that an existing .env does not set yet. */
export function unsetNames(env: string, names: string[]): string[] {
  const set = new Set<string>();
  for (const line of env.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(\S.*)?$/.exec(line);
    // The placeholders `aqa init` writes (your-site, your-org) are not values.
    if (m && m[2] && !/your-(site|org)/.test(m[2]) && !line.trim().startsWith("#")) set.add(m[1]!);
  }
  return names.filter((n) => !set.has(n));
}

export function runInit(o: InitOptions): InitResult {
  const result: InitResult = { written: [], kept: [], notes: [] };
  const config = renderConfig(o); // validates scope and url before anything is written
  const cfgPath = join(o.dir, CONFIG_FILE);
  if (existsSync(cfgPath) && !o.force) {
    result.kept.push(CONFIG_FILE);
    result.notes.push(`${CONFIG_FILE} already exists — left as it is (add --force to replace it)`);
  } else {
    writeFileSync(cfgPath, config, "utf8");
    result.written.push(CONFIG_FILE);
  }

  const envPath = join(o.dir, ".env");
  const names = envNames(o.tracker, o.model);
  if (existsSync(envPath)) {
    result.kept.push(".env");
    const unset = unsetNames(readFileSync(envPath, "utf8"), names);
    if (unset.length)
      result.notes.push(
        `.env exists and was not touched; it does not set yet: ${unset.join(", ")}`,
      );
  } else {
    writeFileSync(envPath, renderEnv(o.tracker, o.url, o.model, o.modelEndpoint), "utf8");
    result.written.push(".env");
    const prefilled = new Set(["AQA_APP_URL"]);
    if (o.model === "claude-gateway" && o.modelEndpoint) prefilled.add("ANTHROPIC_BASE_URL");
    // Claude Code's gateway settings may already be in this environment: say so by
    // name, so nobody pastes a token that is not needed. Values are never read.
    const already = (o.env ? names.filter((n) => Boolean(o.env?.[n])) : []).filter((n) =>
      n.startsWith("ANTHROPIC_"),
    );
    for (const n of already) prefilled.add(n);
    if (already.length)
      result.notes.push(
        `${already.join(" and ")} already set in this environment (as Claude Code uses them) — no need to repeat in .env`,
      );
    result.notes.push(
      `fill in the empty values in .env: ${names.filter((n) => !prefilled.has(n)).join(", ")}`,
    );
  }

  const giPath = join(o.dir, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const add = missingIgnores(gi);
  if (add.length) {
    const sep = gi === "" || gi.endsWith("\n") ? "" : "\n";
    writeFileSync(
      giPath,
      `${gi}${sep}${gi ? "\n" : ""}# attestqa: credentials and run records stay out of git\n${add.join("\n")}\n`,
      "utf8",
    );
    result.written.push(".gitignore");
  }

  const hasPlaywright = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
  ].some((f) => existsSync(join(o.dir, f)));
  if (!hasPlaywright)
    result.notes.push(
      "no playwright.config.* here — attestqa writes tests into a Playwright project; create one with `npm init playwright@latest` in this folder",
    );
  else {
    const pkg = existsSync(join(o.dir, "package.json"))
      ? readFileSync(join(o.dir, "package.json"), "utf8")
      : "";
    if (!pkg.includes("@axe-core/playwright"))
      result.notes.push(
        "accessibility tests need @axe-core/playwright: npm install -D @axe-core/playwright",
      );
  }
  return result;
}
