/**
 * When is running the suite again worth a step?
 *
 * ── Why this is one predicate and not two opinions ──
 * The runtime decides for itself when to run the suite (`Skill.autoRun`), and
 * the story rules decide when the model may not. Those are the same question
 * asked from two sides, and in 20260928T082428Z they disagreed: the runtime ran
 * the suite, the model then ran the identical suite again with nothing changed
 * in between, and the third run was the runtime's once an edit had landed. Two
 * useful runs, one wasted, no rule against it — because the condition lived
 * inside the skill and nothing else could see it.
 *
 * So it lives here, once. `suiteChangedSinceLastFullRun` answers "would a run
 * now see anything new?", and both callers take their answer from it.
 */

import type { AnyRunEvent } from "../types.js";
import { completedCalls, successful } from "../verify/evidence.js";

/**
 * Arguments that make a run a FILTERED one: it proves a test, not the suite.
 *
 * A `grep`-ed run belongs to whoever is repairing one test. It is never the
 * baseline a report or a triage is counted from, and it never satisfies "the
 * suite has run".
 */
export const FILTERED = [
  "grep",
  "grepInvert",
  "grep-invert",
  "shard",
  "project",
  "lastFailed",
  "last-failed",
];

/** Is this a whole-suite run, as opposed to one narrowed to a test? */
export function isFullRun(args: Record<string, unknown>): boolean {
  return !FILTERED.some((k) => args[k] !== undefined && args[k] !== "");
}

/** Files whose content can change what the suite does. */
// The files whose change alters what a run EXECUTES. A .feature file is not
// one of them: Playwright runs the generated spec, and an edited scenario
// changes nothing until bdd2pw.scaffold regenerates the spec from it — which is
// counted below. Run 20261012T001248Z re-ran an unchanged suite seven times,
// once after every feature-file edit.
const SUITE_FILE = /\.(spec|test|page)\.[cm]?[jt]sx?$/i;

export interface RerunState {
  /** The ledger event id of the last unfiltered run, when there was one. */
  lastFullRun?: number;
  /** Suite files written since that run — the reason another run would differ. */
  changed: string[];
  /**
   * The one run of unchanged bytes that IS worth a step: the suite's first
   * failure, run again before anything is judged.
   *
   * Triage answers a first failing report with "run it again unchanged" — a
   * first failure does not tell a flake or a slow start from a defect — and
   * `staleRerun` refused exactly that run, in every run that reached it
   * (20261113T224736Z, …232526Z, 20261114T011832Z: the note at one event, the
   * refusal four events later). The runtime now makes that run itself, and the
   * gate lets it through, from this one flag: the latest triage is the run's
   * first, it found failures, and no full run has happened since.
   */
  retryOwed: boolean;
}

/**
 * What has happened to the suite since it last ran in full.
 *
 * `lastFullRun` absent means it has never run: the first run is always worth
 * making. `changed` empty with `lastFullRun` set means a second run would
 * execute the same bytes against the same application and print the same
 * numbers.
 */
export function suiteChangedSinceLastFullRun(events: AnyRunEvent[]): RerunState {
  const calls = completedCalls(events);
  const runs = successful(calls, "pw.run_tests").filter((c) => isFullRun(c.args));
  const last = runs[runs.length - 1];
  if (!last) return { changed: [], retryOwed: false };
  const changed = calls
    .filter(
      (c) =>
        c.ok &&
        (c.toolName === "fs.write_file" || c.toolName === "fs.replace_in_file") &&
        SUITE_FILE.test(String(c.args["path"] ?? "")) &&
        c.eventId > last.eventId,
    )
    .map((c) => String(c.args["path"] ?? ""));
  // A scaffold after the last run regenerated the spec: that does change it.
  for (const c of calls)
    if (c.ok && c.toolName === "bdd2pw.scaffold" && c.eventId > last.eventId)
      changed.push(`spec regenerated from ${String(c.args["feature"] ?? "the feature file")}`);
  const triage = [...events].reverse().find((e) => e.kind === "triage");
  const verdict = triage?.payload as
    { attempt?: number; cleared?: boolean; verdicts?: unknown[] } | undefined;
  const retryOwed =
    changed.length === 0 &&
    triage !== undefined &&
    triage.eventId > last.eventId &&
    verdict?.attempt === 1 &&
    verdict.cleared !== true &&
    (verdict.verdicts?.length ?? 0) > 0;
  return { lastFullRun: last.eventId, changed: [...new Set(changed)], retryOwed };
}

/** "a.spec.ts and 2 more", for a refusal or a why-line. */
export function nameChanged(changed: string[]): string {
  const first = changed[0] ?? "";
  return changed.length > 1 ? `${first} and ${changed.length - 1} more` : first;
}
