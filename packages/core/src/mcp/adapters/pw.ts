import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isUnexpectedPass } from "../../triage/report.js";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { FsTools } from "./fs.js";
import { execFileRunner, type CommandRunner } from "./process.js";

export interface PwOptions {
  runner?: CommandRunner;
  /** Command that runs Playwright. Default `npx playwright` (npx.cmd on Windows). */
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface TestRunSummary {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  /** True when the suite ran and nothing failed AND nothing was left unimplemented. */
  green: boolean;
  failures: Array<{
    title: string;
    file: string;
    message: string;
    /**
     * The page as it was when the test failed, from Playwright's own
     * error-context attachment.
     *
     * A locator that times out says only that nothing matched. The rendered
     * page says what was there instead — and it is written to disk on every
     * failure, unread. In 20260925T114717Z the snapshot held
     * `menuitem "Logout"` while the test looked for `a[href="#/logout"]`, and
     * three bugs were filed about a product that was working. Handing it back
     * with the failure is the difference between fixing a selector and
     * guessing at one.
     */
    pageAtFailure?: string;
  }>;
  /**
   * EVERY test, not just the failures — title, file, status and duration.
   *
   * `failures` alone was all this kept, because a red suite is the interesting
   * case. But the run report is composed from the ledger, so a GREEN suite
   * reached the story as a bare count: "5 passed", with no way to tell which
   * acceptance criteria were verified. The reader of a green run wants exactly
   * the list this omitted. ("we have playwright report generated right, if it
   * has why did not right results in comments".)
   *
   * Capped at MAX_TESTS_RECORDED so a thousand-test suite cannot put a
   * thousand rows into every ledger event; `testsOmitted` says how many were
   * left out rather than silently truncating.
   */
  tests: Array<{ title: string; file: string; status: TestStatus; durationMs: number }>;
  testsOmitted: number;
  /**
   * Tests declared expected-to-fail (`test.fail()`, for a known Active bug)
   * that PASSED. Not failures: the known bug did not reproduce, which is a
   * finding for a person — the bug may be fixed. `note` is the test's own
   * `fail` annotation, which is where the agent names the bug.
   */
  unexpectedPasses: Array<{ title: string; file: string; note: string }>;
  exitCode: number;
}

export type TestStatus = "passed" | "failed" | "skipped" | "flaky" | "unexpected-pass";

/**
 * Per-test rows kept in the ledger. High enough for a story's suite, low
 * enough that a monorepo-wide run does not bloat every event that carries it.
 */
export const MAX_TESTS_RECORDED = 200;

/**
 * In-process `pw` adapter: runs the workspace's Playwright suite and returns a
 * structured summary. This is the "run" in story → tests → run → Test Plans.
 *
 * Note what `green` means: a generated skeleton is `fixme`, which Playwright
 * reports as SKIPPED, so `skipped > 0` keeps `green` false. A suite that has
 * not actually been implemented can never be reported as passing.
 */
export class PwTools implements ToolClient {
  readonly server = "pw";
  private readonly fs: FsTools;
  private readonly workspace: string;
  private readonly runner: CommandRunner;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

  constructor(workspaceDir: string, opts: PwOptions = {}) {
    this.fs = new FsTools(workspaceDir);
    this.workspace = workspaceDir;
    this.runner = opts.runner ?? execFileRunner;
    this.command = opts.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
    this.baseArgs = opts.args ?? ["playwright", "test"];
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const spec = {
      type: "string",
      description: "Spec file or directory, workspace-relative. Omit to run the whole suite.",
    };
    return [
      {
        server: this.server,
        name: "list_tests",
        description: "List the tests Playwright would run, without running them.",
        inputSchema: { type: "object", properties: { spec } },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "run_tests",
        description:
          "Run the Playwright suite and return { passed, failed, skipped, flaky, green, failures[] }. Skipped counts unimplemented (fixme) tests, and any skipped test keeps green false.",
        inputSchema: {
          type: "object",
          properties: {
            spec,
            grep: { type: "string", description: "Only run tests whose title matches this." },
          },
        },
        policyClass: "write_workspace",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`not a pw tool: ${server}.${name}`);
    if (name !== "run_tests" && name !== "list_tests") return fail(`unknown pw tool: ${name}`);

    const extra: string[] = [];
    const spec = args["spec"];
    if (typeof spec === "string" && spec) {
      if (!this.fs.inside(spec)) return fail(`path escapes the workspace: ${spec}`);
      // On Windows the launcher goes through the command interpreter, so an
      // argument carrying shell punctuation is refused rather than escaped.
      if (SHELL_UNSAFE.test(spec)) return fail(`spec path contains unsafe characters: ${spec}`);
      extra.push(spec);
    }
    const grep = args["grep"];
    if (typeof grep === "string" && grep) {
      if (SHELL_UNSAFE.test(grep)) return fail(`grep contains unsafe characters: ${grep}`);
      extra.push("--grep", grep);
    }

    if (name === "list_tests") {
      const r = await this.runner(this.command, [...this.baseArgs, ...extra, "--list"], {
        cwd: this.workspace,
        timeoutMs: this.timeoutMs,
      });
      return {
        ok: r.code === 0,
        result: { exitCode: r.code, output: tail(r.stdout || r.stderr) },
        artefacts: [],
      };
    }

    const reportRel = join(".aqa-report", "playwright.json");
    const startedAt = Date.now();
    const r = await this.runner(
      this.command,
      [...this.baseArgs, ...extra, "--reporter=json"],
      // PLAYWRIGHT_JSON_OUTPUT_NAME would need env support in the runner; the
      // reporter also writes to stdout, which is what we parse. The file is
      // read when the project is configured to produce one.
      { cwd: this.workspace, timeoutMs: this.timeoutMs },
    );
    const reportAbs = join(this.workspace, reportRel);

    // THIS call's evidence, or nothing.
    //
    // The JSON reporter writes to stdout, and so does anything else in the
    // suite that prints — a globalSetup saying it registered the test account,
    // a console.log in a helper. The old test was "does stdout start with {";
    // one log line before the JSON made it fail, and the fallback read the
    // report FILE, which was the previous run's last filtered test. The runtime
    // then reported last run's single stale 401 as this run's full suite
    // (20261007T201833Z) while fourteen tests had actually run.
    //
    // So: find the JSON in stdout wherever it starts; and the file is accepted
    // only if Playwright wrote it during this call. An older file is someone
    // else's result, and no result is better than the wrong one.
    const fromStdout = extractJson(r.stdout);
    const fileIsFresh = existsSync(reportAbs) && statSync(reportAbs).mtimeMs >= startedAt - 1000;
    const raw = fromStdout ?? (fileIsFresh ? readFileSync(reportAbs, "utf8") : "");
    const summary = summarise(raw, r.code);
    if (!summary) {
      return fail(
        `Playwright produced no JSON report for this run (exit ${r.code})` +
          (existsSync(reportAbs) && !fileIsFresh
            ? " — a report file exists but predates this call and was not used"
            : "") +
          `. ${tail(r.stderr || r.stdout)}`,
      );
    }
    // A filter that matched nothing executed nothing, and "nothing" is not a
    // result.
    //
    // 20260928T091417Z ran `--grep "story:44"` — grep matches a test's TITLE,
    // and the tags live in the spec's comments — so Playwright ran zero tests,
    // exited 0, and the summary came back `0 passed, 0 failed, green: false`.
    // The terminal duly said "suite red — 0 passed, 0 failed", which is a
    // verdict about the product drawn from an empty measurement. A mistake that
    // reads as a finding is worse than an error, so this is an error.
    // Counted from the STATS, not from the per-test list. A Playwright report
    // can carry totals with no per-test detail (`stats: { expected: 4 }`,
    // `suites: []`), and reading "no test rows" as "no tests ran" turned a
    // perfectly good filtered run into an error — test/adapters.test.ts caught
    // it. Nothing ran is a claim about counts.
    const executed = summary.passed + summary.failed + summary.skipped + summary.flaky;
    if (typeof grep === "string" && grep && executed === 0)
      return fail(
        `--grep "${grep}" matched no tests, so nothing ran and there is nothing to conclude. ` +
          'grep matches a test\'s TITLE, not its tags and not its file: `--grep "@story:44"` finds ' +
          "nothing unless that text is in the title. Use pw.list_tests to see the titles as " +
          "Playwright sees them, then grep a distinctive part of one — or drop the filter and run " +
          "the suite.",
      );

    // Keep the full report, not just the summary. Per-test durations, retries
    // and error stacks are what a failure triage needs, they cannot be
    // reconstructed after the fact, and the flat summary deliberately throws
    // them away to keep the model's context small. When the reporter wrote to
    // stdout — which is the usual case — nothing had been persisting them at
    // all. Writing it as an artefact costs one file and makes the run's raw
    // evidence as durable as its conclusions.
    //
    // ── This ALWAYS overwrites, and that is the fix for a real bug ──
    // It used to be guarded with `!existsSync(reportAbs)`, on the reasoning
    // that a report Playwright itself had written should not be clobbered. The
    // effect was the opposite of durable: the first run a workspace ever did
    // froze the file, and every run afterwards left it untouched. Observed in
    // examples/sandbox, where a report from 14 September saying "5 passed, 0
    // failed" was still on disk on 18 September while the live suite was
    // reporting 4 passed, 1 failed — so triage read a stale green report,
    // correctly found no failures, and said nothing, three runs in a row.
    //
    // The failure mode is the dangerous kind: not a crash, but silence that
    // looks like agreement. This file is THIS call's evidence; anything already
    // there belongs to a run that is over.
    if (raw) {
      try {
        mkdirSync(dirname(reportAbs), { recursive: true });
        writeFileSync(reportAbs, raw, "utf8");
      } catch {
        // A workspace we cannot write to still has a usable summary; the
        // report is evidence we would like, not evidence we require.
      }
    }
    return {
      ok: true,
      result: summary,
      artefacts: existsSync(reportAbs) ? [reportRel] : [],
    };
  }
}

/**
 * The JSON document in a stream that may also carry log lines.
 *
 * Playwright's JSON reporter emits one object. Anything printed before it
 * (globalSetup, console.log) is noise; anything after it is too. Try each `{`
 * at a line start until one parses — the reporter's output is a single
 * top-level object, so the first that parses is it.
 */
export function extractJson(stdout: string): string | undefined {
  const text = stdout ?? "";
  if (text.trim().startsWith("{")) return text;
  let from = 0;
  for (;;) {
    const at = text.indexOf("\n{", from);
    if (at === -1) return undefined;
    const candidate = text.slice(at + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // The reporter's JSON may be followed by trailing output; try the
      // longest prefix that closes the object.
      const end = candidate.lastIndexOf("}");
      if (end > 0) {
        const trimmed = candidate.slice(0, end + 1);
        try {
          JSON.parse(trimmed);
          return trimmed;
        } catch {
          /* not this one */
        }
      }
      from = at + 1;
    }
  }
}

/** Parse Playwright's JSON reporter output into a flat summary. */
export function summarise(raw: string, exitCode: number): TestRunSummary | undefined {
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof report !== "object" || report === null) return undefined;
  const stats = (report as { stats?: Record<string, unknown> }).stats ?? {};
  const num = (k: string): number => (typeof stats[k] === "number" ? (stats[k] as number) : 0);
  const failures: TestRunSummary["failures"] = [];
  const tests: TestRunSummary["tests"] = [];
  const unexpectedPasses: TestRunSummary["unexpectedPasses"] = [];
  walkSuites(
    (report as { suites?: unknown[] }).suites ?? [],
    "",
    failures,
    tests,
    unexpectedPasses,
  );
  const testsOmitted = Math.max(0, tests.length - MAX_TESTS_RECORDED);
  const passed = num("expected");
  // Playwright counts an unexpected pass as `unexpected`; this runtime does not
  // count it as a failure.
  const failed = Math.max(
    0,
    (num("unexpected") || failures.length + unexpectedPasses.length) - unexpectedPasses.length,
  );
  const skipped = num("skipped");
  const flaky = num("flaky");
  return {
    passed,
    failed,
    skipped,
    flaky,
    // Playwright exits non-zero on an unexpected pass. When that is the ONLY
    // reason, every test did what the product should do, and the suite is green.
    green:
      (exitCode === 0 || (failed === 0 && unexpectedPasses.length > 0)) &&
      failed === 0 &&
      skipped === 0 &&
      flaky === 0 &&
      passed > 0,
    failures,
    tests: tests.slice(0, MAX_TESTS_RECORDED),
    testsOmitted,
    unexpectedPasses,
    exitCode,
  };
}

function walkSuites(
  suites: unknown[],
  file: string,
  out: TestRunSummary["failures"],
  rows: TestRunSummary["tests"],
  unexpected: TestRunSummary["unexpectedPasses"],
): void {
  for (const s of suites) {
    if (typeof s !== "object" || s === null) continue;
    const suite = s as {
      file?: string;
      suites?: unknown[];
      specs?: Array<{
        title?: string;
        ok?: boolean;
        tests?: Array<{
          status?: string;
          expectedStatus?: string;
          results?: Array<{
            status?: string;
            attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
          }>;
          annotations?: Array<{ type?: string; description?: string }>;
        }>;
      }>;
    };
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const title = spec.title ?? "(untitled)";
      rows.push({ title, file: f, status: statusOf(spec), durationMs: durationOf(spec) });
      if (isUnexpectedPass(spec)) {
        const note =
          spec.tests?.[0]?.annotations?.find((a) => a.type === "fail")?.description ?? "";
        unexpected.push({ title, file: f, note });
        continue;
      }
      if (spec.ok !== false) continue;
      const page = pageAtFailure(spec);
      out.push({
        title,
        file: f,
        message: firstError(spec),
        ...(page ? { pageAtFailure: page } : {}),
      });
    }
    if (suite.suites) walkSuites(suite.suites, f, out, rows, unexpected);
  }
}

/**
 * A spec's outcome.
 *
 * Playwright puts the verdict on the TEST ("expected", "unexpected", "flaky",
 * "skipped"), not on the spec, so this reads the first test's status and maps
 * it to the vocabulary the rest of this runtime already uses. `spec.ok` alone
 * cannot distinguish skipped from passed, and a run whose specs were all
 * `fixme` reporting "passed" would be the worst possible summary.
 */
function statusOf(spec: {
  ok?: boolean;
  tests?: Array<{ status?: string; expectedStatus?: string; results?: Array<{ status?: string }> }>;
}): TestStatus {
  if (isUnexpectedPass(spec)) return "unexpected-pass";
  const status = spec.tests?.[0]?.status;
  if (status === "skipped") return "skipped";
  if (status === "flaky") return "flaky";
  if (spec.ok === false || status === "unexpected") return "failed";
  return "passed";
}

function durationOf(spec: { tests?: Array<{ results?: unknown[] }> }): number {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      const d = (r as { duration?: unknown }).duration;
      if (typeof d === "number") return d;
    }
  }
  return 0;
}

/**
 * Playwright's error-context attachment: the accessibility snapshot of the
 * page at the moment the test failed. Trimmed to the part that matters — the
 * snapshot itself, not the source listing it also contains.
 */
function pageAtFailure(spec: {
  tests?: Array<{ results?: Array<{ attachments?: Array<{ name?: string; path?: string }> }> }>;
}): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      const a = (r.attachments ?? []).find((x) => x.name === "error-context" && x.path);
      if (!a?.path) continue;
      let text: string;
      try {
        text = readFileSync(a.path, "utf8");
      } catch {
        continue;
      }
      // The file is markdown: a fenced yaml block with the page, then the
      // source around the failing line. The page is what cannot be guessed.
      const yaml = /```yaml\n([\s\S]*?)```/.exec(text)?.[1];
      const body = (yaml ?? text).trim();
      return body.length > PAGE_SNAPSHOT_CHARS
        ? `${body.slice(0, PAGE_SNAPSHOT_CHARS)}\n… (snapshot truncated)`
        : body;
    }
  }
  return undefined;
}

/** Enough of the page to find the control; not so much that it drowns the step. */
const PAGE_SNAPSHOT_CHARS = 4000;

function firstError(spec: { tests?: Array<{ results?: unknown[] }> }): string {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      const res = r as { error?: { message?: string }; errors?: Array<{ message?: string }> };
      const err = res.error;
      // Head, not tail, and without the terminal colour codes: the first line
      // of a Playwright error is the one that names the problem, and the tail
      // of a coloured one began "…22m failed" — escape-code debris.
      if (!err?.message) continue;
      const first = head(stripAnsi(err.message), 600);
      // On a TEST timeout, Playwright's first error is only "Test timeout of
      // 30000ms exceeded." — the action that was stuck, and the locator it was
      // waiting for, are in a later entry of `errors`. Without it the heal step
      // could not say which selector failed (run 20261011T230623Z: "failed
      // selector: (not named in the error message)" for a click waiting on
      // getByRole('button', { name: 'Log in' })).
      const stuck = (res.errors ?? [])
        .map((e) => stripAnsi(e.message ?? ""))
        .find((m) => m !== stripAnsi(err.message ?? "") && /waiting for|Call log/i.test(m));
      return stuck ? `${first}\n${head(stuck, 600)}` : first;
    }
  }
  return "";
}

/** Characters that mean something to a command interpreter. */
const SHELL_UNSAFE = /[&|<>^"'`$;%\r\n]/;

/** Terminal colour and style sequences, which a report renders as debris. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function head(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function tail(s: string, max = 2000): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
