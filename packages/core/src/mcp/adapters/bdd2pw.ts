import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { FsTools } from "./fs.js";
import { execFileRunner, type CommandRunner } from "./process.js";

/**
 * `bdd2pw` adapter — a translator, not an implementation.
 *
 * It runs `@vijaypjavvadi/bdd2pw`, which turns a Gherkin feature file into
 * RUNNABLE Playwright TypeScript: it scans the live page, binds each step to a
 * real locator, and emits Page Objects plus a spec. It parses Gherkin with
 * `@cucumber/gherkin` and emits through `@vijaypjavvadi/pw-emit`.
 *
 * ── What this replaced ──
 * The previous version of this file contained its own `parseFeature` — about
 * ninety lines of regular expressions — and its own `renderSpec`, which emitted
 * a skeleton where every step was `// TODO: implement` and every test was
 * `fixme`. It was named `bdd2pw` and was not bdd2pw. Two consequences, both
 * observed:
 *
 *   - the agent had to find every selector itself, by hand, through
 *     `browser_navigate` and `browser_snapshot`, one inference at a time, with
 *     no Page Objects, no cache and no healing telemetry;
 *   - a fix shipped in bdd2pw never reached agentic-qa, because agentic-qa had
 *     never heard of bdd2pw.
 *
 * An adapter owns no domain logic. Everything below is naming, argument
 * validation, invocation and result normalisation. If this file starts
 * containing Gherkin knowledge again, it has stopped being an adapter.
 *
 * ── The one rule that is not negotiable ──
 * `--llm-skip-governance` is never constructed here, under any option, by any
 * code path. bdd2pw sanitises every prompt through the ai-governance sidecar
 * before it leaves the perimeter and fails closed if the sidecar is down. That
 * property is the reason the LLM path is safe to offer at all, and a test-only
 * escape hatch reachable from an agent is not a test-only escape hatch.
 */

export interface Bdd2PwOptions {
  runner?: CommandRunner;
  /** Command that runs bdd2pw. Default `npx bdd2pw` (npx.cmd on Windows). */
  command?: string;
  args?: string[];
  timeoutMs?: number;
  /**
   * Enable bdd2pw's LLM fallback for steps its rules cannot bind.
   *
   * Set by the CLI only when a governance sidecar is actually reachable — see
   * `governanceUrl`. Absent, scaffolding runs discovery-only and unbound steps
   * land as TODO, which is degraded rather than broken.
   */
  llm?: "anthropic" | "openai" | "gemini";
  /** ai-governance sidecar. Required whenever `llm` is set; bdd2pw fails closed without it. */
  governanceUrl?: string;
  /** Override bdd2pw's default model for the fallback. Optional. */
  llmModel?: string;
  /** Pre-authenticated storage state, for pages behind a login. */
  storageState?: string;
}

/** Every generated-code file under a scaffold target, with its size and mtime. */
function snapshot(workspace: string, repo: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ["tests", "pages"]) {
    const root = join(workspace, repo, dir);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = `${repo === "." ? "" : `${repo}/`}${dir}/${e}`;
      try {
        const st = statSync(join(root, e));
        if (st.isFile()) out.set(rel, `${st.size}:${st.mtimeMs}`);
      } catch {
        // A file that vanished between listing and stat is not a file we wrote.
      }
    }
  }
  return out;
}

/** Paths created or modified since `before`, in listing order. */
function changedSince(workspace: string, repo: string, before: Map<string, string>): string[] {
  const now = snapshot(workspace, repo);
  const out: string[] = [];
  for (const [path, stamp] of now) if (before.get(path) !== stamp) out.push(path);
  return out;
}

/** Characters that mean something to a command interpreter. */
const SHELL_UNSAFE = /[&|<>^"'`$;%\r\n]/;

export class Bdd2PwTools implements ToolClient {
  readonly server = "bdd2pw";
  private readonly fs: FsTools;
  private readonly workspace: string;
  private readonly runner: CommandRunner;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;
  private readonly opts: Bdd2PwOptions;

  constructor(workspaceDir: string, opts: Bdd2PwOptions = {}) {
    this.fs = new FsTools(workspaceDir);
    this.workspace = workspaceDir;
    this.runner = opts.runner ?? execFileRunner;
    this.command = opts.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
    this.baseArgs = opts.args ?? ["bdd2pw"];
    // Scaffolding launches a browser and may call an LLM per unbound step, so
    // this is minutes rather than seconds. bdd2pw has its own per-step deadline.
    this.timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
    this.opts = opts;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const feature = {
      type: "string",
      description: "Path to a .feature file, workspace-relative.",
    };
    const url = {
      type: "string",
      description:
        "URL of the page under test. bdd2pw opens it to find real locators, so the " +
        "application must be running and the URL must be inside agent.scope.urls.",
    };
    return [
      {
        server: this.server,
        name: "analyze",
        description:
          "Dry run: parse a .feature file, scan the page at --url, and report which steps " +
          "bdd2pw can bind to a locator and which it cannot. Writes nothing. Use this to see " +
          "whether a feature file will scaffold cleanly before committing to it.",
        inputSchema: {
          type: "object",
          properties: { feature, url },
          required: ["feature", "url"],
        },
        policyClass: "read",
        scopeArgs: { url: "url" },
      },
      {
        server: this.server,
        name: "scaffold",
        description:
          "Turn a .feature file into RUNNABLE Playwright TypeScript: scans the page at --url, " +
          "binds each Gherkin step to a real locator, and writes Page Objects plus a spec into " +
          "the workspace. This is how specs are produced — do not hand-write a .spec.ts. Steps " +
          "bdd2pw cannot bind are left as TODO for you to implement.",
        inputSchema: {
          type: "object",
          properties: {
            feature,
            url,
            page: {
              type: "string",
              description: 'Page Object class name, PascalCase, e.g. "LoginPage".',
            },
            pages: {
              type: "string",
              description: "Comma-separated additional Page Object names, when a flow spans pages.",
            },
          },
          required: ["feature", "url"],
        },
        policyClass: "write_workspace",
        scopeArgs: { url: "url" },
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`not a bdd2pw tool: ${server}.${name}`);
    if (name !== "scaffold" && name !== "analyze") return fail(`unknown bdd2pw tool: ${name}`);

    const feature = str(args["feature"]);
    if (!feature) return fail(`bdd2pw.${name} requires "feature"`);
    if (!this.fs.inside(feature)) return fail(`path escapes the workspace: ${feature}`);
    if (SHELL_UNSAFE.test(feature)) return fail(`feature path contains unsafe characters`);
    if (!existsSync(join(this.workspace, feature))) return fail(`no such feature file: ${feature}`);

    const url = str(args["url"]);
    if (!url) return fail(`bdd2pw.${name} requires "url" — it scans the page to find locators`);
    if (SHELL_UNSAFE.test(url)) return fail(`url contains unsafe characters`);

    const extra: string[] = [feature, "--url", url];

    if (name === "scaffold") {
      extra.push("--repo", repoForFeature(feature));
      // The spec is named after the FEATURE file, not the page object
      // (bdd2pw 4.4+). One feature file per epic means one spec per epic, at
      // the path every rule and the verifier expect — run 20260925T151945Z
      // spent its budget looking for a spec bdd2pw had named after the page.
      extra.push("--spec-name", specStemFor(feature));
      for (const [flag, key] of [
        ["--page", "page"],
        ["--pages", "pages"],
      ] as const) {
        const v = str(args[key]);
        if (v === undefined) continue;
        if (SHELL_UNSAFE.test(v)) return fail(`${key} contains unsafe characters`);
        extra.push(flag, v);
      }
      if (this.opts.storageState) extra.push("--storage-state", this.opts.storageState);
      if (this.opts.llmModel) {
        if (SHELL_UNSAFE.test(this.opts.llmModel))
          return fail("llmModel contains unsafe characters");
        extra.push("--llm-model", this.opts.llmModel);
      }
      // LLM fallback, and only with a governance endpoint. bdd2pw fails closed
      // on its own, but constructing the pair here means the two can never be
      // separated by a future edit to this file.
      if (this.opts.llm && this.opts.governanceUrl) {
        extra.push("--llm", this.opts.llm, "--governance-url", this.opts.governanceUrl);
      }
    }

    // What the generator is about to touch, as it is now. Compared afterwards,
    // this is how the result can NAME the files bdd2pw wrote instead of the
    // directory it probably wrote them in.
    const repo = name === "scaffold" ? repoForFeature(feature) : undefined;
    const before = repo ? snapshot(this.workspace, repo) : undefined;

    const r = await this.runner(this.command, [...this.baseArgs, name, ...extra], {
      cwd: this.workspace,
      timeoutMs: this.timeoutMs,
    });

    const output = tail(r.stdout || r.stderr);
    if (r.code !== 0) {
      return {
        ok: false,
        result: { message: `bdd2pw ${name} failed (exit ${r.code})`, output },
        artefacts: [],
      };
    }

    // Steps bdd2pw could not bind, named rather than counted in prose. The
    // generator reports them as warnings on stdout; a run that reads them can
    // decide whether the feature file is ready instead of discovering 42 TODOs
    // in a generated spec afterwards (20260925T151945Z).
    const unbound = unboundSteps(r.stdout || r.stderr);

    return {
      ok: true,
      result: {
        exitCode: r.code,
        output,
        unboundCount: unbound.length,
        ...(unbound.length > 0 ? { unbound: unbound.slice(0, 20) } : {}),
        // Where the generated files actually landed. The agent guessed this
        // last time and guessed wrong; saying it removes the guess.
        ...(name === "scaffold" && repo
          ? {
              repo,
              specDir: join(repo, "tests"),
              pageObjectDir: join(repo, "pages"),
              // The files that actually changed on disk, by path. bdd2pw names
              // a spec after the page object, not after the feature file, so
              // 20260925T151945Z generated `tests/login.spec.ts` while the
              // agent spent the rest of its budget looking for the epic spec
              // it expected. A generated file nobody can find is a generated
              // file that does not exist.
              wrote: changedSince(this.workspace, repo, before ?? new Map()),
              // Where each step's code came from, counted from bdd2pw's own
              // `// @bdd2pw lane=…` comments (4.4.1 contract): a rule, the
              // governed LLM fallback, or nothing yet (TODO).
              provenance: provenanceOf(
                this.workspace,
                changedSince(this.workspace, repo, before ?? new Map()).filter((f) =>
                  /\.spec\.[cm]?[jt]s$/.test(f),
                ),
              ),
              // Locators bdd2pw could not resolve and wrote as `locator("")`.
              // Run 20261011T222522Z: a re-scaffold without a browser blanked all
              // 53 page-object locators, and every test that used one failed on
              // an unparseable selector. Said here so nobody has to find it.
              ...emptyLocatorReport(
                this.workspace,
                changedSince(this.workspace, repo, before ?? new Map()),
              ),
            }
          : {}),
        // Whether the LLM fallback was available at all, so a run that left
        // steps unbound can say WHY rather than leaving the reader to guess.
        llmFallback: this.opts.llm && this.opts.governanceUrl ? this.opts.llm : "disabled",
      },
      artefacts: [],
    };
  }
}

/**
 * The steps bdd2pw says it cannot bind, from its own findings on stdout.
 *
 * bdd2pw emits JSON findings with a severity and a message; a warning whose
 * message names an unmatched step is what becomes a `// TODO` in the generated
 * spec. Parsed leniently — this is a report, and a shape change in it must
 * degrade to "none found" rather than to a crash.
 */
export function unboundSteps(out: string): string[] {
  const found: string[] = [];
  for (const m of out.matchAll(
    /"severity"\s*:\s*"(warn|error)"\s*,\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  )) {
    const message = (m[2] ?? "").replace(/\\"/g, '"').replace(/\\n/g, " ");
    if (
      /no rule matched|could not bind|unmatched step|ambiguous .*step|no POM field matched/i.test(
        message,
      )
    )
      found.push(message.slice(0, 200));
  }
  return found;
}

/**
 * The Playwright repo bdd2pw should write into, derived from where the feature
 * file lives.
 *
 * ── Why this is not just "." ──
 * It was "." — the workspace root — and run 20260918T221233Z blocked on it.
 * The agent wrote its feature to `examples/sandbox/features/login.feature`,
 * scaffolded it, and bdd2pw duly emitted `tests/login.spec.ts` and
 * `pages/login.page.ts` at the REPO ROOT, two directories away. The agent then
 * looked for its spec beside its feature, found the stale one a previous run
 * had left there, read it three times trying to reconcile what it saw with
 * what it had just generated, and the no-progress detector stopped the run.
 *
 * Nothing refused, nothing failed, no error anywhere: the generator wrote a
 * perfectly good spec into a place nobody was looking. A Playwright repo is a
 * `playwright.config.ts` with `tests/` and `pages/` beside it, so the repo is
 * wherever the feature's own `features/` directory sits — not wherever the
 * process happens to have been started.
 */
export function repoForFeature(feature: string): string {
  const parts = feature.split(/[\\/]/).filter((p) => p.length > 0 && p !== ".");
  // Drop the file itself, then a trailing `features/` if the convention was
  // followed. `a/b/features/x.feature` -> `a/b`; `a/b/x.feature` -> `a/b`.
  parts.pop();
  if (parts[parts.length - 1]?.toLowerCase() === "features") parts.pop();
  return parts.length === 0 ? "." : parts.join("/");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function tail(s: string, max = 4000): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}

/** `features/epic-scrum-5-x.feature` → `epic-scrum-5-x`. */
export function specStemFor(feature: string): string {
  const base = feature.split(/[\\/]/).pop() ?? feature;
  return base.replace(/\.feature$/i, "");
}

/**
 * Counts of bdd2pw's per-step provenance lanes in the given spec files, read
 * from the `// @bdd2pw lane=rule|llm|todo …` comment bdd2pw writes as the first
 * line of each step (docs/PROVENANCE_CONTRACT.md in bdd2pw, SemVer-covered).
 */
export function provenanceOf(
  workspace: string,
  specs: string[],
): { rule: number; llm: number; todo: number } {
  const out = { rule: 0, llm: 0, todo: 0 };
  for (const f of specs) {
    let text = "";
    try {
      text = readFileSync(join(workspace, f), "utf8");
    } catch {
      continue;
    }
    out.rule += countLane(text, "rule");
    out.llm += countLane(text, "llm");
    out.todo += countLane(text, "todo");
  }
  return out;
}

export function countLane(text: string, lane: "rule" | "llm" | "todo"): number {
  return [...text.matchAll(new RegExp(`^\\s*//\\s*@bdd2pw\\s+lane=${lane}\\b`, "gm"))].length;
}

/** `locator("")` / `locator('')` in generated files: selectors bdd2pw left empty. */
export function countEmptyLocators(text: string): number {
  return [...text.matchAll(/\blocator\(\s*(""|'')\s*\)/g)].length;
}

function emptyLocatorReport(
  workspace: string,
  files: string[],
): { emptyLocators?: Record<string, number>; warning?: string } {
  const found: Record<string, number> = {};
  for (const f of files) {
    if (!/\.[cm]?[jt]s$/.test(f)) continue;
    let text = "";
    try {
      text = readFileSync(join(workspace, f), "utf8");
    } catch {
      continue;
    }
    const n = countEmptyLocators(text);
    if (n > 0) found[f] = n;
  }
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  if (total === 0) return {};
  return {
    emptyLocators: found,
    warning:
      `${total} locator(s) were written EMPTY (locator("")) in ${Object.keys(found).join(", ")}. ` +
      "Any step that uses one fails with 'while parsing css selector \"\"' — that is the " +
      "generator, not the application. Do not use those fields; find the element with " +
      "aqa.heal_locator or the page snapshot and use a getByRole / getByLabel locator instead.",
  };
}
