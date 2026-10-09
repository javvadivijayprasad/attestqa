/**
 * Triage as a step in the loop, and the gaps it produces.
 *
 * Two functions, deliberately separate:
 *
 *   `runTriage`   reads the execution report and produces the event.
 *   `triageGaps`  reads the events back and decides what they mean for "done".
 *
 * They talk to each other through the ledger rather than through a return
 * value, which is the same arrangement every other pair of steps in this
 * runtime uses. It is also what makes the quarantine check possible: comparing
 * this attempt against the last one needs the last one to have been written
 * down somewhere a later step can read, and "somewhere a later step can read"
 * is the ledger's entire job.
 *
 * Neither function is a tool. The agent cannot call triage, decline to call
 * triage, or argue with its verdict — a model that could choose whether to
 * triage would skip it exactly when it has a theory about the failure it wants
 * to act on, which is the case triage exists for.
 */

import type { AnyRunEvent, Gap, TriagePayload, VerifierInput } from "../types.js";
import { triageRun } from "./classify.js";
import { NO_SIGNATURE_CONFIDENCE, isContagious, type TriageCategory } from "./patterns.js";
import { readFailures, reportFingerprint, reportMtimeMs, reportPath } from "./report.js";
import { analyzeReport, merge, type ServiceOptions } from "./service.js";
import { assertionsOf, testsByTitle } from "../design/test-design.js";
import { asRecord, completedCalls } from "../verify/evidence.js";
import { isFullRun } from "../runtime/rerun.js";

export interface TriageStepOptions {
  /**
   * The defect-analysis service, when the environment offers one. Omitted, the
   * built-in rules are the whole story and nothing leaves the machine.
   *
   * The caller reads this from `DEFECT_ANALYSIS_URL`, never from a work item, a
   * spec or a tool result — see the note in `service.ts` on why.
   */
  service?: ServiceOptions;
}

/**
 * Triage the current execution report.
 *
 * Returns `undefined` when there is nothing to triage — no report written, or a
 * report with no failures. An empty triage event would be noise in the ledger
 * and would make the attempt counter meaningless.
 */
export async function runTriage(
  input: VerifierInput,
  opts: TriageStepOptions = {},
): Promise<TriagePayload | undefined> {
  const fingerprint = reportFingerprint(input.workspaceDir);
  if (fingerprint === undefined) return undefined;

  // The report must belong to THIS run.
  //
  // It is a file in the workspace, and files outlive runs. A report left by the
  // previous run sat there with a quarantined test in it, and the first cycle of
  // the next run read it, quarantined a test it had not executed, and stopped —
  // 13 events, nothing run, a verdict inherited from a run that was over
  // (20260918T161822Z-427cd725).
  //
  // The fingerprint alone cannot catch this: it compares against THIS run's
  // ledger, which on the first cycle is empty, so a stale file looks like new
  // evidence. The run's own start time is the thing that distinguishes them.
  const runStartedAt = input.events[0]?.timestamp;
  const writtenAt = reportMtimeMs(input.workspaceDir);
  if (runStartedAt !== undefined && writtenAt !== undefined && writtenAt < runStartedAt) {
    return undefined;
  }

  // The report must be of the WHOLE SUITE.
  //
  // Playwright writes one report file and a filtered run overwrites it, so after
  // `pw.run_tests --grep "one test"` the file on disk describes one test. Triage
  // read it as the run's result and concluded the opposite of the truth: in
  // 20260928T091417Z two tests were quarantined by the full run, then a green
  // one-test run cleared the quarantine — "suite is green — the earlier failures
  // are gone" — with both defects still failing. A run that then reported green
  // and dropped its bugs would have been lying, and the ledger would have
  // agreed with it.
  //
  // A filtered run is a working step: the healer proving one test. It is never
  // the evidence a verdict is counted from. Everything else in this runtime
  // already knew that — the report headline, the verifier's green-suite check,
  // `autoRun` and `staleRerun` all read the last FULL run — and triage was the
  // one place still reading whatever was newest.
  if (lastRunWasFiltered(input.events)) return undefined;

  // Already classified this exact report. The loop calls triage after every
  // cycle, so without this the same evidence would be re-classified on every
  // turn: duplicate ledger events, a meaningless attempt counter, and a
  // quarantine check comparing a report against itself and always finding
  // agreement.
  {
    const seen = triageEvents(input.events);
    const prev = seen[seen.length - 1];
    if (prev && prev.reportFingerprint === fingerprint) return undefined;
  }

  const failures = readFailures(input.workspaceDir);
  if (failures === undefined) return undefined;

  // A GREEN report is a triage result, not an absence of one.
  //
  // This used to return undefined on an empty failure list, reasoning that an
  // empty triage event would be noise in the ledger. That is true on a run
  // whose suite was green all along — but false the moment an EARLIER report
  // had failures, because the verifier reads only the latest triage event, and
  // without a clearing event the last word on the run is a verdict from a
  // report that no longer exists.
  //
  // Observed in 20260918T235010Z: two failing reports triaged `real-defect`,
  // the agent then fixed the spec, the suite came back 5 passed / 0 failed —
  // and the verifier still reported `product-defect-suspected` and blocked the
  // run. The agent had done exactly the right thing and there was no action
  // left that could close the gap, because the gap described the past.
  //
  // So: green with no history stays silent, green after failures is recorded.
  const history = triageEvents(input.events);
  if (failures.length === 0) {
    if (history.length === 0) return undefined;
    return {
      attempt: history.length + 1,
      reportFingerprint: fingerprint,
      runLevel: null,
      verdicts: [],
      quarantined: [],
      cleared: true,
    };
  }

  const local = triageRun(failures);
  const attempt = history.length + 1;

  if (!opts.service) {
    const verdicts = applyRepetition(local.verdicts, history);
    return {
      attempt,
      reportFingerprint: fingerprint,
      runLevel: local.runLevel,
      verdicts,
      quarantined: quarantineFrom(verdicts, local.runLevel),
    };
  }

  // The service parses the report itself — it auto-detects `playwright-json`
  // and runs rules, LLM, grouping and retry planning in one call. Handing it
  // the file rather than a list of failures we extracted is what gets the
  // fingerprints and the group state back, and those are the parts the local
  // rules cannot produce.
  const analysis = await analyzeReport(
    { reportPath: reportPath(input.workspaceDir), runId: runIdOf(input) },
    opts.service,
  );
  if (!analysis) {
    // Unreachable, misaddressed, or it could not parse the report. The local
    // verdicts stand; the run records that they did.
    const verdicts = applyRepetition(local.verdicts, history);
    return {
      attempt,
      reportFingerprint: fingerprint,
      runLevel: local.runLevel,
      verdicts,
      quarantined: quarantineFrom(verdicts, local.runLevel),
    };
  }
  const merged = merge(local.verdicts, analysis.verdicts);
  const disagreements = merged.disagreements;
  // Repetition is applied AFTER the service has spoken. It is evidence from
  // this run's own history that neither classifier has — the service sees one
  // failure at a time and has no memory of the last attempt.
  const verdicts = applyRepetition(merged.verdicts, history);

  // Recompute the run-level judgement and the quarantine from the MERGED
  // verdicts, not from the local ones. If the service says environmental where
  // the rules said real-defect, the run was not measured and there is no defect
  // candidate — carrying over a quarantine computed before the service spoke
  // would file a bug against an outage.
  const runLevel = runLevelOf(verdicts);
  const quarantined = quarantineFrom(verdicts, runLevel);

  return {
    attempt,
    reportFingerprint: fingerprint,
    runLevel,
    verdicts,
    quarantined,
    ...(disagreements.length > 0 ? { disagreements } : {}),
    ...(analysis.groups.length > 0 ? { groups: analysis.groups } : {}),
  };
}

/** The run's id, taken from the ledger rather than passed in. */
function runIdOf(input: VerifierInput): string {
  return input.events[0]?.runId ?? "unknown";
}

/**
 * What the loop should do about a triage verdict, right now.
 *
 * This is the part the first implementation got wrong. Triage lived only in the
 * verifier, and the verifier only runs when the model declares the goal
 * reached — so on a run where the model kept repairing, triage never fired at
 * all. Observed on run 20260918T154354Z-1f5d7538: 33 inferences, four suite
 * runs, fifteen rewrites of one spec, and not a single triage event. A stop
 * rule that can only speak after the loop has finished is not a stop rule.
 *
 * So the loop asks this after every cycle, and it answers in terms the loop can
 * act on without knowing anything about defects.
 */
/**
 * Triage never ends a run by itself any more.
 *
 * It used to, on a contagious verdict — which decided, on the operator's
 * behalf, that an unreachable application could never be a defect worth filing.
 * That is a judgement about the product, and it belongs to a person. Triage
 * now retries, and then puts the question to them.
 */
export interface TriageAction {
  notes: string[];
}

export function triageAction(payload: TriagePayload, attemptsSoFar = payload.attempt): TriageAction {
  // ── Retry before judging. Every category, not just flakes. ──
  // The operator's rule, and it is better than what this had. A transient
  // outage and a persistent one look identical on the first report; so do a
  // racy assertion and a broken one. Only a clean re-run tells them apart, and
  // until it has happened nothing here is entitled to a verdict — including the
  // verdict "the system under test is down", which was previously an immediate
  // stop and decided for the operator that an outage could never be a defect.
  if (attemptsSoFar <= 1) {
    return {
      notes: [
        "The suite failed. Before changing ANYTHING, run it again unchanged with " +
          "pw.run_tests. A first failure does not distinguish a flake, a slow page, a " +
          "service still starting up, or a real defect — only the second run does. Do not " +
          "edit a spec, a selector or a config value first: an edit makes the two runs " +
          "incomparable and throws away the only evidence that separates those cases.",
      ],
    };
  }

  // ── Second time. It is real, whatever kind of real it is. ──
  const persistent = payload.verdicts.filter((v) => v.category !== "expected-failure");
  if (persistent.length === 0) return { notes: [] };

  const kind =
    payload.runLevel !== null
      ? payload.runLevel === "environmental"
        ? "the system under test was unreachable on both runs"
        : "the test runner itself failed on both runs"
      : "the same tests failed on both runs";

  const notes: string[] = [
    `The suite was re-run and still fails: ${kind}. This is no longer something to fix by ` +
      "guessing, and it is not yours to decide. Propose a Bug for each failure that is " +
      "still red, with ado.wit_work_item_write action \"create\", workItemType \"Bug\" — " +
      "a human is asked to approve it and may say no, which ends it. Say plainly in each " +
      "bug what kind of failure it was, so the reviewer is not asked to rubber-stamp: an " +
      "application that was never reachable and a failing assertion deserve different " +
      "answers from them.",
  ];

  notes.push(
    ...payload.quarantined.map(
      (t) =>
        `quarantined: "${t}" — do not edit, relax, skip or delete it, and do not try again ` +
        "to make it pass. The test is correct; the application is not.",
    ),
  );

  const repairable = payload.verdicts.filter(
    (v) => v.category !== "real-defect" && v.category !== "expected-failure",
  );
  if (repairable.length === 0 && payload.quarantined.length > 0) {
    notes.push(
      "There is nothing left to fix in the specs. Finish the rest of the job — record the " +
        "test cases and link them to the story — propose the bug, and stop.",
    );
  }

  return { notes };
}

/** Tests the agent may not touch, given the run-level judgement. */
function quarantineFrom(
  verdicts: Array<{ test: string; category: string; confidence: number }>,
  runLevel: string | null,
): string[] {
  if (runLevel !== null) return [];
  return verdicts.filter(quarantines).map((v) => v.test);
}

/**
 * Whether a verdict is strong enough to QUARANTINE a test — to tell the agent
 * "do not touch this, the product is at fault".
 *
 * `real-defect` alone is not enough. Two paths produce it at
 * NO_SIGNATURE_CONFIDENCE: the fallback when no pattern matched, and the
 * repetition rule when a flake fails the same way twice. Both mean "we do not
 * know what this is", and neither is evidence about the product.
 *
 * Observed in 20260921T142549Z: five 30-second timeouts were classified flake,
 * repeated, became real-defect at 0.10 and were quarantined. The agent edited
 * them anyway — the locators were wrong — the suite went 5/5 green, and the
 * verifier then blocked the run for modifying quarantined tests. A quarantine
 * built on no evidence stopped the only move that could expose it as wrong,
 * and then punished the run for making it.
 */
export function quarantines(v: { category: string; confidence: number }): boolean {
  return v.category === "real-defect" && v.confidence > NO_SIGNATURE_CONFIDENCE;
}

/**
 * A failure that reproduces identically is not a flake.
 *
 * `flake` means one thing: it would pass if you ran it again. A failure that
 * came back with the same evidence after the agent edited the spec and re-ran
 * has falsified that claim, by the definition of the word. No pattern bank can
 * see this, because every bank looks at one message in isolation — and the
 * service cannot see it either, since it classifies one failure at a time with
 * no memory of the last attempt. Only this run's own history has it.
 *
 * Why it matters, from the run that prompted it. AC-1 failed with
 * `expect(locator).toBeVisible() failed` four times running while the agent
 * rewrote the spec fifteen times. That message is genuinely ambiguous on sight —
 * the product may never have rendered the element, or the test may be looking
 * for the wrong one — so `flake` was a defensible first guess. It stopped being
 * defensible the second time the identical failure came back.
 *
 * The re-classification is to `real-defect` at LOW confidence, not high. It is
 * not a claim that the product is broken; it is a claim that this is no longer
 * the agent's to fix by guessing. Quarantine stops the rewriting, the failure
 * becomes a defect candidate, and a human decides whether it is the product or
 * the test — which is exactly the decision that needs a person, and the bug is
 * filed only if they say so.
 */
export function applyRepetition<T extends { test: string; category: string; evidence: string; confidence: number; rationale: string }>(
  verdicts: T[],
  history: TriagePayload[],
): T[] {
  if (history.length === 0) return verdicts;

  // How many earlier attempts saw this exact test fail this exact way.
  const seen = new Map<string, number>();
  for (const attempt of history) {
    for (const v of attempt.verdicts) {
      const key = `${v.test}\u0000${v.evidence}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }

  return verdicts.map((v) => {
    if (v.category !== "flake") return v;
    const repeats = seen.get(`${v.test}\u0000${v.evidence}`) ?? 0;
    if (repeats === 0) return v;
    return {
      ...v,
      category: "real-defect",
      confidence: NO_SIGNATURE_CONFIDENCE,
      rationale:
        `Classified flake on the failure text, but this test has now failed the same way ` +
        `${repeats + 1} times in this run. A flake is a failure that would pass on a re-run; ` +
        "this one did not. It is quarantined and becomes a defect candidate for a human, who " +
        "decides whether the product is wrong or the test is — not because the product is " +
        "known to be at fault, but because guessing has stopped working.",
    };
  });
}

/**
 * The contagious category present, if any.
 *
 * Mirrors the rule in `triageRun`, including its evidence requirement: a
 * verdict that reached `infrastructure` on the duration boost alone must not
 * write off a whole run. A service verdict with no `matched_patterns` is
 * treated the same way, because "the service said so" is not more evidence
 * than "the stopwatch said so" when neither can name what it saw.
 */
function runLevelOf(verdicts: Array<{ category: string; matchedPatterns: string[] }>): string | null {
  for (const c of ["infrastructure", "environmental"] as TriageCategory[]) {
    if (!isContagious(c)) continue;
    if (verdicts.some((v) => v.category === c && v.matchedPatterns.length > 0)) return c;
  }
  return null;
}

/** Every triage event in a run, oldest first. */
export function triageEvents(events: AnyRunEvent[]): TriagePayload[] {
  return events.filter((e) => e.kind === "triage").map((e) => e.payload as TriagePayload);
}

/**
 * What the triage history means for whether the run is done.
 *
 * Called by a skill's verifier, which owns the rest of the "done" decision. The
 * gaps below are about the RUN, not about the skill, so any skill that executes
 * tests wants them and none of them mention stories, test cases or work items.
 */
export function triageGaps(events: AnyRunEvent[]): {
  gaps: Gap[];
  limitations: string[];
  /** How many triage events this run produced — zero is itself a finding. */
  attempts: number;
  /**
   * Tests whose failure triage attributes to the PRODUCT, on real evidence.
   * Not gaps: nothing the agent can do closes them, and a person decides on
   * each one at the end of the run. The verifier uses this to tell "red because
   * the work is unfinished" from "red because the product is wrong".
   */
  defectCandidates: string[];
} {
  const gaps: Gap[] = [];
  const limitations: string[] = [];
  const defectCandidates: string[] = [];
  const history = triageEvents(events);
  const latest = history[history.length - 1];
  if (!latest) return { gaps, limitations, attempts: 0, defectCandidates };

  if (latest.runLevel !== null) {
    // Nothing was measured, so there is nothing to report as a defect and
    // nothing the agent can fix by editing a spec. The gap names the fix and
    // the fix is a person starting something.
    const environmental = latest.runLevel === "environmental";
    gaps.push({
      code: environmental ? "sut-unavailable" : "harness-unusable",
      message: environmental
        ? "The environment failed before any test reached the product — the application was " +
          "not reachable, or the fixture it needs (the test account, its data, a credential) " +
          "was not there — so nothing in this run exercised the product, including the tests " +
          "that passed. Green is unreachable until that is fixed. Nothing in the spec caused " +
          "this and no edit to the spec will fix it."
        : "The test runner itself failed, so nothing about the product was measured. " +
          "Check the runner's resources and logs. No edit to the spec will fix this.",
      evidence: {
        runLevel: latest.runLevel,
        examples: latest.verdicts
          .filter((v) => v.category === latest.runLevel)
          .slice(0, 3)
          .map((v) => ({ test: v.test, evidence: v.evidence })),
      },
    });
    // Deliberately no defect candidates here, and no quarantine check: both
    // would be drawn from a run that measured nothing.
    return { gaps, limitations, attempts: history.length, defectCandidates };
  }

  // A `real-defect` verdict that matched NOTHING is a default, not a finding.
  //
  // `classify` falls through to real-defect at NO_SIGNATURE_CONFIDENCE (0.1)
  // when no bank matched, so the team errs on the side of looking. That is the
  // right default for a human reading a report, and the wrong basis for a
  // QUARANTINE — which tells the agent a test may not be touched because the
  // product, not the test, is at fault. Claiming that from no evidence is a
  // guess wearing a verdict's clothes.
  //
  // This is the same evidence requirement `runLevelOf` already applies to the
  // contagious categories, for the same reason: a verdict that cannot name
  // what it saw must not write off a test or a run.
  //
  // Observed in 20260918T235010Z: `expect(locator).toBeVisible() — Received:
  // hidden` matched no pattern, was defaulted to real-defect at 0.10, and
  // quarantined a test that the agent then FIXED — proving the failure was in
  // the test, exactly as a zero-evidence verdict cannot tell you.
  const claims = latest.verdicts.filter(
    (x) => quarantines(x) && x.matchedPatterns.length > 0,
  );
  const unexplained = latest.verdicts.filter(
    (x) => x.category === "real-defect" && !claims.includes(x),
  );
  if (unexplained.length > 0) {
    limitations.push(
      `${unexplained.length} failure(s) were NOT quarantined — nothing in them is evidence ` +
        "that the product is at fault (no pattern matched, or they only failed the same way " +
        "twice): " +
        unexplained
          .slice(0, 3)
          .map((v) => v.test)
          .join("; ") +
        ". Look at them yourself — the runtime has no opinion about whether the product or " +
        "the test is at fault.",
    );
  }

  // A suspected product defect is a DECISION FOR A PERSON, not a gap.
  //
  // It used to be a gap, which told the agent "not done — fix this" about the
  // one kind of failure the agent is told never to fix. It could only burn the
  // verifier's retry: observed in 20260921T192908Z, where the retry produced a
  // fresh bug proposal about the same failure, and the run still ended
  // blocked. Bugs are now settled with a reviewer at the end of the run, so
  // "a person must decide this" is where a run correctly finishes.
  for (const v of claims) {
    defectCandidates.push(v.test);
    limitations.push(
      `${v.test} — ${v.evidence}. Triaged as a product defect: the test is believed correct and ` +
        "the product is not. It is quarantined, and whether it is a real defect is put to the " +
        "reviewer at the end of the run.",
    );
  }

  // A quarantined test whose failure changed is either a repair or the loss of
  // evidence, and the difference is checkable: a heal changes the locator and
  // KEEPS every claim the test made, which is exactly what the write rule
  // allows. Story #44's heal removed a `.catch()` fallback, the failure moved
  // from a false "the token survived" to an honest URL mismatch, and this gap
  // called it evidence-destruction (20260925T174149Z). A repair that keeps the
  // claims is progress and is recorded as such.
  const drift = quarantineDrift(history);
  const repaired = drift.filter((d) => keptItsClaims(events, d.test));
  const evidenceLost = drift.filter((d) => !keptItsClaims(events, d.test));
  for (const d of repaired)
    limitations.push(
      `${d.test} — its failure changed after a repair that kept every assertion it made ` +
        `(was: ${signature(d.was).slice(0, 80)}; now: ${signature(d.now).slice(0, 80)}). ` +
        "The claim is intact, so the new failure is the honest one.",
    );
  if (evidenceLost.length > 0) {
    gaps.push({
      code: "quarantined-test-modified",
      message:
        "A test that was quarantined as a defect candidate no longer fails the way it did, and " +
        "the spec no longer makes every claim it made before. Either the product was fixed " +
        "mid-run, or the test was edited to make the failure go away — and the second destroys " +
        "the evidence the defect candidate rests on. Restore what the test asserted and re-run, " +
        "or confirm the product change.",
      evidence: { tests: evidenceLost.slice(0, 10) },
    });
  }

  const flakes = latest.verdicts.filter((v) => v.category === "flake");
  if (flakes.length > 0 && history.length > 1) {
    limitations.push(
      `triage — ${flakes.length} failure(s) were triaged as flaky and the suite was retried; ` +
        "a flake that survives a retry is probably not a flake, and the verdicts here should " +
        "be read with that in mind",
    );
  }

  if (latest.disagreements && latest.disagreements.length > 0) {
    limitations.push(
      `triage — the built-in rules and the defect analysis service disagreed on ` +
        `${latest.disagreements.length} failure(s): ` +
        latest.disagreements
          .slice(0, 5)
          .map((d) => `${d.test} (rules: ${d.builtin}, service: ${d.service})`)
          .join("; ") +
        ". The service's verdict was used. A disagreement usually means the two " +
        "classifiers have drifted apart and one of them needs updating.",
    );
  }

  const serviceSaid = latest.verdicts.filter((v) => v.triagedBy === "service").length;
  if (serviceSaid > 0 && serviceSaid < latest.verdicts.length) {
    limitations.push(
      `triage — ${serviceSaid} of ${latest.verdicts.length} verdicts came from the defect ` +
        "analysis service and the rest from the built-in rules, so the run's verdicts were " +
        "not all produced by the same classifier",
    );
  }

  return { gaps, limitations, attempts: history.length, defectCandidates };
}

/**
 * Quarantined tests whose failure has changed or vanished since it was recorded.
 *
 * The risk this catches is specific. The agent is working inside the same spec
 * file as a quarantined test and its whole disposition is to make red go green.
 * One relaxed assertion, one adjusted shared `beforeEach`, and the defect is
 * gone from the record — in a commit that looks like ordinary repair work.
 *
 * Telling the model not to do this is necessary and not sufficient, so this
 * compares what the ledger recorded against what the report now says. The model
 * proposes; code checks. Same rule as everywhere else here.
 *
 * A test that vanishes from the failures while quarantined counts as drift even
 * though "it passes now" sounds like good news: a product fix mid-run and a
 * neutered assertion look identical from here, and only one of them is good
 * news. A human reads the gap and says which.
 */
/**
 * What a failure IS, as opposed to everything it printed.
 *
 * Comparing whole messages said a test had been edited whenever its output
 * merely varied: an axe-core scan reported a `label` violation on one run and
 * `color-contrast` on the next, both real, and the runtime accused the agent of
 * tampering with a quarantined test it had not touched (20260923T222343Z).
 * The signature keeps the error kind and the identifiers inside it, and drops
 * the prose, the numbers and the JSON around them.
 */
export function signature(evidence: string): string {
  const plain = evidence.replace(/\s+/g, " ").trim();
  // A structured failure — an axe-core report, any thrown object carrying rule
  // ids — is identified by those ids. The nodes, counts and ordering around
  // them vary between runs without the failure being a different failure.
  const ids = [...new Set([...plain.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))].sort();
  if (ids.length > 0) {
    const kind = /^([A-Za-z]*Error)\b/.exec(plain)?.[1] ?? "Error";
    return [kind, ...ids].join("|");
  }
  // Everything else keeps its own words: "expected 200 to equal 404" and
  // "expected 100 to equal 100" are different failures, and flattening them
  // would hide a relaxed assertion, which is the thing this check exists for.
  return plain.slice(0, 200);
}

/**
 * Did every claim this test made survive the run's edits?
 *
 * Walks the spec versions the ledger holds, in order. An edit that keeps the
 * whole assertion set is a repair (a locator, a fallback removed); an edit that
 * drops one is what the quarantine exists to catch.
 */
function keptItsClaims(events: AnyRunEvent[], test: string): boolean {
  const title = test.split("\u203a").pop()?.trim() ?? test;
  let previous: string | undefined;
  let sawEdit = false;
  for (const c of completedCalls(events)) {
    if (!c.ok) continue;
    const path = String(c.args["path"] ?? "");
    if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) continue;
    const text =
      c.toolName === "fs.write_file"
        ? String(c.args["content"] ?? "")
        : typeof asRecord(c.result)?.["content"] === "string"
          ? String(asRecord(c.result)?.["content"])
          : undefined;
    if (text === undefined) continue;
    if (c.toolName === "fs.write_file" && previous !== undefined && previous !== text) {
      sawEdit = true;
      const was = assertionsOf(testsByTitle(previous).get(title) ?? "");
      const now = new Set(assertionsOf(testsByTitle(text).get(title) ?? ""));
      if (was.some((a) => !now.has(a))) return false;
    }
    previous = text;
  }
  // No edit at all: the failure changed on its own, which this function has
  // nothing to say about — the gap should still ask.
  return sawEdit;
}

function quarantineDrift(history: TriagePayload[]): Array<{
  test: string;
  was: string;
  now: string;
}> {
  const latest = history[history.length - 1];
  if (!latest || history.length < 2) return [];

  // Everything quarantined at any earlier point, with the evidence recorded
  // then. An earlier attempt's record is the baseline; using only the previous
  // attempt would let a test drift across three attempts unnoticed.
  const baseline = new Map<string, string>();
  for (const attempt of history.slice(0, -1)) {
    for (const v of attempt.verdicts) {
      if (quarantines(v) && !baseline.has(v.test)) baseline.set(v.test, v.evidence);
    }
  }

  const nowByTest = new Map(latest.verdicts.map((v) => [v.test, v]));
  const drift: Array<{ test: string; was: string; now: string }> = [];

  for (const [test, was] of baseline) {
    const current = nowByTest.get(test);
    if (!current) {
      drift.push({ test, was, now: "no longer failing" });
    } else if (signature(current.evidence) !== signature(was)) {
      drift.push({ test, was, now: current.evidence });
    }
  }

  return drift;
}

/**
 * Was the most recent execution a filtered one — and therefore not a result?
 *
 * Read from the ledger rather than from the report file, because the report
 * carries no record of the arguments that produced it.
 */
function lastRunWasFiltered(events: AnyRunEvent[]): boolean {
  // Every attempt, not only the successful ones. A filtered run that failed
  // still ran Playwright, and Playwright still wrote its report over the
  // previous one — so "the last run that worked was the full suite" is not the
  // same question as "is the file on disk the full suite's".
  const runs = completedCalls(events).filter((c) => c.toolName === "pw.run_tests");
  const last = runs[runs.length - 1];
  return last !== undefined && !isFullRun(last.args);
}
