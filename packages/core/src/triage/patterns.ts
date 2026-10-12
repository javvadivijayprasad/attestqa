/**
 * Failure-classification pattern banks, ported from the defect-analysis service.
 *
 * Source of truth: `defect_analysis/engine/classifier.py` in
 * `Application/defect-analysis-service`. This file is a MIRROR, not a rewrite.
 *
 * ── Why the patterns are stored as their Python source text ──
 * Each entry keeps the exact string from the Python list and compiles it at
 * load. A regex literal retyped in JavaScript syntax would be a translation,
 * and translations drift silently — the failure mode already seen with bdd2pw,
 * where two implementations of the same idea diverged without either being
 * wrong on its own. Keeping the Python text verbatim makes divergence a string
 * comparison: `npm run check:drift` can diff these against the .py and say so.
 *
 * The only transformation is mechanical: Python's inline `(?i)` flag has no
 * JavaScript equivalent, so it is stripped from the head of the source and
 * re-applied as the `i` flag. Nothing else is touched.
 *
 * If you change a pattern here, change it in the Python in the same commit, or
 * write down in CHANGELOG.md why the two are deliberately different.
 */

/** One pattern, carrying the Python text it came from so drift is diffable. */
export interface TriagePattern {
  /** The pattern exactly as it appears in classifier.py. */
  readonly source: string;
  /** The same pattern compiled for JavaScript. */
  readonly re: RegExp;
}

/**
 * Compile a Python pattern string.
 *
 * Python allows `(?i)` anywhere; classifier.py only ever puts it at the front,
 * which is the only position JavaScript can express as a flag. A `(?i)` found
 * elsewhere is therefore not something this port can honour, and throwing is
 * better than compiling a pattern whose case sensitivity silently differs from
 * the one it claims to mirror.
 */
export function py(source: string): TriagePattern {
  let body = source;
  let flags = "";
  if (body.startsWith("(?i)")) {
    body = body.slice(4);
    flags = "i";
  }
  if (body.includes("(?i)")) {
    throw new Error(
      `triage pattern has a non-leading (?i), which this port cannot mirror: ${source}`,
    );
  }
  return { source, re: new RegExp(body, flags) };
}

/**
 * Precedence, used ONLY to break ties between equal scores.
 *
 * classifier.py's docstring on this ordering, kept verbatim because it is the
 * design decision and not a comment:
 *
 *   > This ordering biases towards NOT over-escalating to Jira.
 *
 * Wrongly calling an outage a product defect costs someone an investigation
 * into a bug that does not exist. Wrongly calling a product defect an outage
 * costs a run, because the next green corrects it. The asymmetry is deliberate
 * and was tuned against real failures; do not reorder this to make a test pass.
 */
export const CATEGORY_ORDER = [
  "infrastructure",
  "environmental",
  "flake",
  "real-defect",
  "expected-failure",
] as const;

export type TriageCategory = (typeof CATEGORY_ORDER)[number];

export function isTriageCategory(value: unknown): value is TriageCategory {
  return typeof value === "string" && (CATEGORY_ORDER as readonly string[]).includes(value);
}

/**
 * Categories that invalidate every other result in the same run.
 *
 * If the application was not serving, no test in that run exercised the
 * product — so a `real-defect` verdict elsewhere in the same run means
 * nothing. These two are contagious; the rest are statements about one test
 * and nothing else.
 *
 * This distinction is agentic-qa's, not classifier.py's. The service classifies
 * failures one at a time for a dashboard and never has to decide what a verdict
 * implies about its neighbours; a loop that must decide whether to keep working
 * does.
 */
export const CONTAGIOUS: readonly TriageCategory[] = ["infrastructure", "environmental"];

export function isContagious(c: TriageCategory): boolean {
  return CONTAGIOUS.includes(c);
}

// ---------------------------------------------------------------------------
// Signature patterns — mirrored from classifier.py, in its order.
// ---------------------------------------------------------------------------

export const INFRASTRUCTURE_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\b(out of memory|OOM|memory limit|killed\s*\(signal 9\))\b`),
  py(String.raw`(?i)\b(disk\s+full|no\s+space\s+left)\b`),
  py(String.raw`(?i)\b(docker\s+daemon|docker\s+socket)\b.*\b(unavailable|refused)\b`),
  py(String.raw`(?i)\b(runner|agent)\b.*\b(lost|disconnected|terminated)\b`),
  py(
    String.raw`(?i)\b(ci[\-_\s]?runner|jenkins\s+agent|github\s+actions\s+runner)\b.*(timeout|failed)`,
  ),
];

export const ENVIRONMENTAL_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\b(connection\s+refused|econnrefused|connreset|network\s+unreachable)\b`),
  py(String.raw`(?i)\b(dns|name\s+resolution|hostname\s+not\s+resolved)\b`),
  py(String.raw`(?i)\b(5\d\d\s+(internal\s+server\s+error|bad\s+gateway|service\s+unavailable))\b`),
  py(String.raw`(?i)\b(certificate|ssl|tls)\b.*\b(expired|invalid|self[\-\s]signed)\b`),
  py(String.raw`(?i)\b(env(ironment)?\s+variable|missing\s+config)\b`),
  py(String.raw`(?i)\b(database\s+connection|db\s+unreachable|migration\s+failed)\b`),
];

export const FLAKE_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\btimed\s*out\s*(after)?\s*\d+\s*(ms|sec|s)\b`),
  py(String.raw`(?i)\b(stale\s+element|element\s+not\s+found|element\s+not\s+visible)\b`),
  py(
    String.raw`(?i)\b(waitfor|wait\s+for|\bwaituntil\b|\bwait_until\b)\b.*\b(timeout|failed|exceeded)\b`,
  ),
  py(String.raw`(?i)\brandom\s+sleep\b`),
  py(String.raw`(?i)\bcypress\s+command\s+timeout\b`),
  py(String.raw`(?i)\bintermittent\b`),
];

export const REAL_DEFECT_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\bassert(ion)?\s*(error|failed)?\b`),
  py(String.raw`(?i)\bexpected\s+.+\s+to\s+(equal|be|contain|match)\b`),
  py(
    String.raw`(?i)\b4\d\d\s+(bad\s+request|unauthoriz|forbidden|not\s+found|conflict|unprocessable)\b`,
  ),
  py(String.raw`(?i)\b(test\s+failed:|\bFAIL\b\s)`),
  py(String.raw`(?i)\bvalidation\s+error\b`),
];

export const EXPECTED_FAILURE_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\b(xfail|xpass|@expectedFailure|@skip(?:_?if)?)\b`),
  py(String.raw`(?i)\bknown\s+issue\b`),
];

/** The ported banks by category, in CATEGORY_ORDER. */
export const BANKS: Record<TriageCategory, readonly TriagePattern[]> = {
  infrastructure: INFRASTRUCTURE_PATTERNS,
  environmental: ENVIRONMENTAL_PATTERNS,
  flake: FLAKE_PATTERNS,
  "real-defect": REAL_DEFECT_PATTERNS,
  "expected-failure": EXPECTED_FAILURE_PATTERNS,
};

// ---------------------------------------------------------------------------
// Playwright extension banks — agentic-qa's, NOT ported.
// ---------------------------------------------------------------------------
/**
 * What the banks above miss, because they were not tuned on this framework.
 *
 * classifier.py's patterns were derived from Defects4J and BugsInPy: Java and
 * Python stack traces, pytest and JUnit phrasing. agentic-qa runs Playwright,
 * which says different words for the same things, and running the real reporter
 * showed how little overlap there is:
 *
 *   - Playwright writes "Timeout 5000ms exceeded", which matches NEITHER
 *     `timed\s*out\s*(after)?\s*\d+` nor `wait\s+for.*exceeded` — the text is
 *     "waiting for", not "wait for". A textbook flake scored 0 on the flake bank.
 *   - Playwright assertions read "expect(received).toBe(expected)". The word
 *     "AssertionError" never appears, so the real-defect bank scored 0 on a
 *     clean assertion failure.
 *
 * These live in a SEPARATE bank rather than being appended to the ported ones,
 * for two reasons. The ported lists stay byte-comparable with the Python, which
 * is the whole point of keeping their source text. And scoring is a fraction of
 * bank size, so appending would silently change every ported score and make two
 * implementations disagree by arithmetic rather than by judgement.
 *
 * `classifyFailure` scores the two banks independently and takes the higher, so
 * a category can be reached by either vocabulary and neither dilutes the other.
 */
export const PW_INFRASTRUCTURE_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\bworker process (exited|crashed)\b`),
  py(String.raw`(?i)\bbrowserType\.launch\b`),
  py(String.raw`(?i)\bExecutable doesn't exist\b`),
  py(String.raw`(?i)\bplease run the following command to download new browsers\b`),
];

export const PW_ENVIRONMENTAL_PATTERNS: readonly TriagePattern[] = [
  py(
    String.raw`(?i)\bnet::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|NAME_NOT_RESOLVED|EMPTY_RESPONSE|CONNECTION_TIMED_OUT)\b`,
  ),
  py(String.raw`(?i)\b(page|apiRequestContext)\.(goto|get|post|fetch):`),
  py(String.raw`(?i)\bnavigating to ".+", waiting until "\w+"`),
  py(String.raw`(?i)\bwebServer\b.*\b(failed|timed out|exited)\b`),
];

/**
 * The suite saying, in words, that the ENVIRONMENT failed — not the product.
 *
 * These are not scored with the banks above; they decide. A test author who
 * writes "a 401 is a fixture problem, not a product defect" into an assertion
 * message has made the call triage exists to make, with more context than any
 * regex has. Scoring that sentence against the real-defect bank is how
 * 20261007T201833Z lost: the same message carried Playwright's standard
 * `expect(received).toBe(expected) // Object.is equality` boilerplate, which
 * matched three real-defect patterns and outscored the three words that
 * mattered. The run — a fresh container with no test account — was reported
 * as "NOT green, 1 failed" instead of "nothing measured the product".
 *
 * Narrow on purpose. A bare 401 with no such language stays a product
 * failure: triage believes a suite that says so, it does not assume.
 */
export const DECLARED_ENVIRONMENTAL: readonly TriagePattern[] = [
  py(String.raw`(?i)\b(fixture|environment|setup) problem\b`),
  py(String.raw`(?i)\bnot a product (defect|bug|failure)\b`),
  py(String.raw`(?i)\blogin endpoint returned 4\d\d\b.*\bcheck\b`),
  py(String.raw`(?i)\bcheck (that )?\S.*\bare correct for this environment\b`),
  py(String.raw`(?i)\benv(ironment)? var(iable)?\b.*\bmust be set\b`),
];

/**
 * A failure in a SETUP hook: no step of the test body ran, so nothing about the
 * behaviour under test was observed. Decides, like DECLARED_ENVIRONMENTAL.
 *
 * Run 20261011T214846Z: Juice Shop's welcome banner covered the cookie bar,
 * the beforeEach dismiss click timed out in all four tests, and the
 * reproduce-means-defect rule turned four setup failures into four "product
 * defects held for you" while the agent rewrote test steps that never ran.
 */
export const SETUP_HOOK_FAILURE: readonly TriagePattern[] = [
  py(String.raw`(?i)\bwhile running "(beforeEach|beforeAll)" hook\b`),
];

/**
 * The test's own code is invalid — the product was never asked anything. Not a
 * defect, and not a flake either: it fails the same way every time until the
 * test is fixed, which is why it must not go through the repetition rule.
 */
export const TEST_CODE_ERROR: readonly TriagePattern[] = [
  py(String.raw`(?i)\bwhile parsing css selector\b`),
  py(String.raw`(?i)\bis not a valid selector\b`),
  py(String.raw`(?i)\bUnexpected token\b.{0,40}\bselector\b`),
];

/** Rationale prefixes the repetition rule and the live line recognise. */
export const SETUP_HOOK_RATIONALE = "A setup hook failed before the test body ran";
export const TEST_CODE_RATIONALE = "The test's own code is invalid";
export const STALE_RATIONALE = "The page or element was torn down mid-action";

export const PW_FLAKE_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\bTimeout\s+\d+\s*ms\s+exceeded\b`),
  py(String.raw`(?i)\bTest timeout of \d+\s*ms exceeded\b`),
  py(String.raw`(?i)\bwaiting for (locator|selector|expect)\b`),
  py(String.raw`(?i)\belement is not (visible|stable|enabled|attached)\b`),
  py(String.raw`(?i)\blocator resolved to \d+ elements\b`),
  py(String.raw`(?i)\btarget (page|frame|context) (closed|crashed)\b`),
];

export const PW_REAL_DEFECT_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\bexpect\(received\)\.`),
  py(String.raw`(?i)\bObject\.is equality\b`),
  py(String.raw`(?i)\bExpected (substring|string|pattern|value|array|object):`),
  py(String.raw`(?i)\btoHave(Text|Value|Count|Title|URL|Attribute|Class|CSS)\b`),
  // The trailing \b is deliberate, not an oversight. It matches `toBe(`,
  // `toEqual(`, `toContain(` — assertions about a VALUE the product returned —
  // and deliberately does NOT match `toBeVisible`, `toBeEnabled`,
  // `toBeChecked` and the rest of the waiting-assertion family.
  //
  // Those are genuinely ambiguous. `expect(locator).toBeVisible()` timing out
  // means either the product never rendered the element or the test is looking
  // for the wrong one, and no regular expression can tell which. Calling them
  // product defects on sight would file bugs against bad locators; calling them
  // flakes forever would hide real breakage. Neither is settled here — it is
  // settled by whether the failure REPRODUCES, in `applyRepetition` below.
  py(String.raw`(?i)\bexpect\(.*\)\.(not\.)?to(Be|Equal|Contain|Match)\b`),
];

export const PW_EXPECTED_FAILURE_PATTERNS: readonly TriagePattern[] = [
  py(String.raw`(?i)\btest\.(fail|fixme)\(`),
  py(String.raw`(?i)\bmarked as "?(fail|fixme)"?\b`),
];

/** The Playwright extension banks by category. */
export const PW_BANKS: Record<TriageCategory, readonly TriagePattern[]> = {
  infrastructure: PW_INFRASTRUCTURE_PATTERNS,
  environmental: PW_ENVIRONMENTAL_PATTERNS,
  flake: PW_FLAKE_PATTERNS,
  "real-defect": PW_REAL_DEFECT_PATTERNS,
  "expected-failure": PW_EXPECTED_FAILURE_PATTERNS,
};

/**
 * Scoring weights, mirrored from classify_failure().
 *
 * These are magic numbers in the Python too. They are named here rather than
 * inlined so that the drift check can compare values instead of arithmetic.
 */
export const RETRY_FLAKE_BOOST = 0.25;
export const SLOW_TEST_BOOST = 0.1;
export const SLOW_TEST_THRESHOLD_MS = 60_000;
/** Confidence given to the no-signature default. */
export const NO_SIGNATURE_CONFIDENCE = 0.1;
