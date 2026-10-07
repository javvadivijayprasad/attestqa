/**
 * The vocabulary a defect profile is written in.
 *
 * It is NOT invented here. It is the event schema of Paper F — "Post-Execution
 * Defect Attribution on Real-World Defects" (Javvadi, 2026) — whose corpus is
 * 1,323 defects drawn from Defects4J v2.0.1 and BugsInPy, archived as
 * `DefectAnalysisResearch` on Zenodo. Reusing it buys three things an invented
 * taxonomy cannot: the categories have already been applied to real defects at
 * scale, two projects that classify defects now agree on what the words mean,
 * and a profile built here can be compared against that corpus rather than only
 * against itself.
 *
 * Two axes, because one does not help a test designer. Knowing a defect lived
 * on the UI surface says where to look; knowing it was a locator defect that
 * surfaced as an AssertionError says what test to write.
 *
 * ── The honest caveat, which belongs in the code and not a footnote ──
 * In Paper F these signals are read from the FIX COMMIT'S DIFF: `schema_changed`
 * is true because the persisted schema actually changed. Here they are inferred
 * from what a bug report SAYS, because a closed Azure DevOps bug rarely carries
 * its diff. That is a weaker measurement of the same quantity. The vocabulary is
 * validated; this application of it is not, and a profile must not be read as if
 * it carried Paper F's ground truth.
 */

/**
 * Where the defect lived, named for the change-topology signal in Paper F's
 * schema that evidences it.
 */
export const DEFECT_SURFACES = [
  "locator",
  "validator",
  "schema",
  "config",
  "app_code",
  "fixture",
] as const;
export type DefectSurface = (typeof DEFECT_SURFACES)[number];

export const SURFACE_MEANINGS: Record<DefectSurface, string> = {
  locator:
    "the rendered interface and the elements tests address — what is displayed, enabled, or findable (Paper F: locator_healed)",
  validator:
    "input checking: a validator or schema-checker accepting what it should reject, or the reverse (Paper F: validator_changed)",
  schema:
    "persisted structure and the data in it — database, JSON or proto schema, migrations, integrity (Paper F: schema_changed)",
  config:
    "configuration and environment: settings, endpoints, credentials, wiring between components (Paper F: config_changed)",
  app_code:
    "production logic itself, where no more specific surface fits (Paper F: app_code_changed)",
  fixture:
    "the test's own setup or data rather than the product (Paper F: fixture_changed) — a test defect, not a product defect",
};

/**
 * How the defect announced itself. Exactly Paper F's `EXCEPTION_TYPES`, in its
 * order — changing this list silently breaks comparison with that corpus.
 */
export const EXCEPTION_TYPES = [
  "AssertionError",
  "TimeoutError",
  "ConnectionError",
  "AttributeError",
  "ValueError",
  "KeyError",
  "TypeError",
  "RuntimeError",
  "Other",
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/**
 * The test technique that would have caught the defect.
 *
 * This is the field that changes what gets written. A surface says where the
 * defect lived; a technique says what nobody did. "A three-character password
 * was accepted" is not usefully summarised as "a validator defect" — it is
 * summarised as "nobody applied boundary value analysis to the length rule",
 * and that sentence produces a test.
 *
 * The list is ISTQB's black-box techniques plus the two experience-based ones
 * that actually appear in bug histories. Closed, like everything else here: a
 * technique nobody agreed on cannot be compared across stories.
 */
export const TEST_TECHNIQUES = [
  "equivalence-partitioning",
  "boundary-value-analysis",
  "decision-table",
  "state-transition",
  "use-case",
  "negative-path",
  "error-guessing",
  "unknown",
] as const;
export type TestTechnique = (typeof TEST_TECHNIQUES)[number];

export const TECHNIQUE_MEANINGS: Record<TestTechnique, string> = {
  "equivalence-partitioning":
    "one representative per class of input — the defect would have shown with any value from an untested class",
  "boundary-value-analysis":
    "the edges: empty, minimum, maximum, one either side — the defect lived at a limit nobody probed",
  "decision-table":
    "combinations of conditions — the defect needed two or more inputs in a particular combination",
  "state-transition":
    "moving between states — the defect was a control or view left in the wrong state after a change",
  "use-case": "an end-to-end flow — the defect only appears when the steps are taken in order",
  "negative-path":
    "what should be rejected — the defect was the system accepting or mishandling invalid input",
  "error-guessing":
    "experience of where this kind of system breaks; no systematic technique would have found it first",
  unknown: "the report does not say enough to name a technique that would have caught it",
};

export function isTechnique(value: unknown): value is TestTechnique {
  return typeof value === "string" && (TEST_TECHNIQUES as readonly string[]).includes(value);
}

export function isSurface(value: unknown): value is DefectSurface {
  return typeof value === "string" && (DEFECT_SURFACES as readonly string[]).includes(value);
}

export function isExceptionType(value: unknown): value is ExceptionType {
  return typeof value === "string" && (EXCEPTION_TYPES as readonly string[]).includes(value);
}

/**
 * One classified defect.
 *
 * `evidence` is not decoration. Inferring a surface from a bug's prose is a
 * judgement, and an unexplained judgement cannot be checked by whoever reads the
 * profile later. Quoting the words that decided it makes a wrong call visible as
 * a wrong call rather than as a number — which matters more here than in Paper F,
 * where the diff settles it.
 */
export interface DefectRecord {
  /** Azure DevOps work item id. */
  id: number;
  title: string;
  surface: DefectSurface;
  /**
   * The technique that would have caught it. This is what a test designer acts
   * on: the surface tells them where to look, the technique tells them what to
   * write.
   */
  technique: TestTechnique;
  /** Paper F's failure signal. "Other" when the bug names no exception. */
  exceptionType: ExceptionType;
  /** Paper F's `http_status`: the status when the bug names one, else 0. */
  httpStatus?: number;
  /** The words in the bug that decided the classification. */
  evidence: string;
  /** ISO date the bug was closed or resolved, when the work item carried one. */
  closedAt?: string;
}

export interface DefectProfile {
  /** Which project and query produced this, so a profile can be reproduced. */
  project: string;
  query: string;
  generatedAt: string;
  /**
   * The vocabulary's provenance, written into every profile so a reader knows
   * which schema the words belong to without being told separately.
   */
  vocabulary?: string;
  /** Work items the query returned, including any the run could not classify. */
  queried: number[];
  /**
   * Ids the query returned that the gate refused to let the run read, because
   * they fall outside `scope.work_items`.
   *
   * Not a failure to hide. The scope is the operator's statement of what the
   * agent may touch, and a profile built from part of the history is still
   * useful — but a reader must be able to tell a distribution drawn from
   * everything from one drawn from what happened to be in scope.
   */
  outOfScope?: number[];
  records: DefectRecord[];
}

export const VOCABULARY_PROVENANCE =
  "Paper F event schema (Defects4J + BugsInPy, 1,323 defects); surfaces inferred from bug text, not from fix diffs";

/** Where the profile lives, relative to the workspace. */
export const PROFILE_DIR = ".aqa-profile";
export const PROFILE_FILE = "defects.json";

export interface ProfileCounts {
  total: number;
  bySurface: Record<string, number>;
  byException: Record<string, number>;
  /** "locator/AssertionError" → n. Only pairs that occur. */
  bySurfaceException: Record<string, number>;
  /** What was missing, which is what a designer can act on. */
  byTechnique: Record<string, number>;
  /** Bugs whose surface is `fixture` — test defects rather than product defects. */
  testSideTotal: number;
}

/**
 * Tally a profile.
 *
 * Counting is code's job here for the same reason the run summary is counted
 * from the ledger: the figures a skill acts on, and that a person reads, are
 * derived from the records rather than restated by the model that wrote them. A
 * model asked to both classify and summarise its own classifications has no
 * independent check on either.
 */
export function countProfile(records: DefectRecord[]): ProfileCounts {
  const counts: ProfileCounts = {
    total: records.length,
    bySurface: {},
    byException: {},
    bySurfaceException: {},
    byTechnique: {},
    testSideTotal: 0,
  };
  for (const r of records) {
    counts.bySurface[r.surface] = (counts.bySurface[r.surface] ?? 0) + 1;
    counts.byException[r.exceptionType] = (counts.byException[r.exceptionType] ?? 0) + 1;
    const pair = `${r.surface}/${r.exceptionType}`;
    counts.bySurfaceException[pair] = (counts.bySurfaceException[pair] ?? 0) + 1;
    counts.byTechnique[r.technique] = (counts.byTechnique[r.technique] ?? 0) + 1;
    if (r.surface === "fixture") counts.testSideTotal++;
  }
  return counts;
}

/** Highest-count pairs first, ties broken by name so two runs agree. */
export function rankedPairs(
  counts: ProfileCounts,
): Array<{ pair: string; n: number; share: number }> {
  return Object.entries(counts.bySurfaceException)
    .map(([pair, n]) => ({ pair, n, share: counts.total > 0 ? n / counts.total : 0 }))
    .sort((a, b) => b.n - a.n || a.pair.localeCompare(b.pair));
}

/**
 * Validate a parsed profile, returning the problems rather than throwing.
 *
 * A profile with one bad record is still worth most of its value, so the caller
 * decides what to do about it. Silence would not be: an out-of-vocabulary
 * surface means a classification that cannot be compared with the next run's,
 * nor with Paper F's corpus, which is the reason for borrowing the words.
 */
export function profileProblems(profile: DefectProfile): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const r of profile.records) {
    if (typeof r.id !== "number") problems.push("a record has no numeric id");
    else if (seen.has(r.id)) problems.push(`work item ${r.id} is classified more than once`);
    else seen.add(r.id);
    if (!isSurface(r.surface))
      problems.push(`work item ${r.id}: surface "${String(r.surface)}" is not in the vocabulary`);
    if (!isTechnique(r.technique))
      problems.push(
        `work item ${r.id}: technique "${String(r.technique)}" is not in the vocabulary`,
      );
    if (!isExceptionType(r.exceptionType))
      problems.push(
        `work item ${r.id}: exceptionType "${String(r.exceptionType)}" is not one of Paper F's EXCEPTION_TYPES`,
      );
    if (r.httpStatus !== undefined && (typeof r.httpStatus !== "number" || r.httpStatus < 0))
      problems.push(`work item ${r.id}: httpStatus is not a status code`);
    if (!r.evidence || r.evidence.trim().length === 0)
      problems.push(`work item ${r.id}: classified with no evidence quoted`);
  }
  return problems;
}
