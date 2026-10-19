import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyRunEvent, TriagePayload } from "../types.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import { isPartialRead, testsByTitle } from "../design/test-design.js";

/**
 * Quarantine: the ONE definition, used by triage, the write guard and the
 * verifier (F2/F3 in docs/ENGINE_MAP.md).
 *
 * A quarantined test is one the agent may no longer change the claims of,
 * because its failure is evidence about the product. Two rules decided that
 * differently — triage required confidence above 0.1, the write guard took any
 * `real-defect` — and neither asked whether the test had ever been shown to
 * match the application. A test written minutes earlier that fails on its
 * first run is far more likely wrong than the product, and freezing it froze
 * the agent's mistake (20261018T223256Z: an invented URL check; the
 * accessibility scan).
 *
 * So a failure is quarantined only when the verdict is a confident product
 * defect AND the test is PROVEN: it passed earlier in this run, it existed
 * before this run (the execute path, or a scenario locked when a run was
 * re-routed to complete a design), or it is a known bug's confirmation test
 * (`test.fail(...)` / `@bug:`).
 */

/** "file › suite › title" → "title". */
export function titleOf(test: string): string {
  return test.split("›").pop()?.trim() ?? test;
}

export interface Proven {
  /** Every test is proven (the execute path: they all existed before the run). */
  all: boolean;
  titles: Set<string>;
  /** With `all`: tests that are nevertheless not proven. */
  except?: Set<string>;
}

export function provenTests(events: AnyRunEvent[], workspaceDir?: string): Proven {
  const titles = new Set<string>();
  let route: Record<string, unknown> | undefined;
  for (const e of events)
    if (e.kind === "route") route = e.payload as unknown as Record<string, unknown>;
  const unverifiedB = asRecord(asRecord(route?.["because"])?.["unverifiedTests"]) !== undefined;
  if (route && route["path"] === "B" && !unverifiedB) {
    // A reused design's tests that were still failing when that run ended
    // have never been shown to work: they are repaired, not frozen.
    const notYet = asArray(asRecord(route["because"])?.["previousFailing"]).map((t) =>
      titleOf(String(t)),
    );
    if (notYet.length === 0) return { all: true, titles };
    // Passing in this run proves them after all.
    for (const c of successful(completedCalls(events), "pw.run_tests"))
      for (const t of asArray(asRecord(c.result)?.["tests"])) {
        const r = asRecord(t);
        if (r?.["status"] === "passed" && typeof r["title"] === "string")
          titles.add(titleOf(r["title"]));
      }
    return { all: true, titles, except: new Set(notYet) };
  }

  // Scenarios that existed when the run switched to completing a design.
  const because = asRecord(route?.["because"]);
  for (const l of asArray(because?.["locked"])) {
    const s = asRecord(l)?.["scenario"];
    if (typeof s === "string") titles.add(s.trim());
  }

  // Passed in some earlier run of this run.
  for (const c of successful(completedCalls(events), "pw.run_tests"))
    for (const t of asArray(asRecord(c.result)?.["tests"])) {
      const r = asRecord(t);
      if (r?.["status"] === "passed" && typeof r["title"] === "string")
        titles.add(titleOf(r["title"]));
    }

  // A known bug's test: it is written to fail until the bug is fixed.
  for (const text of specTexts(events, workspaceDir))
    for (const [title, body] of testsByTitle(text))
      if (/\btest\.fail\s*\(|@bug:/.test(body)) titles.add(title);

  return { all: false, titles };
}

export function isProven(test: string, proven: Proven): boolean {
  const t = titleOf(test);
  if (proven.all) return !proven.except?.has(t) || proven.titles.has(t);
  return proven.titles.has(t);
}

/** Every test triage has quarantined in this run, by title. Once quarantined, it stays so. */
export function quarantinedTitles(events: AnyRunEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "triage") continue;
    const p = e.payload as unknown as TriagePayload;
    for (const t of p.quarantined ?? []) out.add(titleOf(t));
  }
  return out;
}

function specTexts(events: AnyRunEvent[], workspaceDir?: string): string[] {
  const byPath = new Map<string, string>();
  for (const c of completedCalls(events)) {
    if (!c.ok) continue;
    const path = String(c.args["path"] ?? "");
    if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) continue;
    const text =
      c.toolName === "fs.write_file"
        ? c.args["content"]
        : c.toolName === "fs.read_file"
          ? asRecord(c.result)?.["content"]
          : undefined;
    if (typeof text === "string") byPath.set(path, text);
  }
  if (workspaceDir) {
    const dir = join(workspaceDir, "tests");
    try {
      if (existsSync(dir))
        for (const f of readdirSync(dir))
          if (/\.spec\.[cm]?[jt]sx?$/.test(f) && !byPath.has(`tests/${f}`))
            byPath.set(`tests/${f}`, readFileSync(join(dir, f), "utf8"));
    } catch {
      /* unreadable: the ledger's copies are what we have */
    }
  }
  return [...byPath.values()];
}

/**
 * How many repairs a failing test gets (item 4 in docs/ENGINE_MAP.md §11).
 * Three: after three changes to the test, each followed by a full run it still
 * failed, guessing has stopped helping — runs 20261018T115605Z, 154651Z and
 * 223256Z each spent the rest of their budget on the same one or two tests.
 *
 * Counted per test, by changes to THAT test. The first version counted failing
 * full runs, and in 20261019T144404Z three tests were "exhausted" before
 * anyone had touched them: the runs in between were set off by a page-object
 * URL and an import line, and the first real repair of each test was refused.
 */
export const MAX_REPAIRS_PER_TEST = 3;
/** @deprecated the cap counts repairs now; kept for importers. */
export const MAX_FAILING_RUNS_PER_TEST = MAX_REPAIRS_PER_TEST;

/**
 * The full suite runs of a run, in order, each with the tests whose own body
 * changed since the previous full run. Newer ledgers record the changed tests
 * in the fs result (`changedTests`); for older ones they are worked out from
 * the last complete view of the file, when the run had one.
 */
export function fullRunsWithChanges(
  events: AnyRunEvent[],
): Array<{ passed: Set<string>; failed: Set<string>; changedBefore: Set<string> }> {
  const out: Array<{ passed: Set<string>; failed: Set<string>; changedBefore: Set<string> }> = [];
  let touched = new Set<string>();
  const content = new Map<string, string>();
  const isSpec = (p: string) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);
  const diff = (before: string | undefined, after: string): string[] | undefined => {
    if (before === undefined) return undefined;
    const squash = (x: string) => x.replace(/\s+/g, " ").trim();
    const was = testsByTitle(before);
    const now = testsByTitle(after);
    const changed = [...now]
      .filter(([t, b]) => was.get(t) === undefined || squash(was.get(t) as string) !== squash(b))
      .map(([t]) => t);
    for (const t of was.keys()) if (!now.has(t)) changed.push(t);
    return changed;
  };
  for (const c of completedCalls(events)) {
    if (!c.ok) continue;
    const path = String(c.args["path"] ?? "");
    const result = asRecord(c.result);
    if (c.toolName === "fs.read_file" && isSpec(path)) {
      const text = result?.["content"];
      if (typeof text === "string" && !isPartialRead(c.args, c.result)) content.set(path, text);
      continue;
    }
    if ((c.toolName === "fs.write_file" || c.toolName === "fs.replace_in_file") && isSpec(path)) {
      let next: string | undefined;
      if (c.toolName === "fs.write_file") next = String(c.args["content"] ?? "");
      else {
        const before = content.get(path);
        const o = c.args["old"];
        const n = c.args["new"];
        if (before !== undefined && typeof o === "string" && typeof n === "string")
          next = c.args["all"] === true ? before.split(o).join(n) : before.replace(o, () => n);
      }
      const recorded = asArray(result?.["changedTests"]).filter(
        (t): t is string => typeof t === "string",
      );
      const changed =
        result?.["changedTests"] !== undefined
          ? recorded
          : next !== undefined
            ? diff(content.get(path), next)
            : undefined;
      for (const t of changed ?? []) touched.add(titleOf(t));
      if (next !== undefined) content.set(path, next);
      else content.delete(path);
      continue;
    }
    if (c.toolName === "bdd2pw.scaffold") {
      // A regenerated spec is a new starting point, not a repair.
      content.clear();
      continue;
    }
    if (c.toolName !== "pw.run_tests" || !FULL(c.args)) continue;
    const passed = new Set<string>();
    const failed = new Set<string>();
    for (const t of asArray(result?.["tests"])) {
      const r = asRecord(t);
      if (!r || typeof r["title"] !== "string") continue;
      const title = titleOf(r["title"]);
      if (r["status"] === "passed" || r["status"] === "expected") passed.add(title);
      else if (r["status"] === "failed" || r["status"] === "timedOut") failed.add(title);
    }
    out.push({ passed, failed, changedBefore: touched });
    touched = new Set();
  }
  return out;
}

/** Tests (by title) that have failed a full run after each of MAX_REPAIRS_PER_TEST repairs. */
export function exhaustedTests(events: AnyRunEvent[]): Set<string> {
  const failedRepairs = new Map<string, number>();
  for (const run of fullRunsWithChanges(events))
    for (const title of run.failed)
      if (run.changedBefore.has(title))
        failedRepairs.set(title, (failedRepairs.get(title) ?? 0) + 1);
  const out = new Set<string>();
  for (const [title, n] of failedRepairs) if (n >= MAX_REPAIRS_PER_TEST) out.add(title);
  return out;
}

/**
 * Tests failing in the last full run that passed in an earlier full run of
 * this run and have been edited since. The product did not change between
 * those runs; the test did. A bug resting on such a failure blames the product
 * for the edit — 20261019T155404Z proposed "page 2 shows the same products as
 * page 1" three times after rewriting a test that had passed.
 */
export function regressedByEdit(events: AnyRunEvent[]): Set<string> {
  const runs = fullRunsWithChanges(events);
  const last = runs[runs.length - 1];
  if (!last) return new Set();
  const out = new Set<string>();
  for (const title of last.failed) {
    let passedAt = -1;
    runs.forEach((r, i) => {
      if (i < runs.length - 1 && r.passed.has(title)) passedAt = i;
    });
    if (passedAt < 0) continue;
    if (runs.slice(passedAt + 1).some((r) => r.changedBefore.has(title))) out.add(title);
  }
  return out;
}

const FILTER_ARGS = [
  "grep",
  "grepInvert",
  "grep-invert",
  "shard",
  "project",
  "lastFailed",
  "last-failed",
];
function FULL(args: Record<string, unknown>): boolean {
  return !FILTER_ARGS.some((k) => args[k] !== undefined && args[k] !== "");
}
