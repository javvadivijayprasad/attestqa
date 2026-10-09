import { describe, it, expect } from "vitest";
import { triageRun } from "../src/triage/classify.js";

/**
 * A fixture that is not there is not a product defect.
 *
 * 20261007T191743Z: a fresh Juice Shop container with no users. Eight of story
 * 44's tests failed on the same first assertion — "Login endpoint returned 401 —
 * check that AQA_APP_USER/AQA_APP_PASS are correct for this environment (a 401
 * is a fixture problem, not a product defect)" — and triage read past the words
 * to the 401, which the real-defect bank claims. The run was about to post
 * "NOT green, 5 failed" to the story.
 *
 * The suite's message says what it is. Triage now believes it, and the whole
 * run is written off as environmental: nothing in it measured the product.
 */

const FIXTURE_401 =
  "Error: Login endpoint returned 401 — check that AQA_APP_USER/AQA_APP_PASS are correct for this " +
  "environment (a 401 is a fixture problem, not a product defect)\nExpected: 200\nReceived: 401";

const failure = (testId: string, message: string) => ({
  testId,
  message,
  durationMs: 9000,
  retries: 0,
});

describe("a missing test account writes the run off, not the product", () => {
  it("classifies the suite's own 'fixture problem' message as environmental", () => {
    const r = triageRun([failure("Story-a — logout", FIXTURE_401)]);
    expect(r.verdicts[0]?.category).toBe("environmental");
    expect(r.verdicts[0]?.matchedPatterns.length).toBeGreaterThan(0);
  });

  it("is contagious: every other verdict in the run is withdrawn", () => {
    const r = triageRun([
      failure("Story-a — logout", FIXTURE_401),
      failure("Story-c — protected route", FIXTURE_401),
      // A real assertion failure in the same run proves nothing either — the
      // product was never signed into.
      failure(
        "Security — error message identical",
        "Error: expect(locator).toBeVisible() failed\nExpected: visible\nReceived: hidden",
      ),
    ]);
    expect(r.runLevel).toBe("environmental");
    expect(r.quarantined).toEqual([]);
  });

  it("is not outscored by Playwright's own expect boilerplate", () => {
    // 20261007T201833Z: the same fixture message, wrapped in the standard
    // `expect(received).toBe(expected) // Object.is equality` text, matched
    // three real-defect patterns and won the tally. The declaration decides.
    const r = triageRun([
      failure(
        "Security — JWT token is absent",
        "Error: Login endpoint returned 401 — check that AQA_APP_USER/AQA_APP_PASS are correct for this " +
          "environment (a 401 is a fixture problem, not a product defect)\n\n" +
          "expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 401",
      ),
    ]);
    expect(r.verdicts[0]?.category).toBe("environmental");
    expect(r.runLevel).toBe("environmental");
  });

  it("recognises the precondition variant without the word 'fixture'", () => {
    const r = triageRun([
      failure(
        "Bug-48",
        "Error: Login endpoint returned 401 on second attempt — check credentials\nExpected: 200\nReceived: 401",
      ),
    ]);
    expect(r.verdicts[0]?.category).toBe("environmental");
  });

  it("recognises an unset credential", () => {
    const r = triageRun([failure("Story-a", "Error: AQA_APP_USER env var must be set")]);
    expect(r.verdicts[0]?.category).toBe("environmental");
  });

  it("still calls a genuine product 401 a product failure when the test says nothing about fixtures", () => {
    // A test that asserts the product returns 200 for a valid request and gets
    // a bare 401 Unauthorized is a product finding. The suite has to SAY it is
    // a fixture problem; triage does not assume it.
    const r = triageRun([
      failure(
        "API — profile is readable when signed in",
        "Error: expected 200, got 401 Unauthorized\nExpected: 200\nReceived: 401",
      ),
    ]);
    expect(r.verdicts[0]?.category).not.toBe("environmental");
  });
});
