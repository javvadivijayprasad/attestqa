import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AnyRunEvent } from "../types.js";
import { readLedgerFile, LEDGER_FILE } from "../ledger/ledger.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";

const FILTER_ARGS = [
  "grep",
  "grepInvert",
  "grep-invert",
  "shard",
  "project",
  "lastFailed",
  "last-failed",
];
import { sameId } from "./ids.js";
import { storyFacts, type StoryFacts } from "./test-design.js";

/**
 * A story that has not changed is not designed again (item 7 in
 * docs/ENGINE_MAP.md §11).
 *
 * A real team runs a story once; until the story changes nobody reruns its
 * design. Every rerun so far asked for a fresh design, reworded it, and asked
 * the reviewer to approve the same tests again. The fingerprint is what the
 * design was checked against — title, acceptance criteria (their labels AND
 * their wording, with the description: `facts.textHash`), the open bugs
 * (their state included: a fixed bug flips its confirmation test) and the test
 * types in scope — so "unchanged" means the approved design still answers the
 * same question.
 *
 * The wording was missing until 2.3.0: `facts.acceptanceCriteria` holds labels
 * only, so a story whose three criteria were rewritten to quote the real
 * validation messages kept its fingerprint, the old design was reused on the
 * execute-only path, and five tests asserting an invented message could not be
 * corrected (run 20261112T232301Z). A ledger recorded before then has no
 * `textHash`; its fingerprint is what it always was, which never equals one
 * that has the hash — so such a story is designed once more, and the route
 * says that is why.
 *
 * It is stored nowhere separately: a recorded run's facts are in its ledger, so
 * any earlier run's fingerprint can be recomputed — the same replay argument as
 * everywhere else. The route event records it too, for a reader.
 */
export function storyFingerprint(
  facts: StoryFacts,
  testTypes: readonly string[] = [],
  /** `false` leaves the wording out: the fingerprint as a pre-2.3.0 run computed it. */
  withText = true,
): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const basis = {
    story: facts.story ? { id: String(facts.story.id), title: norm(facts.story.title) } : null,
    criteria: facts.acceptanceCriteria.map(norm),
    ...(withText && facts.textHash ? { text: facts.textHash } : {}),
    bugs: facts.bugs.map((b) => `${String(b.id)}|${norm(b.state)}|${norm(b.title)}`).sort(),
    types: [...testTypes].map(norm).sort(),
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 12);
}

/**
 * What the story says, as one short hash: its acceptance criteria and its
 * description, whitespace and case aside. Both, because a story without
 * criteria is designed from its description, and Jira may keep the criteria
 * inside it. Pass the FULL text — the prompt's copy is cut to a length.
 */
export function storyTextHash(criteria: string, description: string): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256")
    .update(JSON.stringify([norm(criteria), norm(description)]))
    .digest("hex")
    .slice(0, 12);
}

export interface PriorDesign {
  runId: string;
  fingerprint: string;
  /** False for a run recorded before the story's wording was hashed into its facts. */
  textRecorded: boolean;
  /** The approved `aqa.test_design` arguments, exactly as recorded. */
  args: Record<string, unknown>;
  /** Tests that failed in that run's last full suite run — not yet shown to work. */
  failing: string[];
}

/**
 * The latest earlier run of this story that had a design approved, with the
 * fingerprint of the story as that run read it. Undefined when there is none.
 */
export function latestPriorDesign(
  runs: Array<{ runId: string; events: AnyRunEvent[] }>,
  story: StoryFacts["story"],
  testTypes: readonly string[] = [],
): PriorDesign | undefined {
  const s = priorDesignState(runs, story, testTypes);
  return s?.usable;
}

/**
 * The latest earlier run of this story with an approved design — the run whose
 * tests are on disk — and whether its result can be built on. `unverified`
 * means it stopped before running its suite on its last change: its tests have
 * never been shown to run, whatever the route finds on disk.
 */
export function priorDesignState(
  runs: Array<{ runId: string; events: AnyRunEvent[] }>,
  story: StoryFacts["story"],
  testTypes: readonly string[] = [],
): { runId: string; usable?: PriorDesign; unverified: boolean } | undefined {
  if (!story) return undefined;
  const sorted = [...runs].sort((a, b) => (a.runId < b.runId ? 1 : -1));
  for (const r of sorted) {
    const facts = storyFacts(r.events);
    if (!facts?.story || !sameId(facts.story.id, story.id)) continue;
    const calls = completedCalls(r.events);
    const approved = successful(calls, "aqa.test_design").pop();
    if (!approved) continue;
    // Only a run that FINISHED and ran its suite after its last change to the
    // tests. 20261019T163019Z reused the design of a run stopped right after
    // its scaffold: the spec had never been implemented or run, and this run
    // treated raw generator output as an existing, proven suite.
    // The latest such run decides: its tests are the ones on disk, so an
    // older finished run's design must not be reused over them.
    const unverified = { runId: r.runId, unverified: true } as const;
    if (!r.events.some((e) => e.kind === "end")) return unverified;
    const lastWrite = Math.max(
      -1,
      ...calls
        .filter(
          (c) =>
            c.ok &&
            (c.toolName === "fs.write_file" ||
              c.toolName === "fs.replace_in_file" ||
              c.toolName === "bdd2pw.scaffold"),
        )
        .map((c) => c.eventId),
    );
    const fullRuns = successful(calls, "pw.run_tests").filter(
      (c) => !FILTER_ARGS.some((k) => c.args[k] !== undefined && c.args[k] !== ""),
    );
    const last = fullRuns[fullRuns.length - 1];
    if (!last || last.eventId < lastWrite) return unverified;
    const failing = asArray(asRecord(last.result)?.["tests"])
      .map((t) => asRecord(t) ?? {})
      .filter((t) => t["status"] === "failed" || t["status"] === "timedOut")
      .map((t) => String(t["title"] ?? ""));
    return {
      runId: r.runId,
      unverified: false,
      usable: {
        runId: r.runId,
        fingerprint: storyFingerprint(facts, testTypes),
        textRecorded: facts.textHash !== undefined,
        args: approved.args,
        failing,
      },
    };
  }
  return undefined;
}

/** Recorded runs under a ledger root, skipping any that cannot be read. */
export function readRuns(ledgerRoot: string): Array<{ runId: string; events: AnyRunEvent[] }> {
  const dir = join(ledgerRoot, "runs");
  if (!existsSync(dir)) return [];
  const out: Array<{ runId: string; events: AnyRunEvent[] }> = [];
  for (const runId of readdirSync(dir)) {
    const file = join(dir, runId, LEDGER_FILE);
    if (!existsSync(file)) continue;
    try {
      out.push({ runId, events: readLedgerFile(file) });
    } catch {
      // A malformed ledger is evidence of nothing for this purpose.
    }
  }
  return out;
}
