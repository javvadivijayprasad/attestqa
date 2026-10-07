/**
 * Reading a Playwright JSON report into the signals triage needs.
 *
 * `PwTools.summarise()` already flattens the report into counts and a
 * title/file/message triple, and deliberately throws the rest away to keep the
 * model's context small. Triage needs the part it throws away: the stack, how
 * long the test took, and how many times the runner already retried it. Two of
 * the Python's three scoring adjustments read exactly those fields, so a triage
 * built on the flat summary would silently lose them and quietly disagree with
 * the service on the same run.
 *
 * So this is a second reader over the same file rather than a change to the
 * first. The summary is what the model sees; this is what the verifier sees.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FailureSignal } from "./classify.js";

/** Where PwTools persists the full report, relative to the workspace. */
export const REPORT_DIR = ".aqa-report";
export const REPORT_FILE = "playwright.json";

export function reportPath(workspaceDir: string): string {
  return join(resolve(workspaceDir), REPORT_DIR, REPORT_FILE);
}

/**
 * A failing test, with the identity quarantine will use.
 *
 * `testId` is the full path — file, then every enclosing suite title, then the
 * spec title, joined with " › ". A bare spec title is not an identity: two
 * files can both contain "rejects an expired code", and quarantining one must
 * not silently quarantine the other.
 */
export interface ParsedFailure extends FailureSignal {
  file: string;
  title: string;
}

/**
 * Strip ANSI colour codes.
 *
 * Playwright's reporter writes its assertion diffs coloured, so the raw message
 * for a failed `toBe` is `Error: \x1b[2mexpect(\x1b[22m...`. Two things
 * break on that. The patterns cannot match, because the escape sequences sit
 * between the words they are looking for. And the evidence string — the quote a
 * human reads in the ledger to see why a verdict was reached — comes out as
 * unreadable garbage.
 *
 * Found by running the real reporter rather than the JSON I had imagined it
 * produced; no synthetic fixture would have had colour in it.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

interface PwResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
}

interface PwTest {
  results?: PwResult[];
  status?: string;
}

interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  suites?: PwSuite[];
  specs?: PwSpec[];
}

/**
 * Parse a raw Playwright JSON report into failing tests.
 *
 * Returns an empty array for a report that parses but has no failures, and
 * `undefined` for one that does not parse at all. The caller must be able to
 * tell "nothing failed" from "I could not read this" — collapsing the two would
 * turn an unreadable report into a clean bill of health, which is the most
 * expensive possible bug in a verifier.
 */
export function parseFailures(raw: string): ParsedFailure[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof report !== "object" || report === null) return undefined;
  const suites = (report as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) return undefined;

  const out: ParsedFailure[] = [];
  walk(suites as PwSuite[], "", [], out);
  return out;
}

/** Read and parse the report from a workspace. `undefined` when absent or unreadable. */
export function readFailures(workspaceDir: string): ParsedFailure[] | undefined {
  const file = reportPath(workspaceDir);
  if (!existsSync(file)) return undefined;
  try {
    return parseFailures(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A cheap identity for the current report.
 *
 * Content-based rather than mtime-based: a re-run that produces byte-identical
 * results IS the same evidence, whatever the clock says, and a suite re-run
 * after an edit that changed nothing should not read as a new attempt. Hashing
 * a few hundred kilobytes once per cycle costs nothing next to the suite run
 * that produced it.
 */
export function reportFingerprint(workspaceDir: string): string | undefined {
  const file = reportPath(workspaceDir);
  if (!existsSync(file)) return undefined;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/**
 * When the report on disk was last written, or `undefined` if there is none.
 *
 * Needed because the report is a file in the workspace and files outlive runs.
 * A report left behind by yesterday's run is not evidence about today's, and
 * reading it as if it were is how run 20260918T161822Z-427cd725 stopped on its
 * FIRST cycle — quarantining a test it had not executed, on the strength of a
 * verdict belonging to a run that had already ended.
 */
export function reportMtimeMs(workspaceDir: string): number | undefined {
  const file = reportPath(workspaceDir);
  if (!existsSync(file)) return undefined;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function walk(suites: PwSuite[], file: string, titles: string[], out: ParsedFailure[]): void {
  for (const suite of suites) {
    if (typeof suite !== "object" || suite === null) continue;
    const f = suite.file ?? file;
    // A suite's own title is part of the path, but the top-level suite's title
    // is usually the file name — including it as well would read "login.spec.ts
    // › login.spec.ts › ...". Skip a title that is already the file.
    const path = suite.title && suite.title !== f ? [...titles, suite.title] : titles;

    for (const spec of suite.specs ?? []) {
      if (spec.ok !== false) continue;
      // A test marked expected-to-fail that PASSED is not a failure of the
      // product — it is news that a known bug may be fixed. Classifying it as a
      // failure produced a bug proposal "contradicting known Active bug #48"
      // (20260921T192908Z). It is reported as a finding instead; see
      // `isUnexpectedPass` and the pw adapter's summary.
      if (isUnexpectedPass(spec)) continue;
      const title = spec.title ?? "(untitled)";
      const last = lastResult(spec);
      out.push({
        file: f,
        title,
        testId: [f, ...path, title].filter(Boolean).join(" › "),
        message: last.message,
        stack: last.stack,
        durationMs: last.durationMs,
        retries: last.retries,
        flakyHistory: last.flakyHistory,
      });
    }

    if (suite.suites) walk(suite.suites, f, path, out);
  }
}

/**
 * The last attempt's error, how many attempts preceded it, and whether any of
 * them passed.
 *
 * The LAST result matters, not the first: Playwright appends a result per
 * attempt, and the final state is what the run ended on.
 *
 * ── Why `flakyHistory` is separate from `retries` ──
 * classifier.py nudges a failure toward `flake` when `retries > 0`, and its
 * comment says what it means by that: "Retries > 0 WITH A SUBSEQUENT PASS
 * HISTORY". The code only checks the count, which is fine wherever that count
 * arrives already meaning "this test has passed on a retry before".
 *
 * It is not fine here. `retries: 1` in playwright.config.js means every failing
 * test in every run reports one retry, whether or not it ever passed — the real
 * report from a four-test suite showed `results: failed,failed` on all three
 * failures. Under the count-only rule that boost fires on everything, and at
 * +0.25 it outscores almost every pattern bank: a plain `connect ECONNREFUSED`
 * came back classified `flake`.
 *
 * Worse, the count carries the opposite evidence to the one being claimed. A
 * test that was retried and failed again is LESS likely to be a flake, not
 * more. And a test that is genuinely flaky by Playwright's own definition
 * — failed, then passed on retry — never reaches this function at all, because
 * its spec is `ok: true`.
 *
 * So the condition the Python describes is made explicit: did an attempt of
 * this test actually pass? The count is still recorded, because it is worth
 * knowing, but it no longer means something it cannot know.
 */
function lastResult(spec: PwSpec): {
  message: string;
  stack: string;
  durationMs: number;
  retries: number;
  flakyHistory: boolean;
} {
  let message = "";
  let stack = "";
  let durationMs = 0;
  let retries = 0;
  let flakyHistory = false;

  for (const t of spec.tests ?? []) {
    const results = t.results ?? [];
    if (results.length === 0) continue;
    retries = Math.max(retries, results.length - 1, ...results.map((r) => r.retry ?? 0));
    if (results.some((r) => r.status === "passed")) flakyHistory = true;
    for (const r of results) {
      const err = r.error ?? r.errors?.[0];
      if (err?.message) {
        message = stripAnsi(err.message);
        stack = stripAnsi(err.stack ?? "");
        durationMs = r.duration ?? 0;
      }
    }
  }

  return { message, stack, durationMs, retries, flakyHistory };
}

/**
 * A test declared `test.fail()` — expected to fail because of a known bug —
 * that passed. Playwright marks it `unexpected` and fails the run, which is
 * correct for Playwright and wrong for triage: nothing about the product
 * failed. The known bug did not reproduce.
 */
export function isUnexpectedPass(spec: {
  tests?: Array<{ expectedStatus?: string; results?: Array<{ status?: string }> }>;
}): boolean {
  const t = spec.tests?.[0];
  if (!t || t.expectedStatus !== "failed") return false;
  const results = t.results ?? [];
  return results.length > 0 && results[results.length - 1]?.status === "passed";
}
