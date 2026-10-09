/**
 * The triage engine: what kind of red is this?
 *
 * A faithful port of `classify_failure()` in `defect_analysis/engine/classifier.py`.
 * Deterministic, stateless, no network, no model — which is what makes it
 * testable and what makes it safe to run inside the verifier rather than
 * offering it to the agent as a tool it may decline to call.
 *
 * ── The algorithm is NOT "first category with a match" ──
 * This is worth stating loudly, because the first draft of DESIGN_triage.md got
 * it wrong and a plausible-looking reimplementation would have been a different
 * classifier wearing the same category names.
 *
 * Each bank is SCORED as the fraction of its patterns that matched. The highest
 * score wins, and CATEGORY_ORDER breaks ties. So a message matching one of the
 * six flake patterns (0.167) loses to one matching two of the five real-defect
 * patterns (0.4), even though flake comes first in the precedence list.
 * Precedence only decides a draw.
 *
 * Two adjustments follow, both from the Python:
 *   - a failure that was already retried is nudged toward `flake`
 *   - a failure that took over a minute is nudged toward `infrastructure`/`flake`
 *
 * And one default that runs the other way from the precedence bias: when NOTHING
 * matches, the verdict is `real-defect` at low confidence. Precedence says "do
 * not over-escalate when signals conflict"; this default says "do not silently
 * dismiss when there are no signals at all". They are not in tension — they
 * cover different situations — but a reader who sees only one of them will
 * misunderstand the classifier's disposition.
 */

import {
  BANKS,
  PW_BANKS,
  CATEGORY_ORDER,
  NO_SIGNATURE_CONFIDENCE,
  RETRY_FLAKE_BOOST,
  SLOW_TEST_BOOST,
  SLOW_TEST_THRESHOLD_MS,
  isContagious,
  type TriageCategory,
  type TriagePattern, DECLARED_ENVIRONMENTAL } from "./patterns.js";

/**
 * One failing test, as read from an execution report.
 *
 * Mirrors classifier.py's `FailureSignal`.
 */
export interface FailureSignal {
  /** The test's full title, used as its identity for quarantine. */
  testId: string;
  message: string;
  stack?: string;
  durationMs?: number;
  /** How many times the runner already retried this test. Informational. */
  retries?: number;
  /**
   * Whether an attempt of this test actually PASSED — i.e. it really has flaky
   * history, rather than merely having been retried by configuration.
   *
   * classifier.py gates its flake boost on `retries > 0` while its comment says
   * it means "retries with a subsequent pass history". Those are the same thing
   * only where the count already carries that meaning, and under Playwright it
   * does not: `retries: 1` in the config makes every failure report one retry.
   * The condition the Python describes is made explicit here. See `lastResult`
   * in report.ts for what the real reporter showed.
   */
  flakyHistory?: boolean;
}

/**
 * One verdict.
 *
 * `matchedPatterns` mirrors the Python field and holds pattern SOURCES, so two
 * implementations can be compared on the same run. `evidence` is this port's
 * addition: the actual text that matched, because a ledger entry saying
 * `\bassert(ion)?\s*(error|failed)?\b` tells a human nothing, and every other
 * classification in this runtime quotes the words that decided it.
 */
export interface TriageVerdict {
  test: string;
  category: TriageCategory;
  /** 0–1, rounded to three places as in the Python. */
  confidence: number;
  /** Pattern source strings that matched — for cross-implementation comparison. */
  matchedPatterns: string[];
  /** The text from the failure that matched, for a human reading the ledger. */
  evidence: string;
  rationale: string;
  /** Which implementation produced this. */
  triagedBy: "builtin" | "service";
  /** Present only when a service produced it. */
  serviceVersion?: string;
}

/**
 * Score one bank: the fraction of its patterns that matched, plus the matches.
 *
 * Mirrors `_score()`. The corpus is message and stack joined by a newline,
 * exactly as the Python does it — a pattern with `.*` in it can therefore match
 * across the two only if the runtime's `.` excludes newlines, which in both
 * languages it does by default. Do not add the `s` flag here to "fix" a pattern.
 */
function score(
  message: string,
  stack: string,
  patterns: readonly TriagePattern[],
): { score: number; matched: TriagePattern[]; hits: string[] } {
  const corpus = `${message}\n${stack}`;
  const matched: TriagePattern[] = [];
  const hits: string[] = [];
  for (const p of patterns) {
    const m = corpus.match(p.re);
    if (m) {
      matched.push(p);
      hits.push(m[0]);
    }
  }
  if (patterns.length === 0) return { score: 0, matched: [], hits: [] };
  return { score: matched.length / patterns.length, matched, hits };
}

/**
 * What to tell a person.
 *
 * NOT ported. classifier.py's `_RATIONALE_TEMPLATES` are UI copy for the
 * defect-analysis web app: they speak of Jira, of the Test Case Generator, and
 * of clicking through to a screenshot panel. Pasting them into a CLI that files
 * to Azure DevOps would be a drift bug shipped deliberately. The meanings below
 * are the same; the instructions are this runtime's.
 *
 * This deviation is intentional and is recorded here so the drift check does not
 * report it as an accident.
 */
const RATIONALE: Record<TriageCategory, string> = {
  infrastructure:
    "The test runner itself failed, so nothing about the product was measured. " +
    "Green is unreachable until the harness works; no amount of editing the spec " +
    "will change that.",
  environmental:
    "The system under test was not reachable or not usable, so nothing in this run " +
    "exercised the product. Check the application is serving and its configuration " +
    "is present, then run again.",
  flake:
    "Timing or UI-state instability rather than a product fault. The spec is not to " +
    "be edited on this verdict — a flaky test rewritten to pass is a test that no " +
    "longer guards anything. Retried once; if it fails the same way twice, it is " +
    "probably not a flake.",
  "real-defect":
    "The product did something the test correctly refused to accept. This test is " +
    "quarantined: it must not be edited, relaxed or deleted to reach green. It " +
    "becomes a defect candidate for a human to review.",
  "expected-failure":
    "Tagged as a known failure, so not counted as red. If the underlying issue is " +
    "fixed, remove the tag so the test guards against regression again.",
};

/** Mirrors `_what_clause()`: how many signals, or why an unmatched failure still escalates. */
function whatClause(category: TriageCategory, matchedCount: number): string {
  if (matchedCount === 0) {
    if (category === "real-defect") {
      return (
        "No known failure pattern matched, so it is treated as a real defect rather " +
        "than dismissed — review it rather than assuming it is noise."
      );
    }
    return "";
  }
  const plural = matchedCount === 1 ? "signal" : "signals";
  return `${matchedCount} ${plural} in the error point to this category.`;
}

/**
 * Classify one failure.
 *
 * Line-for-line the shape of `classify_failure()`; keep it that way.
 */
export function classifyFailure(f: FailureSignal): TriageVerdict {
  const stack = f.stack ?? "";
  const retries = f.retries ?? 0;
  const durationMs = f.durationMs ?? 0;

  // Each category is scored twice — once against the ported bank and once
  // against the Playwright extension bank — and the higher score wins. Scoring
  // is a fraction of bank size, so merging the two lists would change every
  // ported score and make this implementation disagree with the Python by
  // arithmetic instead of by judgement.
  let scored = CATEGORY_ORDER.map((category) => {
    const ported = score(f.message, stack, BANKS[category]);
    const pw = score(f.message, stack, PW_BANKS[category]);
    const best = pw.score > ported.score ? pw : ported;
    return { category, value: best.score, matched: best.matched, hits: best.hits };
  });

  // Retries > 0 with a subsequent pass history bump toward "flake". Both halves
  // of that sentence are checked here; see `flakyHistory` above for why the
  // count alone is not enough.
  if (retries > 0 && f.flakyHistory === true) {
    scored = scored.map((s) =>
      s.category === "flake" ? { ...s, value: s.value + RETRY_FLAKE_BOOST } : s,
    );
  }

  // Very long durations bump toward infra/flake.
  if (durationMs > SLOW_TEST_THRESHOLD_MS) {
    scored = scored.map((s) =>
      s.category === "infrastructure" || s.category === "flake"
        ? { ...s, value: s.value + SLOW_TEST_BOOST }
        : s,
    );
  }

  // Sort by score, then by precedence. Precedence ONLY breaks ties.
  scored.sort(
    (a, b) =>
      b.value - a.value ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );

  // CATEGORY_ORDER is non-empty, so scored is too; the fallback keeps TypeScript
  // honest without pretending the branch is reachable.
  const top = scored[0] ?? {
    category: "real-defect" as TriageCategory,
    value: 0,
    matched: [],
    hits: [],
  };

  let category = top.category;
  let confidence = top.value;
  let matchedCount = top.matched.length;
  let hits = top.hits;
  let matched = top.matched;

  // The suite's own declaration wins over the tally. See DECLARED_ENVIRONMENTAL
  // for why this sits outside the scoring: the scoring is a faithful port and
  // a faithful port of a dashboard classifier has no notion of a test author
  // telling it the answer.
  const declared = score(f.message, stack, DECLARED_ENVIRONMENTAL);
  if (declared.matched.length > 0) {
    category = "environmental";
    confidence = Math.max(confidence, 0.9);
    matchedCount = declared.matched.length;
    hits = declared.hits;
    matched = declared.matched;
  } else if (top.value === 0) {
    // Default to real-defect at low confidence so the team errs on the side of
    // investigating rather than auto-dismissing.
    category = "real-defect";
    confidence = NO_SIGNATURE_CONFIDENCE;
    matchedCount = 0;
    hits = [];
    matched = [];
  }

  return {
    test: f.testId,
    category,
    confidence: Math.round(Math.min(1, confidence) * 1000) / 1000,
    matchedPatterns: matched.map((p) => p.source),
    evidence: evidenceFrom(hits, f.message),
    rationale: `${RATIONALE[category]} ${whatClause(category, matchedCount)}`.trim(),
    triagedBy: "builtin",
  };
}

/**
 * The words a person needs in order to see what happened.
 *
 * The first version of this joined the matched pattern fragments, on the
 * principle that evidence should be "the words that decided it". Run against a
 * real Playwright failure it produced:
 *
 *     expect(received). · Object.is equality · expect(received).toBe
 *
 * — three fragments of the same sentence, none of them the useful part. The
 * message itself said `Expected: 90` and `Received: 100`, which is the whole
 * story and is what ends up quoted in a bug report a human reads.
 *
 * So evidence is the failure's own salient text: the first line, plus the
 * expected/received pair when the framework gives one. Which patterns matched
 * is still recorded — in `matchedPatterns`, where a machine comparing two
 * implementations can find it and a human is not made to read it.
 */
function evidenceFrom(hits: string[], message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const head = lines[0] ?? "";
  const values = lines
    .filter((l) => /^(expected|received|actual)\b/i.test(l))
    .slice(0, 3);

  const parts = values.length > 0 ? [head, ...values] : [head];
  const text = parts.join(" · ").trim();

  // Nothing usable in the message at all — fall back to the fragments, which
  // are at least true, rather than recording a verdict with no evidence.
  if (text.length === 0) return hits.join(" · ").slice(0, 300);
  return text.slice(0, 300);
}

export interface TriageResult {
  verdicts: TriageVerdict[];
  /**
   * `"environmental"` or `"infrastructure"` when a contagious verdict is
   * present: nothing in this run was measured, so no other verdict in it can be
   * trusted. `null` otherwise.
   */
  runLevel: TriageCategory | null;
  /** Tests the agent may not touch: those triaged `real-defect`. */
  quarantined: string[];
}

/**
 * Classify every failure in a run and work out what it means for the run.
 *
 * Mirrors `classify_report()`, plus the run-level judgement the service never
 * has to make. When a contagious category is present there are no quarantined
 * tests and no defect candidates — not because the failures were forgiven, but
 * because nothing was measured, and a defect candidate drawn from an unmeasured
 * run would send someone to investigate a bug that may not exist.
 */
export function triageRun(failures: FailureSignal[]): TriageResult {
  const verdicts = failures.map(classifyFailure);

  // The earliest contagious category present, so a run with both reports the
  // more fundamental one.
  //
  // ── Contagion needs evidence, not a heuristic ──
  // A verdict can reach `infrastructure` on the duration boost alone: a failure
  // over a minute long with no recognisable error scores 0.1 for infrastructure
  // and 0.1 for flake, and precedence hands it to infrastructure. That is
  // faithful to classifier.py and fine there, where the verdict labels one row
  // of a dashboard.
  //
  // Here it would write off every other result in the run. "Nothing was
  // measured" is the strongest claim triage can make, and a stopwatch is not
  // grounds for making it. So contagion additionally requires that at least one
  // pattern actually matched — the classifier still says infrastructure, and the
  // verdict still says so; the run is only written off when something in the
  // error text says the harness or the environment failed.
  const runLevel =
    CATEGORY_ORDER.find(
      (c) =>
        isContagious(c) &&
        verdicts.some((v) => v.category === c && v.matchedPatterns.length > 0),
    ) ?? null;

  const quarantined =
    runLevel === null
      ? verdicts.filter((v) => v.category === "real-defect").map((v) => v.test)
      : [];

  return { verdicts, runLevel, quarantined };
}

/** Failures the agent is free to work on: everything not quarantined. */
export function repairable(result: TriageResult): TriageVerdict[] {
  if (result.runLevel !== null) return [];
  return result.verdicts.filter(
    (v) => v.category !== "real-defect" && v.category !== "expected-failure",
  );
}
