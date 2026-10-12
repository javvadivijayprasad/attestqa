import { replayRules } from "./replay/rules.js";
import { NO_SIGNATURE_CONFIDENCE, TEST_CODE_RATIONALE } from "./triage/patterns.js";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { readLedgerFile, LEDGER_FILE } from "./ledger/ledger.js";
import { renderMarkdown } from "./ledger/replay.js";
import {
  ConfigError,
  loadAgentConfig,
  loadDotEnv,
  readRuntimeEnv,
  type RuntimeEnv,
} from "./config.js";
import { Ledger, newRunId, APPROVALS_DIR } from "./ledger/ledger.js";
import { runLoop } from "./runtime/loop.js";
import { buildModel, describeModel, credentialVarFor } from "./runtime/provider.js";
import { TerminalApprover, FileApprover } from "./runtime/approvers.js";
import { storyToTestsSkill } from "./skills/story-to-tests.js";
import { defectProfileSkill } from "./skills/defect-profile.js";
import { parseWorkItemRef } from "./verify/story-to-tests.js";
import { EXIT_CODES, type AgentConfig, type AnyRunEvent } from "./types.js";
import type { ModelClient } from "./runtime/model.js";
import { CompositeTools, McpToolClient, type ServerSpec } from "./mcp/client.js";
import { buildReport, renderReportMarkdown } from "./mcp/discover.js";
import { DEFAULT_MANIFEST } from "./mcp/manifest.js";
import { azureDevOpsServer, playwrightServer } from "./mcp/servers.js";
import { FsTools } from "./mcp/adapters/fs.js";
import { Bdd2PwTools } from "./mcp/adapters/bdd2pw.js";
import { PwTools } from "./mcp/adapters/pw.js";
import { JiraTools } from "./mcp/adapters/jira.js";
import { normId, TRACKERS, type Tracker } from "./design/ids.js";
import { TcgTools } from "./mcp/adapters/tcg.js";
import { SynthdataTools } from "./mcp/adapters/synthdata.js";
import { HealTools } from "./mcp/adapters/heal.js";
import { SummaryTools } from "./mcp/adapters/summary.js";
import { TestDesignTools } from "./mcp/adapters/test-design.js";
import type { TestType } from "./design/test-design.js";
import { DefectProfileTools } from "./mcp/adapters/defect-profile.js";
import { ScopedGate, matchesAny } from "./governance/policy.js";
import { mask, scrub } from "./governance/scrub.js";
import type { ToolClient } from "./runtime/tools.js";

/**
 * The published version, read from `package.json` rather than written here.
 *
 * A hand-maintained copy drifts the moment someone runs `npm version`: the tarball
 * says one thing and `aqa --version` says another, which makes a bug report from a
 * user impossible to place against a commit. `package.json` sits one level above
 * both `dist/cli.js` and `src/cli.ts`, so the same path resolves from a build, from
 * a global install, and from `tsx`.
 */
/** The bdd2pw this package depends on: its CLI path and version, or undefined. */
export function ownBdd2pw(): { cli: string; version: string } | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@vijaypjavvadi/bdd2pw/package.json");
    const pkg = require(pkgPath) as { version?: unknown; bin?: unknown };
    const bin =
      typeof pkg.bin === "string"
        ? pkg.bin
        : typeof pkg.bin === "object" && pkg.bin !== null
        ? (pkg.bin as Record<string, unknown>)["bdd2pw"]
        : undefined;
    if (typeof bin !== "string") return undefined;
    const cli = join(dirname(pkgPath), bin);
    if (!existsSync(cli)) return undefined;
    return { cli, version: typeof pkg.version === "string" ? pkg.version : "?" };
  } catch {
    return undefined;
  }
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = packageVersion();

/** In-process adapters, by `--servers` name. */
export const LOCAL_SERVERS = ["fs", "bdd2pw", "pw", "tcg", "synthdata", "jira"];
/**
 * `tcg` and `synthdata` are site-specific (they need TCG_URL / SYNTHDATA_CMD),
 * so they are opt-in rather than on by default.
 */
export const DEFAULT_SERVERS = "ado,playwright,fs,bdd2pw,pw";
/** The same set for a Jira story: Jira in place of Azure DevOps. */
export const JIRA_SERVERS = "jira,playwright,fs,bdd2pw,pw";

const USAGE = `aqa — agentic QA runtime

Usage:
  aqa replay <path> [--out <file>]
      Render a ledger to Markdown (no network, no tools). <path> is a run dir, a ledger
      root (uses the latest run), or an events.jsonl file.

  aqa check-rules <run-dir>... --config <ai-quality.config.yaml> [--workspace .]
      Replay each run's proposals through TODAY's rules, offline (no model, no tools,
      no network). Prints every decision that would now differ from the one the run
      got, and whether the run's end point leaves any way to write a missing design
      item's test. Exit 0 when no run ends in a rule deadlock, 2 when one does.

  aqa discover [--servers ado,playwright,fs,bdd2pw,pw] [--out docs/tools-observed.md] [--workspace .]
      Spawn the MCP servers, list their tools, and write the observed names + schemas.
      Reads .env for credentials. Makes NO tool calls — listTools() only.

  aqa run "<request>" --config <ai-quality.config.yaml> [--ledger .aqa]
          [--approval terminal|file] [--approval-timeout <seconds>]
          [--skill story-to-tests|defect-profile] [--work-item <id>] [--dry-run]
          [--tracker ado|jira] [--servers ...] [--workspace .] [--env .env]
      Run the agent loop. For story-to-tests (the default) the work item comes from
      the request ("AB#1") unless --work-item says otherwise, and must be in
      agent.scope.work_items. defect-profile takes no work item: it reads the
      project's closed bugs and writes .aqa-profile/defects.json in the workspace,
      which story-to-tests then reads to aim its test design.
      --tracker: where the story lives. Default: from the work item — a Jira key
      (SHOP-12) means Jira and needs JIRA_BASE_URL with JIRA_EMAIL + JIRA_API_TOKEN
      (Cloud) or JIRA_PAT (Data Center) in .env; a number means Azure DevOps.
      --dry-run: load config, connect servers, list tools with their gate class,
      make no model or tool calls, exit 0.
      --approval file: each batch is written to <ledger>/runs/<id>/approvals/<approvalId>.json
      with decision:null; set "decision" to "approved" or "denied" (and optionally "by")
      to answer. Silence past --approval-timeout (default 1800s) counts as denied.
      Exit codes: 0 done, 1 error, 2 blocked, 3 refused, 4 budget.

  aqa --version | -v      aqa --help | -h
`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function main(argv: string[], io: CliIo = stdio()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === "--help" || cmd === "-h") return io.out(USAGE), 0;
    if (cmd === "--version" || cmd === "-v") return io.out(`${VERSION}\n`), 0;
    if (cmd === "replay") return replay(rest, io);
    if (cmd === "discover") return await discover(rest, io);
    if (cmd === "check-rules") return await checkRules(rest, io);
    if (cmd === "run") return await run(rest, io);
    io.err(`Unknown command: ${cmd}\n\n${USAGE}`);
    return 1;
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`aqa: config error: ${e.message}\n`);
      return 1;
    }
    io.err(`aqa: ${(e as Error).message}\n`);
    return 1;
  }
}

function stdio(): CliIo {
  return {
    out: (s) => {
      process.stdout.write(s);
    },
    err: (s) => {
      process.stderr.write(s);
    },
  };
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function replay(args: string[], io: CliIo): number {
  const target = positional(args)[0];
  if (!target) return io.err("aqa replay: missing <path>\n"), 1;
  const out = flag(args, "--out");
  const file = resolveLedgerFile(resolve(target));
  if (!file) return io.err(`aqa replay: no ${LEDGER_FILE} found under ${target}\n`), 1;
  const events = readLedgerFile(file);
  const md = renderMarkdown(events);
  if (out && out !== "-") {
    if (out !== "/dev/null" && out !== "NUL") writeFileSync(out, md, "utf8");
    io.err(`aqa replay: ${events.length} events from ${file}\n`);
  } else io.out(md);
  return 0;
}

/** Accept a run dir, a ledger root (`<root>/runs/*`), or the jsonl file itself. */
export function resolveLedgerFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).isFile()) return path;
  const direct = join(path, LEDGER_FILE);
  if (existsSync(direct)) return direct;
  const runs = join(path, "runs");
  if (existsSync(runs) && statSync(runs).isDirectory()) {
    const latest = readdirSync(runs)
      .filter((d) => existsSync(join(runs, d, LEDGER_FILE)))
      .sort()
      .pop();
    if (latest) return join(runs, latest, LEDGER_FILE);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// discover / run --dry-run
// ---------------------------------------------------------------------------

export interface ToolingDeps {
  /** Override for tests: build the tool client instead of spawning servers. */
  buildTools?: (
    specs: ServerSpec[],
    workspace: string,
  ) => Promise<{ tools: ToolClient; close: () => Promise<void> }>;
  /** Override for tests: supply the model instead of calling Anthropic. */
  buildModel?: (env: RuntimeEnv, config: AgentConfig) => ModelClient;
}

async function buildTooling(
  args: string[],
  io: CliIo,
  deps: ToolingDeps,
  scopeUrls: string[] = [],
  /**
   * bdd2pw's LLM fallback, from the config. Reaches the generator only paired
   * with AI_GOVERNANCE_URL — see below.
   */
  llmFallback?: AgentConfig["llm_fallback"],
  /** Servers when --servers is not given: DEFAULT_SERVERS, or JIRA_SERVERS for a Jira story. */
  defaultServers: string = DEFAULT_SERVERS,
): Promise<{
  specs: ServerSpec[];
  tools: ToolClient;
  close: () => Promise<void>;
  workspace: string;
}> {
  loadDotEnv(flag(args, "--env") ?? ".env");
  const env = readRuntimeEnv(process.env, { requireAnthropic: false });
  const workspace = resolve(flag(args, "--workspace") ?? ".");
  const wanted = (flag(args, "--servers") ?? defaultServers)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const specs: ServerSpec[] = [];
  for (const w of wanted) {
    if (w === "ado") {
      if (!env.azureDevOps)
        throw new ConfigError(
          "--servers includes ado but AZURE_DEVOPS_ORG_URL/PAT/PROJECT are not set",
        );
      specs.push(azureDevOpsServer(env));
    } else if (w === "playwright")
      specs.push(
        playwrightServer({
          allowedOrigins: scopeUrls,
          // AQA_BROWSER picks another installed browser (msedge, firefox, …);
          // the default is the Chrome most teams already run.
          ...(process.env["AQA_BROWSER"] ? { browser: process.env["AQA_BROWSER"] } : {}),
        }),
      );
    else if (w === "tcg" && !env.tcgUrl)
      throw new ConfigError("--servers includes tcg but TCG_URL is not set");
    else if (w === "synthdata" && !env.synthdataCmd)
      throw new ConfigError("--servers includes synthdata but SYNTHDATA_CMD is not set");
    else if (w === "jira" && !env.jira)
      throw new ConfigError(
        "--servers includes jira but JIRA_BASE_URL and its credential (JIRA_EMAIL + JIRA_API_TOKEN, or JIRA_PAT) are not set",
      );
    else if (!LOCAL_SERVERS.includes(w))
      throw new ConfigError(
        `unknown server "${w}" (known: ado, playwright, ${LOCAL_SERVERS.join(", ")})`,
      );
  }
  if (env.azureDevOps && wanted.includes("ado"))
    io.err(
      `aqa: Azure DevOps org ${env.azureDevOps.org}, project ${env.azureDevOps.project}, PAT ${mask(
        env.azureDevOps.pat,
      )}\n`,
    );
  if (env.jira && wanted.includes("jira"))
    io.err(
      `aqa: Jira ${env.jira.baseUrl} (REST v${env.jira.apiVersion ?? 3}), ${
        env.jira.auth.kind === "basic"
          ? `${env.jira.auth.email}, API token ${mask(env.jira.auth.token)}`
          : `PAT ${mask(env.jira.auth.token)}`
      }\n`,
    );

  const built = deps.buildTools
    ? await deps.buildTools(specs, workspace)
    : await (async () => {
        const mcp = new McpToolClient(specs, DEFAULT_MANIFEST);
        const clients: ToolClient[] = specs.length > 0 ? [mcp] : [];
        if (wanted.includes("fs")) clients.push(new FsTools(workspace));
        if (wanted.includes("bdd2pw")) {
          // The pair, or neither. bdd2pw will not send a prompt without the
          // sidecar, and this runtime will not ask it to: a provider set
          // without AI_GOVERNANCE_URL is a configuration mistake, not a
          // licence to skip governance, and `--llm-skip-governance` is
          // unconstructible anywhere in this codebase.
          const governed = llmFallback !== undefined && env.governanceUrl !== undefined;
          if (llmFallback && !env.governanceUrl)
            io.err(
              "aqa: agent.llm_fallback is set but AI_GOVERNANCE_URL is not — bdd2pw will run " +
                "rules-only and unbound steps will land as TODO\n",
            );
          // The bdd2pw attestqa depends on, run directly with this Node —
          // not `npx bdd2pw`, which resolves from the WORKSPACE and so could
          // start a global or stale copy, or none, depending on where the
          // tests live. A fix shipped in bdd2pw then reaches every run.
          const own = ownBdd2pw();
          if (own) io.err(`aqa: bdd2pw ${own.version} (attestqa's own dependency)\n`);
          else io.err("aqa: bdd2pw not found in attestqa's dependencies — falling back to npx\n");
          clients.push(
            new Bdd2PwTools(workspace, {
              ...(own ? { command: process.execPath, args: [own.cli] } : {}),
              ...(governed && llmFallback && env.governanceUrl
                ? { llm: llmFallback, governanceUrl: env.governanceUrl }
                : {}),
            }),
          );
          if (governed)
            io.err(`aqa: bdd2pw LLM fallback ${llmFallback}, governed by the sidecar\n`);
        }
        if (wanted.includes("pw")) clients.push(new PwTools(workspace));
        if (wanted.includes("jira") && env.jira) clients.push(new JiraTools(env.jira));
        if (wanted.includes("tcg") && env.tcgUrl) clients.push(new TcgTools(env.tcgUrl));
        if (wanted.includes("synthdata") && env.synthdataCmd)
          clients.push(new SynthdataTools(env.synthdataCmd, workspace));
        return { tools: new CompositeTools(clients), close: () => mcp.close() };
      })();
  return { specs, ...built, workspace };
}

export async function discover(args: string[], io: CliIo, deps: ToolingDeps = {}): Promise<number> {
  const out = flag(args, "--out") ?? "docs/tools-observed.md";
  const { specs, tools, close } = await buildTooling(args, io, deps);
  try {
    io.err(`aqa discover: connecting to ${specs.length} MCP server(s)…\n`);
    const list = await tools.listTools();
    const report = buildReport(
      [
        ...specs,
        ...LOCAL_SERVERS.filter((n) => list.some((t) => t.server === n)).map((name) => ({
          name,
          command: "(in-process)",
          args: [],
        })),
      ],
      list,
      DEFAULT_MANIFEST,
    );
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, renderReportMarkdown(report), "utf8");
    writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify(report, null, 2), "utf8");
    const unclassified = report.tools.filter((t) => !t.classified).length;
    io.out(
      `aqa discover: ${report.tools.length} tools from ${report.servers.length} server(s); ${unclassified} unclassified → ${out}\n`,
    );
    for (const t of report.tools) io.out(`  ${t.classified ? " " : "!"} ${t.qualified}\n`);
    return 0;
  } finally {
    await close();
  }
}

export async function run(args: string[], io: CliIo, deps: ToolingDeps = {}): Promise<number> {
  const request = positional(args)[0];
  if (!request) return io.err(`aqa run: missing "<request>"\n`), 1;
  const configPath = flag(args, "--config");
  if (!configPath) return io.err("aqa run: --config <ai-quality.config.yaml> is required\n"), 1;
  const config = await loadAgentConfig(configPath);

  if (!args.includes("--dry-run")) return live(request, args, config, io, deps);
  // The same tracker choice the real run makes, so a dry run checks the
  // servers and tools that run would actually use.
  loadDotEnv(flag(args, "--env") ?? ".env");
  const picked = pickTracker(
    args,
    request,
    readRuntimeEnv(process.env, { requireAnthropic: false }),
  );
  if ("error" in picked) {
    io.err(picked.error);
    return 1;
  }
  const { tools, close } = await buildTooling(
    args,
    io,
    deps,
    config.scope.urls,
    config.llm_fallback,
    picked.tracker === "jira" ? JIRA_SERVERS : DEFAULT_SERVERS,
  );
  try {
    const list = await tools.listTools();
    const gate = new ScopedGate(config.policy, config.scope, {
      sandbox: process.env["AQA_SANDBOX"] === "1",
    });
    io.out(`aqa run --dry-run: "${request}"\n`);
    io.out(`  tracker: ${picked.tracker === "jira" ? "Jira" : "Azure DevOps"}\n`);
    io.out(
      `  config: model ${describeModel(config.model)}, budgets ${config.budgets.steps} steps / ${
        config.budgets.tokens
      } tokens\n`,
    );
    io.out(
      `  scope: work_items ${config.scope.work_items.join(",") || "(none)"}; repos ${
        config.scope.repos.join(",") || "(none)"
      }; test_plans ${config.scope.test_plans.join(",") || "(none)"}; urls ${
        config.scope.urls.join(",") || "(none)"
      }\n`,
    );
    io.out(`  ${list.length} tools visible to the gate (class → table decision):\n`);
    for (const t of list) {
      const qname = `${t.server}.${t.name}`;
      io.out(`    ${qname}: ${t.policyClass} → ${config.policy[t.policyClass]}\n`);
      const actions = Object.entries(t.actions ?? {});
      for (const [action, a] of actions) {
        const verdict = gate.judge(
          { toolName: qname, args: { [t.actionArg ?? "action"]: action } },
          t,
        );
        io.out(
          `        ${t.actionArg}=${action}: ${a.policyClass} → ${
            config.policy[a.policyClass]
          }${scopeHint(verdict)}\n`,
        );
      }
      if (actions.length === 0) {
        const hint = scopeHint(gate.judge({ toolName: qname, args: {} }, t));
        if (hint) io.out(`       ${hint}\n`);
      }
    }
    io.out("  no model or tool calls were made.\n");
    return 0;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------

/**
 * A real run: model, tools, gate, approver, ledger, loop. Everything the dry
 * run describes, actually done (PLAN §1 A7).
 */
async function live(
  request: string,
  args: string[],
  config: AgentConfig,
  io: CliIo,
  deps: ToolingDeps,
): Promise<number> {
  const envFile = flag(args, "--env") ?? ".env";
  const loaded = loadDotEnv(envFile);
  // Read without demanding the API key first: refusing an out-of-scope request
  // should not require credentials, and the key is only needed once a model is
  // actually built.
  const env = readRuntimeEnv(process.env, { requireAnthropic: false });

  // Say where the credential came from — for the provider the config names,
  // not for Anthropic by assumption. A stale key already in the shell wins
  // over the file (standard dotenv precedence) and silently shadows it, which
  // otherwise surfaces only as an unexplained 401 (20261007T163224Z).
  const credVar = credentialVarFor(config.model);
  const credValue = credVar ? process.env[credVar] ?? "" : "";
  const keySource = !credVar
    ? "no credential needed"
    : loaded.includes(credVar)
    ? `${credVar} ${mask(credValue)} from ${envFile}`
    : credValue
    ? `${credVar} ${mask(credValue)} from the shell environment (NOT ${envFile})`
    : `${credVar} is not set anywhere`;
  io.err(
    `aqa: env ${resolve(envFile)} — ${loaded.length} key(s) loaded; model ${describeModel(
      config.model,
    )}; ${keySource}\n`,
  );

  const approvalMode = flag(args, "--approval") ?? "terminal";
  if (approvalMode !== "file" && approvalMode !== "terminal") {
    io.err(`aqa run: --approval must be "terminal" or "file"\n`);
    return 1;
  }

  const skillName = flag(args, "--skill") ?? "story-to-tests";
  if (skillName !== "story-to-tests" && skillName !== "defect-profile") {
    io.err(`aqa run: --skill must be "story-to-tests" or "defect-profile"\n`);
    return 1;
  }

  // defect-profile queries a project's bug history, so the project name is not
  // optional for it. Checked here, before a token is spent, rather than left to
  // fail somewhere inside the run.
  const picked = pickTracker(args, request, env);
  if ("error" in picked) {
    io.err(picked.error);
    return 1;
  }
  const { tracker, explicitRef, jiraRef } = picked;
  if (tracker === "jira" && skillName === "defect-profile") {
    io.err(
      "aqa run: --skill defect-profile reads Azure DevOps bug history; it has no Jira version yet.\n",
    );
    return 1;
  }

  const adoProject = env.azureDevOps?.project;
  if (skillName === "defect-profile" && !adoProject) {
    io.err(
      "aqa run: --skill defect-profile needs AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PROJECT " +
        "in the environment or .env.\n",
    );
    return 1;
  }

  // Only story-to-tests is scoped to ONE story. defect-profile reads whatever
  // bugs the query returns, and each of those reads is scope-checked by the
  // gate at the point of the call — so requiring a single work item up front
  // would be a check about the wrong thing.
  let workItem = "";
  if (skillName === "story-to-tests") {
    // Refuse before spending a token if the request names a work item the
    // config does not allow.
    const raw = explicitRef ?? (tracker === "jira" ? jiraRef : parseWorkItemRef(request));
    // A Jira key is case-insensitive in Jira; it is carried upper-case so the
    // scope list, the @story tag and the ledger all spell it one way.
    const ref = raw !== undefined && tracker === "jira" ? String(normId(raw) ?? raw) : raw;
    if (!ref) {
      io.err(
        'aqa run: no work item in the request. Write it as "AB#1" or as a Jira key like SHOP-12, or pass --work-item <id>.\n',
      );
      return 1;
    }
    if (tracker === "jira" && typeof normId(ref) !== "string") {
      io.err(`aqa run: ${ref} is not a Jira issue key (expected something like SHOP-12).\n`);
      return 1;
    }
    if (!matchesAny(ref, config.scope.work_items, env.sandbox)) {
      io.err(
        `aqa run: work item ${ref} is not in agent.scope.work_items (${
          config.scope.work_items.join(", ") || "empty"
        }).\n`,
      );
      return EXIT_CODES.refused;
    }
    workItem = ref;
  }

  const ledger = new Ledger(flag(args, "--ledger") ?? ".aqa", newRunId());
  // How long `--approval file` waits before treating silence as "no". The
  // default suits a person who stepped away; a joint smoke or a CI run wants
  // seconds, not half an hour, so it is a flag rather than a constant.
  const approvalTimeout = flag(args, "--approval-timeout");
  let timeoutMs: number | undefined;
  if (approvalTimeout !== undefined) {
    const seconds = Number(approvalTimeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      io.err("aqa run: --approval-timeout must be a positive number of seconds\n");
      return 1;
    }
    timeoutMs = Math.round(seconds * 1000);
  }
  const approver =
    approvalMode === "file"
      ? new FileApprover({
          dir: join(ledger.dir, APPROVALS_DIR),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        })
      : new TerminalApprover();

  const {
    tools: mcpTools,
    close,
    workspace,
  } = await buildTooling(
    args,
    io,
    deps,
    config.scope.urls,
    config.llm_fallback,
    tracker === "jira" ? JIRA_SERVERS : DEFAULT_SERVERS,
  );
  try {
    const planName = config.scope.test_plans[0];
    // An account without the Test Plans access level cannot create a plan or a
    // suite; requiring suite membership there fails every run for a reason the
    // agent has no way to act on, so the check becomes a recorded limitation.
    const canCreatePlans = config.capabilities.test_plans;
    // Stage 2 — the ISTQB test types a design must cover. Validated by the
    // config loader; empty means no design stage.
    const testTypes = (config.test_types ?? []) as TestType[];
    const skill =
      skillName === "defect-profile"
        ? defectProfileSkill({ project: adoProject ?? "" })
        : storyToTestsSkill({
            workItem,
            ...(tracker === "jira" ? { tracker } : {}),
            ...(adoProject ? { project: adoProject } : {}),
            ...(canCreatePlans && planName ? { testPlan: planName } : {}),
            ...(canCreatePlans ? {} : { requireSuiteMembership: false }),
            ...(testTypes.length > 0 ? { testTypes } : {}),
            // Stage 0: the framework already in this workspace decides where
            // the scenarios, the spec and the page objects go.
            workspaceDir: workspace,
            // Failure triage runs in-process by default and sends nothing
            // anywhere. Setting DEFECT_ANALYSIS_URL opts into the service; the
            // value comes from the environment and nowhere else, so that no
            // work item, spec or tool result can nominate an endpoint.
            ...(process.env["DEFECT_ANALYSIS_URL"]
              ? { defectAnalysisUrl: process.env["DEFECT_ANALYSIS_URL"] }
              : {}),
          });
    // The run's own report, counted from the ledger rather than written by the
    // model. Composed here because it needs the ledger, which buildTooling does
    // not and should not know about.
    // The profile reader is available to BOTH skills: one writes the profile,
    // the other reads it to aim its test design. It only ever reads a file.
    const profileTools = new DefectProfileTools(workspace);
    const tools = new CompositeTools([
      mcpTools,
      profileTools,
      new TestDesignTools(ledger, testTypes, workspace),
      new HealTools(ledger),
      new SummaryTools(ledger, {
        workItem,
        ...(canCreatePlans || tracker === "jira"
          ? {}
          : {
              limitations: [
                "test suite membership — this Azure DevOps account has no Test Plans access level, " +
                  "so the cases are linked to the story but no suite contains them",
              ],
            }),
      }),
    ]);

    const model =
      deps.buildModel?.(env, config) ??
      buildModel({
        config: config.model,
        env,
        promptVersion: config.prompt_version,
        ...(env.model ? { modelOverride: env.model } : {}),
        warn: (m) => io.err(`aqa: ${scrub(m).text}\n`),
      });

    io.err(`aqa run ${ledger.runId}: "${request}"\n`);
    io.err(
      `aqa: skill ${skill.name}, ${
        workItem
          ? `${tracker === "jira" ? "Jira issue" : "work item"} ${workItem}`
          : `project ${adoProject ?? "?"}`
      }, model ${model.model}, approval ${approvalMode}\n`,
    );
    if (skillName === "defect-profile")
      io.err(
        "aqa: bug reads are scope-checked per work item — ids outside agent.scope.work_items " +
          "are refused and recorded as out of scope, not classified\n",
      );
    if (skillName === "story-to-tests" && tracker === "jira")
      io.err(
        "aqa: Jira keeps no test cases — the feature file's @story tags are the record; " +
          "the run report stays with the run and is not posted to the issue\n",
      );
    else if (skillName === "story-to-tests" && !canCreatePlans)
      io.err(
        "aqa: capabilities.test_plans is false — cases will be created and linked, " +
          "but no plan or suite (this account has no Test Plans access level)\n",
      );
    io.err(`aqa: ledger ${ledger.dir}\n`);

    // A live line per interesting event.
    //
    // The run used to print its approvals and its final status and nothing
    // else, so a suite that executed and passed looked exactly like a suite
    // that never started — for minutes at a time. Everything here is already
    // in the ledger; this only stops the operator having to read it afterwards
    // to find out what happened while they were watching.
    ledger.onAppend = (e) => io.err(liveLine(e));

    const result = await runLoop({
      requestText: request,
      model,
      tools,
      gate: new ScopedGate(config.policy, config.scope, { sandbox: env.sandbox }),
      approver,
      skill,
      ledger,
      config,
      workspaceDir: workspace,
    });

    // The agent's own closing words. Shown here, and only here: they are its
    // account of its work, not a counted result, so they are not posted.
    io.out(
      result.status === "done"
        ? `\ndone — agent's note (its own words, not posted to the story):\n${result.summary}\n`
        : `\n${result.status}: ${result.summary}\n`,
    );
    io.out(`  ${result.events} events in ${ledger.dir}\n`);
    io.out(`  replay: aqa replay ${ledger.dir}\n`);
    return result.exitCode;
  } finally {
    await close();
  }
}

/** Show, in the dry run, which argument a tool still needs before it can pass the gate. */
function scopeHint(v: { decision: string; reason: string }): string {
  return v.decision === "refuse" && /required for scope checks/.test(v.reason)
    ? ` — ${v.reason}`
    : "";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (a !== "--dry-run") i++; // skip the value of a --flag value pair
      continue;
    }
    out.push(a);
  }
  return out;
}

// Only run when invoked as the CLI entry (tsup banner adds the shebang).
const isEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /(^|[\\/])(cli\.(js|ts|mjs)|aqa)$/.test(process.argv[1] ?? "");
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`aqa: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}

/**
 * One short line for an event worth watching, or "" for the rest.
 *
 * Deliberately narrow. A line per tool call would bury the two things an
 * operator is actually waiting for — did the suite run, and what did triage
 * make of it — under thirty reads of the same file.
 */
export function liveLine(e: AnyRunEvent): string {
  const p = e.payload as unknown as Record<string, unknown>;
  switch (e.kind) {
    // A call the RUNTIME decided on, not the model. Ordinary calls stay silent —
    // thirty reads of one file is not news — but this one is: it is the
    // difference between a step that cost an inference and a step that did not,
    // and without the line an operator cannot tell them apart on screen.
    case "call": {
      if (p["origin"] !== "runtime") return "";
      const why = String(p["why"] ?? "").trim();
      const what = `${String(p["server"] ?? "")}.${String(p["toolName"] ?? "")}`;
      const name = what === "pw.run_tests" ? "running the suite" : `calling ${what}`;
      return `aqa: ${name} itself — ${why || "the conditions for it are met"} (no model turn)\n`;
    }
    case "observation": {
      const r = p["result"];
      if (typeof r !== "object" || r === null) return "";
      const rec = r as Record<string, unknown>;
      if (rec["kind"] === "preflight") {
        // Stage 1: what the runtime read before the model's first turn.
        const s = (rec["summary"] ?? {}) as Record<string, number>;
        const n = (k: string) => s[k] ?? 0;
        // A refusal is reported as a refusal. "0 tasks" and "tasks refused by
        // scope" are different facts with different fixes, and the first
        // version of this line printed the second as the first.
        const epic = n("epicRead") ? "read" : n("epicRefused") ? "REFUSED (scope)" : "none";
        const tasks = n("tasksRefused")
          ? `${n("tasksRefused")} task(s) REFUSED (scope)`
          : `${n("tasksRead")} task(s)`;
        const bugs = n("openBugsRefused")
          ? `${n("openBugsRefused")} open bug(s) found but REFUSED (scope)`
          : `${n("openBugsRead")} open bug(s) (${n("openBugsExcluded")} agent-filed left out)`;
        const fw =
          s["frameworkFound"] === undefined
            ? ""
            : s["frameworkFound"]
            ? `aqa: framework — ${n("existingSpecs")} existing spec(s) in this project's layout\n`
            : "aqa: framework — NONE FOUND; run aqa init-framework first\n";
        return (
          fw +
          `aqa: context — story ${n("storyRead") ? "read" : "NOT READ"}, ` +
          `${n("existingTestCases")} existing test case(s), epic ${epic}, ` +
          `${n("siblingsRead")} sibling stor${n("siblingsRead") === 1 ? "y" : "ies"}, ${tasks}, ` +
          `${n("commentsRead")} comment(s) (${n(
            "commentsExcluded",
          )} run reports left out), ${bugs}\n`
        );
      }
      if (rec["recorded"] === true && typeof rec["items"] === "number") {
        const already = Array.isArray(rec["alreadyTested"])
          ? (rec["alreadyTested"] as string[]).length
          : 0;
        const fresh = Array.isArray(rec["newItems"])
          ? (rec["newItems"] as string[]).length
          : undefined;
        if (already > 0)
          return (
            `aqa: test design approved — ${rec["items"]} item(s): ${already} already tested, ` +
            `${fresh ?? 0} new${fresh === 0 ? " — running the tests that exist" : ""}\n`
          );
        return `aqa: test design approved — ${rec["items"]} item(s); tests are written from it\n`;
      }
      if (!("passed" in rec) || !("failed" in rec)) return "";
      const green = rec["green"] === true;
      const known = (Array.isArray(rec["tests"]) ? rec["tests"] : []).filter(
        (t) => (t as Record<string, unknown> | null)?.["status"] === "expected-failure",
      ).length;
      return (
        `aqa: suite ${green ? "green" : "red"} — ${num(rec["passed"])} passed, ` +
        `${num(rec["failed"])} failed, ${num(rec["skipped"])} skipped` +
        (known > 0 ? ` (${known} of the passed: known bug reproduced, failing as expected)` : "") +
        "\n"
      );
    }
    case "route": {
      const label: Record<string, string> = {
        P0: "STOP",
        A: "author the tests",
        A2: "complete what is missing",
        B: "execute the tests that exist",
      };
      const path = String(p["path"] ?? "?");
      const denied = Array.isArray(p["denied"]) ? (p["denied"] as string[]).length : 0;
      return (
        `aqa: route ${path} — ${label[path] ?? "?"}: ${String(p["reason"] ?? "")}` +
        (denied > 0 ? ` (${denied} authoring tool(s) not offered)` : "") +
        "\n"
      );
    }
    case "agent": {
      const role = String(p["role"] ?? "");
      const tools = Array.isArray(p["tools"]) ? (p["tools"] as string[]).length : 0;
      return role === "default"
        ? "aqa: back to the full toolset\n"
        : `aqa: ${role} agent takes over — ${String(
            p["because"] ?? "",
          )}; it may use ${tools} tool(s), nothing else\n`;
    }
    case "triage": {
      const runLevel = p["runLevel"];
      if (typeof runLevel === "string") {
        return runLevel === "environmental"
          ? "aqa: nothing in this run measured the product — it failed before the tests reached it (application down, a test fixture missing, or a setup step such as a pop-up in the way)\n"
          : `aqa: nothing in this run measured the product — the test runner itself failed (${runLevel})\n`;
      }
      const verdicts = Array.isArray(p["verdicts"]) ? p["verdicts"] : [];
      if (verdicts.length === 0)
        return "aqa: suite is green — the earlier failures are gone, nothing is held for you\n";
      const by = new Map<string, number>();
      for (const v of verdicts) {
        const r = v as Record<string, unknown>;
        let c = String(r["category"] ?? "?");
        const rationale = String(r["rationale"] ?? "");
        // Say what the classifier actually knows. A real-defect at the
        // no-pattern confidence is a default, not a judgement, and a "flake"
        // that is invalid test code is the test's fault.
        if (rationale.startsWith(TEST_CODE_RATIONALE)) c = "test-defect";
        else if (c === "real-defect" && Number(r["confidence"] ?? 1) <= NO_SIGNATURE_CONFIDENCE)
          c = "unrecognised";
        by.set(c, (by.get(c) ?? 0) + 1);
      }
      // In words, not in the classifier's vocabulary. "4 flake" told an
      // operator nothing about what happens next, and "real-defect" reads as a
      // verdict on the product when it means "this one goes to a person".
      const say: Record<string, (n: number) => string> = {
        "real-defect": (n) => `${n} look${n === 1 ? "s" : ""} like a product defect — held for you`,
        flake: (n) => `${n} may be flaky — re-running to find out`,
        "test-defect": (n) =>
          `${n} look${n === 1 ? "s" : ""} like the test's fault — the agent fixes ${
            n === 1 ? "it" : "them"
          }`,
        environmental: (n) => `${n} never reached the product (setup or environment failed)`,
        unrecognised: (n) =>
          `${n} matched no known failure pattern — held for you as possible defect${
            n === 1 ? "" : "s"
          }, at low confidence (0.1)`,
      };
      const parts = [...by]
        .map(([c, n]) => (say[c] ? (say[c] as (x: number) => string)(n) : `${n} ${c}`))
        .join("; ");
      return `aqa: ${verdicts.length} failure(s) triaged — ${parts}\n`;
    }
    case "policy": {
      // Only the bug-handling decisions: every other policy line would bury
      // the ones an operator is waiting for.
      const reason = String(p["reason"] ?? "");
      if (reason.startsWith("deferred until execution finishes")) {
        const title = /"([^"]+)"/.exec(reason)?.[1] ?? "bug";
        return `aqa: bug proposal held until the run finishes — ${title}\n`;
      }
      if (reason.startsWith("dropped at end of run")) {
        return `aqa: bug proposal ${reason.replace(/^dropped at end of run — /, "dropped — ")}\n`;
      }
      // Stage 2: a design the runtime sent back, with what was wrong — the
      // reviewer is only asked once these are gone.
      if (p["toolName"] === "aqa.test_design" && p["decision"] === "refuse") {
        const problems = reason.split("\n- ").slice(1);
        return (
          `aqa: the design was sent back to the agent — ${problems.length || 1} thing(s) to fix\n` +
          problems.map((x) => `       - ${x}\n`).join("")
        );
      }
      if (reason.includes("no test design has been approved yet")) {
        return "aqa: the suite may not run until a test design is approved\n";
      }
      return "";
    }
    case "verify": {
      const gaps = Array.isArray(p["gaps"]) ? p["gaps"] : [];
      if (p["done"] === true) return "aqa: checks passed — the run did what this story needed\n";
      // The gap codes are for the ledger; a person reading a terminal wants the
      // first sentence of the reason.
      const first = gaps
        .slice(0, 3)
        .map((g) => {
          const r = g as Record<string, unknown>;
          const message = String(r["message"] ?? "");
          // A sentence that ends in a colon introduces its list; the list is the point.
          const sentence = message.split(/(?<=\.)\s/)[0] ?? message;
          return `       - ${sentence.slice(0, 240)}`;
        })
        .join("\n");
      const more = gaps.length > 3 ? `\n       … and ${gaps.length - 3} more` : "";
      return `aqa: ${gaps.length} thing(s) still unfinished\n${first}${more}\n`;
    }
    default:
      return "";
  }
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/**
 * The first Jira issue key in a request, upper-case only: free text is full of
 * lower-case word-dash-number shapes ("utf-8", "covid-19") that are not keys.
 */
export function parseJiraKey(text: string): string | undefined {
  return /\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(text)?.[1];
}

/**
 * Which tracker a run's story lives in: --tracker, else the work item's own
 * shape (SHOP-12 is Jira, 44 is Azure DevOps). Jira is never guessed from a key
 * in the request text unless Jira is configured. Shared by the real run and the
 * dry run, so the two can never disagree about which servers to connect.
 */
export function pickTracker(
  args: string[],
  request: string,
  env: RuntimeEnv,
):
  | { tracker: Tracker; explicitRef: string | undefined; jiraRef: string | undefined }
  | { error: string } {
  const trackerFlag = flag(args, "--tracker");
  if (trackerFlag !== undefined && !(TRACKERS as readonly string[]).includes(trackerFlag))
    return { error: `aqa run: --tracker must be one of ${TRACKERS.join(", ")}\n` };
  const explicitRef = flag(args, "--work-item");
  const jiraRef = env.jira ? parseJiraKey(request) : undefined;
  const tracker: Tracker =
    (trackerFlag as Tracker | undefined) ??
    (explicitRef !== undefined
      ? typeof normId(explicitRef) === "string"
        ? "jira"
        : "ado"
      : !parseWorkItemRef(request) && jiraRef
      ? "jira"
      : "ado");
  if (tracker === "jira" && !env.jira)
    return {
      error:
        "aqa run: this is a Jira story, but JIRA_BASE_URL and its credential are not set " +
        "(JIRA_EMAIL + JIRA_API_TOKEN for Cloud, or JIRA_PAT for Data Center) in the environment or .env.\n",
    };
  return { tracker, explicitRef, jiraRef };
}

/** `aqa check-rules`: today's rules against recorded runs. See USAGE. */
export async function checkRules(args: string[], io: CliIo): Promise<number> {
  const dirs = positional(args);
  const configPath = flag(args, "--config");
  if (dirs.length === 0 || !configPath) {
    io.err("aqa check-rules: <run-dir>... and --config <ai-quality.config.yaml> are required\n");
    return 1;
  }
  const config = await loadAgentConfig(configPath);
  const workspace = flag(args, "--workspace");
  let deadlocks = 0;
  for (const dir of dirs) {
    const events = readLedgerFile(join(dir, LEDGER_FILE));
    if (events.length === 0) {
      io.err(`aqa check-rules: no ledger in ${dir}\n`);
      continue;
    }
    const request = String(
      (events[0]?.payload as unknown as Record<string, unknown> | undefined)?.["text"] ?? "",
    );
    const ref = parseJiraKey(request) ?? parseWorkItemRef(request) ?? "";
    const tracker: Tracker = typeof normId(ref) === "string" ? "jira" : "ado";
    const skill = storyToTestsSkill({
      workItem: ref,
      ...(tracker === "jira" ? { tracker } : {}),
      ...((config.test_types ?? []).length > 0
        ? { testTypes: config.test_types as TestType[] }
        : {}),
      ...(workspace ? { workspaceDir: resolve(workspace) } : {}),
    });
    const r = replayRules(events, skill);
    io.out(
      `\n${r.runId}  "${request}"  — ${r.proposals} proposal(s), ${r.stillRefused} refused today\n`,
    );
    if (r.changed.length === 0) io.out("  every decision is the same today\n");
    for (const c of r.changed)
      io.out(
        `  #${c.eventId} ${c.toolName}: then ${c.then}, today ${c.now}${
          c.reason ? ` — ${c.reason}` : ""
        }\n`,
      );
    if (r.probe) {
      io.out(`  end point: route A2, still missing ${r.probe.missing.join(", ")}\n`);
      for (const t of r.probe.tried)
        io.out(
          `    ${t.refused ? "REFUSED" : "allowed"}  ${t.action}${
            t.refused ? ` — ${t.refused}` : ""
          }\n`,
        );
      if (r.probe.deadlock) {
        deadlocks++;
        io.out("  DEADLOCK: no way to write the missing item's test\n");
      }
    }
  }
  return deadlocks > 0 ? 2 : 0;
}
