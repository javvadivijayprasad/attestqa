import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BANKS,
  CATEGORY_ORDER,
  NO_SIGNATURE_CONFIDENCE,
  isContagious,
  isTriageCategory,
  py,
} from "../src/triage/patterns.js";
import { classifyFailure, repairable, triageRun } from "../src/triage/classify.js";
import { parseFailures, readFailures, reportPath } from "../src/triage/report.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "aqa-triage-"));
}

describe("pattern porting", () => {
  it("strips a leading (?i) and re-applies it as a flag", () => {
    const p = py(String.raw`(?i)\bhello\b`);
    expect(p.re.flags).toContain("i");
    expect(p.re.test("HELLO there")).toBe(true);
    // The source text is kept verbatim, because it is what the drift check
    // compares against the Python.
    expect(p.source).toBe(String.raw`(?i)\bhello\b`);
  });

  it("refuses a (?i) it cannot mirror rather than changing case sensitivity silently", () => {
    expect(() => py(String.raw`\bfoo(?i)bar\b`)).toThrow(/non-leading/);
  });

  it("compiles every ported pattern", () => {
    // The banks are built at module load, so this is really asserting that
    // importing the module did not throw — but it names the thing being
    // checked, which a bare import does not.
    for (const category of CATEGORY_ORDER) {
      expect(BANKS[category].length).toBeGreaterThan(0);
      for (const p of BANKS[category]) expect(p.re).toBeInstanceOf(RegExp);
    }
  });
});

describe("classification is scored, not first-match", () => {
  // This is the behaviour the first design draft got wrong. `flake` comes
  // before `real-defect` in CATEGORY_ORDER, so a first-match implementation
  // would call this flake. The Python scores each bank by the fraction of its
  // patterns that matched: one of six flake patterns is 0.167, two of five
  // real-defect patterns is 0.4, and the higher score wins.
  it("prefers the higher-scoring bank over the earlier one in precedence", () => {
    const v = classifyFailure({
      testId: "checkout › applies a discount",
      message: "AssertionError: expected 90.00 to equal 100.00 — element not found after update",
    });
    expect(v.category).toBe("real-defect");
  });

  it("uses precedence only to break a tie", () => {
    // One pattern from each of two banks, both banks the same size would be
    // needed for an exact tie, so assert the rule directly on the ordering
    // instead: infrastructure precedes environmental.
    expect(CATEGORY_ORDER.indexOf("infrastructure")).toBeLessThan(
      CATEGORY_ORDER.indexOf("environmental"),
    );
    const v = classifyFailure({
      testId: "t",
      message: "The CI runner was lost and the connection refused",
    });
    expect(v.category).toBe("infrastructure");
  });

  it("defaults an unmatched failure to real-defect at low confidence", () => {
    const v = classifyFailure({ testId: "t", message: "something inexplicable happened" });
    expect(v.category).toBe("real-defect");
    expect(v.confidence).toBe(NO_SIGNATURE_CONFIDENCE);
    expect(v.matchedPatterns).toEqual([]);
    // The rationale must say WHY an unmatched failure still escalates, or a
    // reader sees a confident-looking verdict with nothing behind it.
    expect(v.rationale).toMatch(/No known failure pattern matched/);
  });

  it("still quotes evidence when nothing matched", () => {
    const v = classifyFailure({ testId: "t", message: "first line\nsecond line" });
    expect(v.evidence).toBe("first line");
  });

  it("quotes the failure's own words, not the pattern that matched them", () => {
    const v = classifyFailure({ testId: "t", message: "Error: connection refused on :3000" });
    expect(v.category).toBe("environmental");
    expect(v.evidence).toBe("Error: connection refused on :3000");
    expect(v.evidence).not.toContain("\\b");
  });

  it("names the locator, so two different broken locators are not one repeated failure", () => {
    // 20261018T125846Z: getByText('$14._15') was repaired, the test moved on to
    // getByText('$12._01'), and the identical evidence counted it as a repeat.
    const msg = (loc: string) =>
      `Error: expect(locator).toBeVisible() failed\n\nLocator: ${loc}\nExpected: visible`;
    const a = classifyFailure({ testId: "t", message: msg("getByText('$14._15').first()") });
    const b = classifyFailure({ testId: "t", message: msg("getByText('$12._01').first()") });
    expect(a.evidence).toContain("Locator: getByText('$14._15')");
    expect(a.evidence).not.toBe(b.evidence);
  });

  it("carries the expected/received pair, which is the part a person needs", () => {
    // The first version joined matched pattern fragments and produced
    // "expect(received). · Object.is equality · expect(received).toBe" on a real
    // Playwright failure — three fragments of one sentence, none of them the
    // useful part. This string is what gets quoted into a bug report.
    const v = classifyFailure({
      testId: "t",
      message:
        "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 90\nReceived: 100",
    });
    expect(v.category).toBe("real-defect");
    expect(v.evidence).toContain("Expected: 90");
    expect(v.evidence).toContain("Received: 100");
    // ...and which patterns matched is still recorded, just not made human-facing.
    expect(v.matchedPatterns.length).toBeGreaterThan(0);
  });
});

describe("scoring adjustments", () => {
  it("nudges toward flake only when an attempt actually passed", () => {
    const message = "Error: something went wrong";
    expect(classifyFailure({ testId: "t", message }).category).toBe("real-defect");
    // The count alone is not enough: Playwright's `retries: 1` config makes
    // every failure report a retry, so a count-only rule fires on everything.
    expect(classifyFailure({ testId: "t", message, retries: 2 }).category).toBe("real-defect");
    expect(classifyFailure({ testId: "t", message, retries: 2, flakyHistory: true }).category).toBe(
      "flake",
    );
  });

  it("nudges a very slow failure toward infrastructure/flake, precedence deciding", () => {
    const message = "Error: something went wrong";
    // The boost lifts BOTH infrastructure and flake by the same amount, so with
    // no pattern match they tie at 0.1 and precedence hands it to
    // infrastructure. Faithful to the Python; asserted here because it is
    // surprising, and because it is what motivates the evidence requirement on
    // contagion below.
    expect(classifyFailure({ testId: "t", message, durationMs: 90_000 }).category).toBe(
      "infrastructure",
    );
    // Just under the threshold must NOT be nudged, or the boundary is untested
    // and the threshold is decoration.
    expect(classifyFailure({ testId: "t", message, durationMs: 60_000 }).category).toBe(
      "real-defect",
    );
  });

  it("caps confidence at 1", () => {
    const v = classifyFailure({
      testId: "t",
      message:
        "timed out after 5000 ms; stale element; wait for timeout exceeded; random sleep; " +
        "cypress command timeout; intermittent",
      retries: 3,
      durationMs: 120_000,
    });
    expect(v.confidence).toBeLessThanOrEqual(1);
  });
});

describe("contagion", () => {
  it("marks only infrastructure and environmental as contagious", () => {
    expect(isContagious("infrastructure")).toBe(true);
    expect(isContagious("environmental")).toBe(true);
    expect(isContagious("real-defect")).toBe(false);
    expect(isContagious("flake")).toBe(false);
    expect(isContagious("expected-failure")).toBe(false);
  });

  it("writes off the run — and its defect candidates — when the app was not serving", () => {
    const r = triageRun([
      { testId: "a", message: "AssertionError: expected 90.00 to equal 100.00" },
      { testId: "b", message: "connect ECONNREFUSED 127.0.0.1:3000" },
    ]);
    expect(r.runLevel).toBe("environmental");
    // The point of the rule: test "a" looked like a product defect, but nothing
    // in this run exercised the product, so it is NOT a defect candidate.
    // Reporting it would send someone to investigate a bug that may not exist.
    expect(r.quarantined).toEqual([]);
    expect(repairable(r)).toEqual([]);
  });

  it("does not write off a run on a duration heuristic alone", () => {
    // A slow failure with no recognisable error classifies as infrastructure
    // (see the scoring test above). Letting that write off every other result
    // would make a stopwatch the strongest claim in the system.
    const r = triageRun([
      { testId: "slow", message: "Error: something went wrong", durationMs: 90_000 },
      { testId: "a", message: "AssertionError: expected 90.00 to equal 100.00" },
    ]);
    expect(r.verdicts[0]?.category).toBe("infrastructure");
    expect(r.runLevel).toBeNull();
    // ...so the real defect is still a defect candidate.
    expect(r.quarantined).toEqual(["a"]);
  });

  it("reports the more fundamental category when both contagious kinds are present", () => {
    const r = triageRun([
      { testId: "a", message: "connect ECONNREFUSED 127.0.0.1:3000" },
      { testId: "b", message: "the runner was disconnected" },
    ]);
    expect(r.runLevel).toBe("infrastructure");
  });

  it("leaves other results alone when a real defect is found", () => {
    const r = triageRun([
      { testId: "a", message: "AssertionError: expected 90.00 to equal 100.00" },
      { testId: "b", message: "timed out after 5000 ms waiting for locator" },
    ]);
    expect(r.runLevel).toBeNull();
    expect(r.quarantined).toEqual(["a"]);
    // The flake is still the agent's to deal with; a product defect in one test
    // says nothing about another.
    expect(repairable(r).map((v) => v.test)).toEqual(["b"]);
  });

  it("quarantines every real defect, not just the first", () => {
    const r = triageRun([
      { testId: "a", message: "AssertionError: expected 1 to equal 2" },
      { testId: "b", message: "AssertionError: expected 3 to equal 4" },
    ]);
    expect(r.quarantined).toEqual(["a", "b"]);
  });

  it("does not quarantine an expected failure", () => {
    const r = triageRun([{ testId: "a", message: "known issue: xfail" }]);
    expect(r.quarantined).toEqual([]);
    expect(repairable(r)).toEqual([]);
  });
});

describe("report parsing", () => {
  const report = (suites: unknown) => JSON.stringify({ suites });

  it("distinguishes an unreadable report from a clean one", () => {
    // Collapsing these two would turn a corrupt report into a clean bill of
    // health, which is the most expensive possible bug in a verifier.
    expect(parseFailures("not json")).toBeUndefined();
    expect(parseFailures("{}")).toBeUndefined();
    expect(parseFailures(report([]))).toEqual([]);
  });

  it("builds a test id from the file and the enclosing suites", () => {
    const failures = parseFailures(
      report([
        {
          file: "checkout.spec.ts",
          title: "checkout.spec.ts",
          suites: [
            {
              title: "discounts",
              specs: [
                {
                  title: "applies a code",
                  ok: false,
                  tests: [{ results: [{ error: { message: "boom" }, duration: 12 }] }],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(failures).toHaveLength(1);
    // A bare spec title is not an identity: two files can both contain
    // "applies a code", and quarantining one must not quarantine the other.
    expect(failures?.[0]?.testId).toBe("checkout.spec.ts › discounts › applies a code");
  });

  it("does not repeat the file name when the top suite is titled after it", () => {
    const failures = parseFailures(
      report([
        {
          file: "login.spec.ts",
          title: "login.spec.ts",
          specs: [
            {
              title: "rejects a blank password",
              ok: false,
              tests: [{ results: [{ error: { message: "boom" } }] }],
            },
          ],
        },
      ]),
    );
    expect(failures?.[0]?.testId).toBe("login.spec.ts › rejects a blank password");
  });

  it("takes the last attempt's error and counts the retries before it", () => {
    // Taking the FIRST error would report a retry count of zero, which is
    // exactly the combination the retries adjustment exists to catch.
    const failures = parseFailures(
      report([
        {
          file: "a.spec.ts",
          specs: [
            {
              title: "flaky one",
              ok: false,
              tests: [
                {
                  results: [
                    { retry: 0, error: { message: "first failure" }, duration: 10 },
                    { retry: 1, error: { message: "second failure" }, duration: 20 },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(failures?.[0]?.message).toBe("second failure");
    expect(failures?.[0]?.retries).toBe(1);
    expect(failures?.[0]?.durationMs).toBe(20);
  });

  it("skips passing specs", () => {
    const failures = parseFailures(
      report([
        {
          file: "a.spec.ts",
          specs: [
            { title: "passes", ok: true, tests: [{ results: [{ duration: 1 }] }] },
            {
              title: "fails",
              ok: false,
              tests: [{ results: [{ error: { message: "boom" } }] }],
            },
          ],
        },
      ]),
    );
    expect(failures?.map((f) => f.title)).toEqual(["fails"]);
  });

  it("falls back to the errors array when there is no error field", () => {
    const failures = parseFailures(
      report([
        {
          file: "a.spec.ts",
          specs: [
            {
              title: "fails",
              ok: false,
              tests: [{ results: [{ errors: [{ message: "from errors[]" }] }] }],
            },
          ],
        },
      ]),
    );
    expect(failures?.[0]?.message).toBe("from errors[]");
  });

  it("returns undefined when no report has been written", () => {
    expect(readFailures(workspace())).toBeUndefined();
  });

  it("reads the report PwTools persists", () => {
    const ws = workspace();
    const file = reportPath(ws);
    mkdirSync(join(ws, ".aqa-report"), { recursive: true });
    writeFileSync(
      file,
      report([
        {
          file: "a.spec.ts",
          specs: [
            {
              title: "fails",
              ok: false,
              tests: [{ results: [{ error: { message: "connect ECONNREFUSED" } }] }],
            },
          ],
        },
      ]),
      "utf8",
    );
    const failures = readFailures(ws);
    expect(failures).toHaveLength(1);
    expect(triageRun(failures ?? []).runLevel).toBe("environmental");
  });
});

describe("category guard", () => {
  it("accepts the five categories and nothing else", () => {
    for (const c of CATEGORY_ORDER) expect(isTriageCategory(c)).toBe(true);
    expect(isTriageCategory("real_defect")).toBe(false);
    expect(isTriageCategory(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The step layer: gaps, and the quarantine check.
// ---------------------------------------------------------------------------

import { triageGaps, runTriage } from "../src/triage/step.js";
import type { AnyRunEvent, TriagePayload } from "../src/types.js";

function triageEvent(eventId: number, payload: TriagePayload): AnyRunEvent {
  return {
    tool: "agentic-qa",
    runId: "r",
    eventId,
    timestamp: eventId * 1000,
    kind: "triage",
    payload,
  };
}

function attemptFrom(attempt: number, failures: Parameters<typeof triageRun>[0]): TriagePayload {
  const r = triageRun(failures);
  return {
    attempt,
    reportFingerprint: `fp${attempt}`,
    runLevel: r.runLevel,
    verdicts: r.verdicts,
    quarantined: r.quarantined,
  };
}

describe("triage gaps", () => {
  it("has nothing to say about a run that was never triaged", () => {
    expect(triageGaps([])).toEqual({
      gaps: [],
      limitations: [],
      attempts: 0,
      latestVerdicts: 0,
      defectCandidates: [],
    });
  });

  it("names the fix, and the person who has to make it, when the app was down", () => {
    const g = triageGaps([
      triageEvent(1, attemptFrom(1, [{ testId: "a", message: "connect ECONNREFUSED :3000" }])),
    ]);
    expect(g.gaps.map((x) => x.code)).toEqual(["sut-unavailable"]);
    // The message must say that editing the spec cannot help, because that is
    // exactly what the agent will otherwise spend the next 60 inferences doing.
    expect(g.gaps[0]?.message).toMatch(/no edit to the spec will fix it/i);
  });

  it("raises a separate candidate per real defect, and forbids editing each", () => {
    const g = triageGaps([
      triageEvent(
        1,
        attemptFrom(1, [
          { testId: "a", message: "AssertionError: expected 1 to equal 2" },
          { testId: "b", message: "AssertionError: expected 3 to equal 4" },
        ]),
      ),
    ]);
    // Candidates for a PERSON, not gaps for the agent: nothing the agent can do
    // closes them, and treating them as gaps only burned the verifier's retry
    // (observed in 20260921T192908Z, where the retry produced a second bug
    // proposal about the same failure and the run still ended blocked).
    expect(g.gaps).toEqual([]);
    expect(g.defectCandidates).toHaveLength(2);
    expect(g.limitations.filter((l) => /quarantined/.test(l))).toHaveLength(2);
    expect(g.limitations.join(" ")).toMatch(/put to the reviewer at the end of the run/);
  });

  it("reports no defect candidates from a run that measured nothing", () => {
    // The real defect verdict on "a" is real enough as a classification, but
    // the app was not serving, so it is not evidence of anything.
    const g = triageGaps([
      triageEvent(
        1,
        attemptFrom(1, [
          { testId: "a", message: "AssertionError: expected 1 to equal 2" },
          { testId: "b", message: "connect ECONNREFUSED :3000" },
        ]),
      ),
    ]);
    expect(g.gaps.map((x) => x.code)).toEqual(["sut-unavailable"]);
  });
});

describe("quarantine check", () => {
  const defect = { testId: "a", message: "AssertionError: expected 90.00 to equal 100.00" };

  it("says nothing on the first attempt — there is no baseline yet", () => {
    const g = triageGaps([triageEvent(1, attemptFrom(1, [defect]))]);
    expect(g.gaps.map((x) => x.code)).not.toContain("quarantined-test-modified");
  });

  it("passes a quarantined test that still fails identically", () => {
    const g = triageGaps([
      triageEvent(1, attemptFrom(1, [defect])),
      triageEvent(2, attemptFrom(2, [defect])),
    ]);
    expect(g.gaps.map((x) => x.code)).not.toContain("quarantined-test-modified");
  });

  it("catches a quarantined test whose assertion was relaxed", () => {
    const g = triageGaps([
      triageEvent(1, attemptFrom(1, [defect])),
      triageEvent(
        2,
        attemptFrom(2, [{ testId: "a", message: "AssertionError: expected 100 to equal 100" }]),
      ),
    ]);
    const gap = g.gaps.find((x) => x.code === "quarantined-test-modified");
    expect(gap).toBeDefined();
    expect(gap?.message).toMatch(/destroys the evidence/);
  });

  it("catches a quarantined test that quietly went green", () => {
    // "It passes now" and "the assertion was neutered" look identical from
    // here, and only one of them is good news — so a human is asked.
    const g = triageGaps([
      triageEvent(1, attemptFrom(1, [defect])),
      triageEvent(2, attemptFrom(2, [{ testId: "b", message: "timed out after 5000 ms" }])),
    ]);
    const gap = g.gaps.find((x) => x.code === "quarantined-test-modified");
    expect(gap).toBeDefined();
    expect(JSON.stringify(gap?.evidence)).toContain("no longer failing");
  });

  it("uses the earliest baseline, so drift across three attempts is not lost", () => {
    const g = triageGaps([
      triageEvent(1, attemptFrom(1, [defect])),
      triageEvent(2, attemptFrom(2, [defect])),
      triageEvent(
        3,
        attemptFrom(3, [{ testId: "a", message: "AssertionError: expected 5 to equal 5" }]),
      ),
    ]);
    expect(g.gaps.map((x) => x.code)).toContain("quarantined-test-modified");
  });

  it("does not check quarantine on a run that measured nothing", () => {
    // The app went down on the retry; "a" failing differently says nothing
    // about whether anyone touched it.
    const g = triageGaps([
      triageEvent(1, attemptFrom(1, [defect])),
      triageEvent(2, attemptFrom(2, [{ testId: "a", message: "connect ECONNREFUSED :3000" }])),
    ]);
    expect(g.gaps.map((x) => x.code)).toEqual(["sut-unavailable"]);
  });
});

describe("runTriage", () => {
  it("writes no event when there is no report", async () => {
    expect(await runTriage({ events: [], workspaceDir: workspace() })).toBeUndefined();
  });

  it("writes no event when the suite is green", async () => {
    const ws = workspace();
    mkdirSync(join(ws, ".aqa-report"), { recursive: true });
    writeFileSync(reportPath(ws), JSON.stringify({ suites: [] }), "utf8");
    expect(await runTriage({ events: [], workspaceDir: ws })).toBeUndefined();
  });

  it("counts attempts from the ledger, not from itself", async () => {
    // Superseded in part by the "re-triaging an unchanged report" tests below:
    // a SECOND attempt now requires the report to have actually changed, so
    // this asserts only what it can — the first attempt is numbered from the
    // ledger's history rather than from any counter inside runTriage.
    const ws = workspace();
    mkdirSync(join(ws, ".aqa-report"), { recursive: true });
    writeFileSync(
      reportPath(ws),
      JSON.stringify({
        suites: [
          {
            file: "a.spec.ts",
            specs: [
              {
                title: "fails",
                ok: false,
                tests: [
                  { results: [{ error: { message: "AssertionError: expected 1 to be 2" } }] },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const first = await runTriage({ events: [], workspaceDir: ws });
    expect(first?.attempt).toBe(1);
    const fresh = await runTriage({ events: [], workspaceDir: ws });
    expect(fresh?.attempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The service: an upgrade that must never become a dependency.
// ---------------------------------------------------------------------------

import { analyzeReport, merge, type FetchLike } from "../src/triage/service.js";

function jsonFetch(status: number, body: unknown): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** A minimal /analyze-report response in the service's real shape. */
function analyzeBody(
  classifications: Array<Record<string, unknown>>,
  groups: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    run_id: "r",
    framework: "playwright",
    detected_format: "playwright-json",
    total_failures: classifications.length,
    classifications,
    groups,
    retry_plans: [],
    summary: {},
    attachments: {},
    provenance: { service_version: "0.4.1" },
  };
}

function reportIn(ws: string, message: string): void {
  mkdirSync(join(ws, ".aqa-report"), { recursive: true });
  writeFileSync(
    reportPath(ws),
    JSON.stringify({
      suites: [
        {
          file: "a.spec.ts",
          specs: [{ title: "fails", ok: false, tests: [{ results: [{ error: { message } }] }] }],
        },
      ],
    }),
    "utf8",
  );
}

describe("the defect-analysis service, at its real endpoint", () => {
  // The first version of this adapter POSTed to /classify — an endpoint that
  // does not exist. It was written from the shape of the in-process port rather
  // than from the service's API, so it would have 404'd on first contact and
  // looked "unreachable" rather than misaddressed, forever.
  it("posts the report to /analyze-report", async () => {
    const ws = workspace();
    reportIn(ws, "boom");
    let seen = "";
    const spy: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => analyzeBody([]) };
    };
    await analyzeReport(
      { reportPath: reportPath(ws), runId: "r" },
      { url: "http://svc.test/", fetch: spy },
    );
    expect(seen).toBe("http://svc.test/analyze-report");
  });

  it("sends the report inline as playwright-json by default", async () => {
    const ws = workspace();
    reportIn(ws, "boom");
    let body: Record<string, unknown> = {};
    const spy: FetchLike = async (_u, init) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => analyzeBody([]) };
    };
    await analyzeReport(
      { reportPath: reportPath(ws), runId: "run-7" },
      { url: "http://svc.test", fetch: spy },
    );
    // Inline rather than by path: a path only resolves when the service shares
    // this filesystem, and one that does not is a 404 the run cannot diagnose.
    expect(body["format"]).toBe("playwright-json");
    expect(body["framework"]).toBe("playwright");
    expect(body["run_id"]).toBe("run-7");
    expect(String(body["content"])).toContain("a.spec.ts");
    expect(body["path"]).toBeUndefined();
  });

  it("sends a path instead when the service shares the filesystem", async () => {
    const ws = workspace();
    reportIn(ws, "boom");
    let body: Record<string, unknown> = {};
    const spy: FetchLike = async (_u, init) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => analyzeBody([]) };
    };
    await analyzeReport(
      { reportPath: reportPath(ws), runId: "r" },
      { url: "http://svc.test", fetch: spy, byPath: true },
    );
    expect(String(body["path"])).toContain("playwright.json");
    expect(body["content"]).toBeUndefined();
  });

  it("maps classifications, fingerprints and the service version", async () => {
    const ws = workspace();
    reportIn(ws, "boom");
    const r = await analyzeReport(
      { reportPath: reportPath(ws), runId: "r" },
      {
        url: "http://svc.test",
        fetch: jsonFetch(
          200,
          analyzeBody([
            {
              test_id: "a.spec.ts › fails",
              fingerprint: "fp-123",
              category: "flake",
              confidence: 0.9,
              rationale: "timing",
              llm_fix_hint: "await the banner",
            },
          ]),
        ),
      },
    );
    const v = r?.verdicts.get("a.spec.ts › fails");
    expect(v?.category).toBe("flake");
    expect(v?.triagedBy).toBe("service");
    expect(v?.serviceVersion).toBe("0.4.1");
    // The fix hint is the most actionable sentence the service produces and has
    // nowhere else to go in the ledger.
    expect(v?.rationale).toContain("Fix hint: await the banner");
    expect(r?.fingerprints.get("a.spec.ts › fails")).toBe("fp-123");
  });

  it("carries the group state that says a bug already exists", async () => {
    // The field that changes behaviour. Without it every run proposes the same
    // bug again, and a reviewer approving twice files the same defect twice.
    const ws = workspace();
    reportIn(ws, "boom");
    const r = await analyzeReport(
      { reportPath: reportPath(ws), runId: "r" },
      {
        url: "http://svc.test",
        fetch: jsonFetch(
          200,
          analyzeBody(
            [{ test_id: "a.spec.ts › fails", category: "real-defect", confidence: 0.8 }],
            [
              {
                fingerprint: "fp-1",
                category: "real-defect",
                count: 1,
                first_test_id: "a.spec.ts › fails",
                sample_test_ids: ["a.spec.ts › fails"],
                state: "filed",
                existing_jira_key: "AB-42",
                proposed_jira_summary: "Login does not redirect",
              },
            ],
          ),
        ),
      },
    );
    expect(r?.groups[0]?.existingBugKey).toBe("AB-42");
    expect(r?.groups[0]?.proposedSummary).toBe("Login does not redirect");
  });

  it("drops a category outside the agreed vocabulary", async () => {
    const ws = workspace();
    reportIn(ws, "boom");
    const r = await analyzeReport(
      { reportPath: reportPath(ws), runId: "r" },
      {
        url: "http://svc.test",
        fetch: jsonFetch(200, analyzeBody([{ test_id: "x", category: "probably-fine" }])),
      },
    );
    expect(r?.verdicts.size).toBe(0);
  });

  it("returns undefined on a non-200, a malformed body, or a thrown request", async () => {
    const ws = workspace();
    reportIn(ws, "boom");
    const at = { reportPath: reportPath(ws), runId: "r" };
    expect(await analyzeReport(at, { url: "u", fetch: jsonFetch(404, {}) })).toBeUndefined();
    expect(await analyzeReport(at, { url: "u", fetch: jsonFetch(200, { x: 1 }) })).toBeUndefined();
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await analyzeReport(at, { url: "u", fetch: boom })).toBeUndefined();
  });

  it("keeps the built-in evidence when the service supplies none", () => {
    // /analyze-report does not populate an evidence field, and a verdict with
    // no evidence is the unexplained judgement this runtime refuses everywhere.
    const builtin = [classifyFailure({ testId: "a", message: "AssertionError: 1 != 2" })];
    const service = new Map([
      ["a", { ...builtin[0]!, evidence: "", triagedBy: "service" as const }],
    ]);
    expect(merge(builtin, service).verdicts[0]?.evidence).toBe(builtin[0]?.evidence);
  });

  it("records a disagreement rather than silently overwriting", () => {
    const builtin = [classifyFailure({ testId: "a", message: "AssertionError: 1 != 2" })];
    expect(builtin[0]?.category).toBe("real-defect");
    const service = new Map([
      ["a", { ...builtin[0]!, category: "flake" as const, triagedBy: "service" as const }],
    ]);
    const m = merge(builtin, service);
    expect(m.verdicts[0]?.category).toBe("flake");
    expect(m.disagreements).toEqual([{ test: "a", builtin: "real-defect", service: "flake" }]);
  });
});

describe("triage falls back when the service does not answer", () => {
  it("uses the built-in rules and still quarantines", async () => {
    const ws = workspace();
    reportIn(ws, "AssertionError: expected 90 to equal 100");
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    // The execute path: the test existed before the run, so it is proven.
    const executePath = [
      {
        tool: "attestqa",
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "route",
        payload: { path: "B" },
      },
    ] as unknown as AnyRunEvent[];
    const t = await runTriage(
      { events: executePath, workspaceDir: ws },
      { service: { url: "http://svc.test", fetch: boom } },
    );
    // A triage service being down must never end a test run.
    expect(t?.verdicts[0]?.category).toBe("real-defect");
    expect(t?.verdicts[0]?.triagedBy).toBe("builtin");
    expect(t?.quarantined).toHaveLength(1);
  });

  it("does not quarantine a new test that has never passed (F3)", async () => {
    // 20261018T223256Z: a test written minutes earlier was frozen on its first failure.
    const ws = workspace();
    reportIn(ws, "AssertionError: expected 90 to equal 100");
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const t = await runTriage(
      { events: [], workspaceDir: ws },
      { service: { url: "http://svc.test", fetch: boom } },
    );
    expect(t?.verdicts[0]?.category).toBe("real-defect");
    expect(t?.quarantined).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real Playwright output. Every fixture above is JSON I wrote; these are bytes
// the reporter actually produced, and they caught three bugs the synthetic
// fixtures could not: ANSI colour codes in the message, a retry count that
// means configuration rather than flakiness, and pattern banks tuned on Java
// and Python that barely match Playwright's phrasing.
// ---------------------------------------------------------------------------

import { stripAnsi } from "../src/triage/report.js";

const ESC = String.fromCharCode(27);
const c = (code: string): string => `${ESC}[${code}m`;

/** A `toBe` failure exactly as Playwright's JSON reporter writes it: coloured. */
const PW_ASSERTION_MESSAGE =
  `Error: ${c("2")}expect(${c("22")}${c("31")}received${c("39")}${c("2")})` +
  `.${c("22")}toBe${c("2")}(${c("22")}${c("32")}expected${c("39")}${c("2")})` +
  ` // Object.is equality${c("22")}\n\nExpected: ${c("32")}90${c("39")}\n` +
  `Received: ${c("31")}100${c("39")}`;

function pwReport(specs: Array<{ title: string; message: string; statuses: string[] }>): string {
  return JSON.stringify({
    config: {},
    errors: [],
    stats: { expected: 0, skipped: 0, unexpected: specs.length, flaky: 0 },
    suites: [
      {
        title: "checkout.spec.js",
        file: "checkout.spec.js",
        specs: specs.map((s) => ({
          title: s.title,
          ok: false,
          tags: [],
          tests: [
            {
              status: "unexpected",
              results: s.statuses.map((status, i) => ({
                status,
                retry: i,
                duration: 5,
                ...(status === "failed"
                  ? {
                      error: {
                        message: s.message,
                        stack: `${s.message}\n    at checkout.spec.js`,
                      },
                      errors: [{ message: `${s.message}\n\n  1 | code snippet` }],
                    }
                  : {}),
              })),
            },
          ],
        })),
      },
    ],
  });
}

describe("real Playwright output", () => {
  it("strips the colour codes the reporter writes into assertion messages", () => {
    expect(stripAnsi(PW_ASSERTION_MESSAGE)).toContain("expect(received).toBe(expected)");
    expect(stripAnsi(PW_ASSERTION_MESSAGE)).not.toContain(ESC);
  });

  it("classifies a coloured assertion failure as a real defect", () => {
    // Uncoloured, the ported real-defect bank scores 0 on this: Playwright never
    // writes the word "AssertionError". Coloured, even the extension bank fails,
    // because the escape sequences sit between the words it looks for.
    const failures = parseFailures(
      pwReport([
        {
          title: "applies a 10% discount code",
          message: PW_ASSERTION_MESSAGE,
          statuses: ["failed", "failed"],
        },
      ]),
    );
    const v = triageRun(failures ?? []).verdicts[0];
    expect(v?.category).toBe("real-defect");
    expect(v?.evidence).toContain("Expected: 90");
  });

  it("does not call every failure a flake just because retries are configured", () => {
    // The bug this pins: `retries: 1` in playwright.config.js gives every
    // failing spec `results: failed,failed`. Under a count-only rule the +0.25
    // flake boost fired on all of them, and a plain ECONNREFUSED — an outage,
    // the most consequential verdict there is — came back classified `flake`.
    const failures = parseFailures(
      pwReport([
        {
          title: "reaches the API",
          message: "Error: connect ECONNREFUSED 127.0.0.1:3000",
          statuses: ["failed", "failed"],
        },
      ]),
    );
    expect(failures?.[0]?.retries).toBe(1);
    expect(failures?.[0]?.flakyHistory).toBe(false);
    const r = triageRun(failures ?? []);
    expect(r.verdicts[0]?.category).toBe("environmental");
    expect(r.runLevel).toBe("environmental");
  });

  it("does treat a test that passed on retry as having flaky history", () => {
    const failures = parseFailures(
      pwReport([
        { title: "banner", message: "Error: something odd", statuses: ["failed", "passed"] },
      ]),
    );
    expect(failures?.[0]?.flakyHistory).toBe(true);
  });

  it("recognises Playwright's timeout phrasing, which the ported bank misses", () => {
    // Playwright: "Timeout 5000ms exceeded waiting for locator".
    // The ported flake patterns want "timed out after 5000 ms", or "wait for"
    // followed by "exceeded" — and "waiting for" matches neither, so the ported
    // bank scores 0 on a textbook flake.
    const v = classifyFailure({
      testId: "t",
      message: "Error: Timeout 5000ms exceeded waiting for locator('.banner')",
    });
    expect(v.category).toBe("flake");
  });

  it("triages a whole real suite the way a tester would read it", () => {
    const failures = parseFailures(
      pwReport([
        {
          title: "applies a 10% discount code",
          message: PW_ASSERTION_MESSAGE,
          statuses: ["failed", "failed"],
        },
        {
          title: "waits for a slow banner",
          message: "Error: Timeout 5000ms exceeded waiting for locator('.banner')",
          statuses: ["failed", "failed"],
        },
      ]),
    );
    const r = triageRun(failures ?? []);
    expect(r.runLevel).toBeNull();
    expect(r.verdicts.map((v) => v.category).sort()).toEqual(["flake", "real-defect"]);
    expect(r.quarantined).toEqual(["checkout.spec.js \u203a applies a 10% discount code"]);
  });
});

// ---------------------------------------------------------------------------
// The stop rule. This is what the first implementation did not have: triage
// lived only in the verifier, which a repairing agent never reaches. Run
// 20260918T154354Z-1f5d7538 spent 33 inferences, four suite runs and fifteen
// rewrites of one spec and produced no triage event at all.
// ---------------------------------------------------------------------------

import { triageAction, applyRepetition } from "../src/triage/step.js";

describe("triage: retry before judging", () => {
  // The operator's rule, and it replaced a worse one. Triage used to end the
  // run on an unreachable application — deciding, on their behalf, that an
  // outage could never be a defect worth filing. A transient outage and a
  // persistent one look identical on the first report; only a clean re-run
  // separates them, and after that it is a person's call, not a regex's.
  const attempt = (n: number, failures: Parameters<typeof triageRun>[0]) => {
    const p = attemptFrom(n, failures);
    return { ...p, attempt: n };
  };

  it("asks for a plain re-run first, whatever the failure looks like", () => {
    for (const message of [
      "connect ECONNREFUSED 127.0.0.1:3000",
      "AssertionError: expected 90 to equal 100",
      "Timeout 5000ms exceeded waiting for locator",
      "the runner was disconnected",
    ]) {
      const a = triageAction(attempt(1, [{ testId: "a", message }]));
      expect(a.notes.join(" ")).toMatch(/run it again unchanged/i);
    }
  });

  it("forbids editing anything before the re-run", () => {
    // An edit makes the two runs incomparable and destroys the only evidence
    // that separates a flake from a defect.
    const a = triageAction(attempt(1, [{ testId: "a", message: "Timeout 5000ms exceeded" }]));
    expect(a.notes.join(" ")).toMatch(/Do not edit a spec, a selector or a config value first/);
  });

  it("asks for a bug once the failure has survived a re-run", () => {
    const a = triageAction(
      attempt(2, [{ testId: "a", message: "AssertionError: expected 90 to equal 100" }]),
    );
    const text = a.notes.join(" ");
    expect(text).toMatch(/propose a bug with the tracker's bug tool/);
    expect(text).toMatch(/a person is asked to approve it and may say no/i);
  });

  it("tells the reviewer WHAT KIND of failure it was", () => {
    // "The app was unreachable both times" and "an assertion failed both times"
    // deserve different answers. A prompt that hides the difference is asking
    // for a rubber stamp.
    const down = triageAction(
      attempt(2, [{ testId: "a", message: "connect ECONNREFUSED 127.0.0.1:3000" }]),
    );
    expect(down.notes.join(" ")).toMatch(/unreachable on both runs/);
    const broken = triageAction(
      attempt(2, [{ testId: "a", message: "AssertionError: expected 90 to equal 100" }]),
    );
    expect(broken.notes.join(" ")).toMatch(/same tests failed on both runs/);
  });

  it("never ends the run by itself", () => {
    // Every path returns notes. Whether a persistent failure is a defect is a
    // person's decision, put to them as an approval.
    const a = triageAction(
      attempt(2, [{ testId: "a", message: "connect ECONNREFUSED 127.0.0.1:3000" }]),
    );
    expect(Object.keys(a)).toEqual(["notes"]);
  });

  it("still names what is quarantined, so the agent stops rewriting it", () => {
    const a = triageAction(
      attempt(2, [{ testId: "a", message: "AssertionError: expected 90 to equal 100" }]),
    );
    expect(a.notes.join(" ")).toMatch(/do not edit, relax, skip or delete it/i);
  });

  it("says nothing when the only failure is an expected one", () => {
    const a = triageAction(attempt(2, [{ testId: "c", message: "known issue: xfail" }]));
    expect(a.notes).toEqual([]);
  });
});

describe("re-triaging an unchanged report", () => {
  function writeReport(ws: string, message: string): void {
    mkdirSync(join(ws, ".aqa-report"), { recursive: true });
    writeFileSync(
      reportPath(ws),
      JSON.stringify({
        suites: [
          {
            file: "a.spec.ts",
            specs: [{ title: "fails", ok: false, tests: [{ results: [{ error: { message } }] }] }],
          },
        ],
      }),
      "utf8",
    );
  }

  it("is a no-op, so a per-cycle call cannot flood the ledger", () => {
    // The loop asks for triage after every cycle and does not know which tool
    // writes a report. Without this the same evidence would be classified again
    // on every turn: duplicate events, a meaningless attempt counter, and a
    // quarantine check comparing a report against itself.
    const ws = workspace();
    writeReport(ws, "AssertionError: expected 90 to equal 100");
    return (async () => {
      const first = await runTriage({ events: [], workspaceDir: ws });
      expect(first?.attempt).toBe(1);
      expect(first?.reportFingerprint).toBeTruthy();
      const again = await runTriage({
        events: [triageEvent(1, first!)],
        workspaceDir: ws,
      });
      expect(again).toBeUndefined();
    })();
  });

  it("classifies again once the report actually changes", () => {
    const ws = workspace();
    writeReport(ws, "AssertionError: expected 90 to equal 100");
    return (async () => {
      const first = await runTriage({ events: [], workspaceDir: ws });
      writeReport(ws, "Error: connect ECONNREFUSED 127.0.0.1:3000");
      const second = await runTriage({
        events: [triageEvent(1, first!)],
        workspaceDir: ws,
      });
      expect(second?.attempt).toBe(2);
      expect(second?.reportFingerprint).not.toBe(first?.reportFingerprint);
      expect(second?.runLevel).toBe("environmental");
    })();
  });
});

describe("a stale report cannot pass as agreement", () => {
  it("reports how many triage events a run produced", () => {
    // Zero is itself a finding. The verifier compares this against the suite's
    // own failure count, because a stale green report on disk makes triage find
    // nothing and say nothing — and silence that looks like agreement is the
    // expensive kind. Observed: a report from four days earlier sat in the
    // workspace through three suite runs.
    expect(triageGaps([]).attempts).toBe(0);
    const one = triageGaps([
      triageEvent(1, attemptFrom(1, [{ testId: "a", message: "AssertionError: 1 != 2" }])),
    ]);
    expect(one.attempts).toBe(1);
  });
});

describe("a failure that reproduces is not a flake", () => {
  const flaky = {
    testId: "a",
    message: "Error: Timeout 5000ms exceeded waiting for locator('.banner')",
  };

  it("leaves a first-time flake alone", () => {
    // One ambiguous timeout is a defensible guess: retry and see.
    const first = attemptFrom(1, [flaky]);
    expect(first.verdicts[0]?.category).toBe("flake");
    const again = applyRepetition(first.verdicts, []);
    expect(again[0]?.category).toBe("flake");
  });

  it("re-classifies a flake that came back with identical evidence", () => {
    // "Flake" means it would pass if you ran it again. A failure that came back
    // the same way has falsified that claim by the definition of the word — and
    // no pattern bank can see it, because every bank reads one message alone.
    const first = attemptFrom(1, [flaky]);
    const second = attemptFrom(2, [flaky]);
    const adjusted = applyRepetition(second.verdicts, [first]);
    expect(adjusted[0]?.category).toBe("real-defect");
    // Low confidence on purpose: this is not a claim that the product is
    // broken, only that it has stopped being the agent's to fix by guessing.
    expect(adjusted[0]?.confidence).toBe(NO_SIGNATURE_CONFIDENCE);
    expect(adjusted[0]?.rationale).toMatch(/failed the same way 2 times/);
  });

  it("does not re-classify when the failure changed shape", () => {
    // Observed on run 20260918T161031Z-b0686ec0: the agent edited the spec and
    // the same test failed on a different assertion. That is a new failure, not
    // a reproduction, and the pattern banks get to judge it fresh.
    const first = attemptFrom(1, [flaky]);
    const second = attemptFrom(2, [
      { testId: "a", message: "Error: Timeout 5000ms exceeded waiting for locator('.total')" },
    ]);
    const adjusted = applyRepetition(second.verdicts, [first]);
    expect(adjusted[0]?.category).toBe("flake");
  });

  it("counts every earlier attempt, not just the previous one", () => {
    const a1 = attemptFrom(1, [flaky]);
    const a2 = attemptFrom(2, [flaky]);
    const a3 = attemptFrom(3, [flaky]);
    const adjusted = applyRepetition(a3.verdicts, [a1, a2]);
    expect(adjusted[0]?.rationale).toMatch(/failed the same way 3 times/);
  });

  it("does not touch categories other than flake", () => {
    // Repetition is only evidence against the ONE category that claims a re-run
    // would pass. An environmental failure repeating means the app is still down.
    const env = { testId: "b", message: "connect ECONNREFUSED 127.0.0.1:3000" };
    const first = attemptFrom(1, [env]);
    const second = attemptFrom(2, [env]);
    const adjusted = applyRepetition(second.verdicts, [first]);
    expect(adjusted[0]?.category).toBe("environmental");
  });
});

describe("a report from a previous run is not evidence about this one", () => {
  function reportIn(ws: string, message: string): void {
    mkdirSync(join(ws, ".aqa-report"), { recursive: true });
    writeFileSync(
      reportPath(ws),
      JSON.stringify({
        suites: [
          {
            file: "a.spec.ts",
            specs: [{ title: "fails", ok: false, tests: [{ results: [{ error: { message } }] }] }],
          },
        ],
      }),
      "utf8",
    );
  }

  function startEvent(timestamp: number): AnyRunEvent {
    return {
      tool: "agentic-qa",
      runId: "r",
      eventId: 1,
      timestamp,
      kind: "request",
      payload: { text: "t", skill: "s", configHash: "sha256:x" },
    };
  }

  it("ignores a report written before the run started", async () => {
    // What this pins: run 20260918T161822Z-427cd725 stopped on its FIRST cycle,
    // 13 events, having executed nothing. It read the report the PREVIOUS run
    // left in the workspace, quarantined a test it had never run, and ended.
    // The fingerprint check cannot catch this — it compares against this run's
    // ledger, which on cycle one is empty, so a stale file looks like new
    // evidence. The run's own start time is what tells them apart.
    const ws = workspace();
    reportIn(ws, "AssertionError: expected 90 to equal 100");
    const inTheFuture = Date.now() + 60_000;
    expect(
      await runTriage({ events: [startEvent(inTheFuture)], workspaceDir: ws }),
    ).toBeUndefined();
  });

  it("reads a report written after the run started", async () => {
    const ws = workspace();
    const started = Date.now() - 60_000;
    reportIn(ws, "AssertionError: expected 90 to equal 100");
    const t = await runTriage({ events: [startEvent(started)], workspaceDir: ws });
    expect(t?.verdicts[0]?.category).toBe("real-defect");
  });

  it("imposes no constraint when the ledger has no events yet", async () => {
    const ws = workspace();
    reportIn(ws, "AssertionError: expected 90 to equal 100");
    expect(await runTriage({ events: [], workspaceDir: ws })).toBeDefined();
  });
});

describe("quarantine drift is judged on the failure's identity", () => {
  it("does not call a test modified when only the printed output varied", async () => {
    const { signature } = await import("../src/triage/step.js");
    const runA = 'Error: [ { "id": "label", "impact": "critical", "nodes": [ … 7 nodes … ] } ]';
    const runB =
      'Error: [ { "id": "label", "impact": "critical", "nodes": [ … 9 nodes, different order … ] } ]';
    expect(signature(runA)).toBe(signature(runB));
  });

  it("still sees a different failure as different", async () => {
    const { signature } = await import("../src/triage/step.js");
    const label = 'Error: [ { "id": "label" } ]';
    const contrast = 'Error: [ { "id": "color-contrast" } ]';
    const url = "expect(page).toHaveURL(expected) failed";
    expect(signature(label)).not.toBe(signature(contrast));
    expect(signature(label)).not.toBe(signature(url));
  });
});

describe("a test broken by an edit in this run is the test's fault (20261019T155404Z)", () => {
  it("turns a real-defect verdict into a test fault when the test passed before the edit", async () => {
    const { applyEditRegression } = await import("../src/triage/step.js");
    const T = "AC-2b Choosing page 2 shows a different set of products";
    let id = 5000;
    const pair = (
      server: string,
      toolName: string,
      args: Record<string, unknown>,
      result: unknown,
    ) => {
      const c = ++id;
      return [
        {
          tool: "agentic-qa",
          runId: "r",
          timestamp: 1,
          eventId: c,
          kind: "call",
          payload: { server, toolName, args, startedAt: 0 },
        },
        {
          tool: "agentic-qa",
          runId: "r",
          timestamp: 1,
          eventId: ++id,
          kind: "observation",
          payload: { eventIdOfCall: c, ok: true, result, artefacts: [], durationMs: 1 },
        },
      ];
    };
    const events = [
      ...pair("pw", "run_tests", { spec: "s" }, { tests: [{ title: T, status: "passed" }] }),
      ...pair(
        "fs",
        "replace_in_file",
        { path: "tests/e.spec.ts", old: "a", new: "b" },
        { changedTests: [T] },
      ),
      ...pair("pw", "run_tests", { spec: "s" }, { tests: [{ title: T, status: "failed" }] }),
    ] as unknown as AnyRunEvent[];
    const [v] = applyEditRegression(
      [
        {
          test: `e.spec.ts › Product catalogue › ${T}`,
          category: "real-defect",
          confidence: 0.6,
          rationale: "x",
          evidence: "e",
        },
      ],
      events,
    );
    expect(v?.category).toBe("flake");
    expect(v?.rationale).toMatch(
      /^The test passed earlier in this run and fails only since it was edited/,
    );
  });
});

describe("an accessibility scan scoped to nothing is the test's fault (20261020T230547Z)", () => {
  it("matches the axe error as test code, not a defect", async () => {
    const { TEST_CODE_ERROR } = await import("../src/triage/patterns.js");
    const msg =
      "Error: frame.evaluate: Error: No elements found for include in page Context at validateContext";
    expect(TEST_CODE_ERROR.some((p) => p.re.test(msg))).toBe(true);
  });
});
