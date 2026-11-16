import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contradictedPassClaims } from "../src/triage/settle.js";

/**
 * A bug that says another case passed is held to it.
 *
 * Toolshop TOOL-34, 20261115T124325Z. The application was answering slowly and
 * no registration went through: the accepted cases (age 18, an 8-character
 * password) failed beside the refused ones. Two bugs were proposed for the
 * refused cases, and each rested on "the companion accepted case passed". A
 * person reading the approval had to notice that from the list of failing
 * tests; nothing in the runtime compared the two.
 */
const FAILING = [
  "AC-1 Registration enforces the customer age limits age 17",
  "AC-1 Registration enforces the customer age limits age 18",
  "AC-1 Registration enforces the customer age limits age 75",
  "AC-2 Registration enforces the password minimum length password 8 characters",
  "AC-accessibility The registration page passes an automated accessibility scan",
];

const AGE_BUG = [
  "EXPECTED: Registration is refused with a message saying the customer must be 18 (AC-1).",
  "",
  "What was ruled out:",
  "- The application was reachable: the failure snapshot shows the registration page and its form content.",
  "- The same test helper and form data shape produced passing accepted boundary cases for ages 18 and 74, so the registration form can be completed and submitted with these fields.",
  "- The failure reproduced on the unchanged re-run before any edits.",
  "",
  "Confidence: high, because the precondition page was loaded, companion accepted boundary cases passed, and the specified AC-1 message was missing after submitting the 17-year-old boundary case on two unchanged runs.",
].join("\n");
const AGE_TITLE =
  "AC-1: Registration does not show the required minimum age message for a 17-year-old customer";

const PASSWORD_BUG =
  "What was ruled out:\n- The application was reachable and the registration page loaded.\n" +
  "Confidence: high, because the expected rejection and message are stated by AC-2, the valid " +
  "8-character companion case passed, and the invalid boundary case reproduced on two unchanged full-suite runs.";

describe("a bug that says another case passed", () => {
  it("is contradicted when that case failed in the final run", () => {
    const age = contradictedPassClaims(AGE_BUG, FAILING, AGE_TITLE);
    expect(age).toHaveLength(1);
    expect(age[0]?.test).toBe("AC-1 Registration enforces the customer age limits age 18");
    expect(age[0]?.sentence).toContain("passing accepted boundary cases for ages 18 and 74");

    const password = contradictedPassClaims(
      PASSWORD_BUG,
      FAILING,
      "AC-2: no minimum length message",
    );
    expect(password.map((c) => c.test)).toEqual([
      "AC-2 Registration enforces the password minimum length password 8 characters",
    ]);
  });

  it("is left alone when the cases it names did pass", () => {
    // Age 18 and 74 passed; only the refused cases are failing.
    const failing = FAILING.filter((t) => !/age 18|8 characters/.test(t));
    expect(contradictedPassClaims(AGE_BUG, failing, AGE_TITLE)).toEqual([]);
    expect(contradictedPassClaims(PASSWORD_BUG, failing, "AC-2: no message")).toEqual([]);
  });

  it("reads nothing into a sentence that names no case, or that says a case did not pass", () => {
    const say = (s: string) => contradictedPassClaims(s, FAILING, AGE_TITLE);
    expect(say("The failure reproduced on the unchanged re-run before any edits.")).toEqual([]);
    expect(say("The other tests in the suite passed.")).toEqual([]);
    expect(say("The accepted case for age 18 did not pass either.")).toEqual([]);
    expect(say("The valid case for age 18 failed to pass as well.")).toEqual([]);
    // The bug's own case is supposed to be failing.
    expect(
      say("The 17-year-old case is the only one that is not accepted; valid ones passed."),
    ).toEqual([]);
    expect(contradictedPassClaims("", FAILING)).toEqual([]);
    expect(contradictedPassClaims(AGE_BUG, [])).toEqual([]);
  });

  it("ties a sentence to a test with no number in its title by its words", () => {
    const failing = ["AC-3 Clearing the search restores the full product list"];
    expect(
      contradictedPassClaims(
        "The companion test that clearing the search restores the product list passed.",
        failing,
      ),
    ).toHaveLength(1);
    expect(contradictedPassClaims("The other search tests passed.", failing)).toEqual([]);
  });
});

/** The approval the run put to a person; local, not committed. */
const APPROVAL = join(
  __dirname,
  "..",
  ".aqa",
  "runs",
  "20261115T124325Z-0f4541c8",
  "approvals",
  "apr-0002.json",
);
describe.skipIf(!existsSync(APPROVAL))("run 20261115T124325Z, its two bugs", () => {
  it("are both contradicted by the run's own failing tests", () => {
    const a = JSON.parse(readFileSync(APPROVAL, "utf8")) as {
      note: string;
      calls: Array<{ args: { summary: string; description: string } }>;
    };
    const failing = a.note
      .split("\n")
      .filter((l) => l.startsWith("  - "))
      .map((l) => l.slice(4));
    expect(a.calls).toHaveLength(2);
    for (const c of a.calls)
      expect(
        contradictedPassClaims(c.args.description, failing, c.args.summary).length,
        c.args.summary,
      ).toBeGreaterThan(0);
  });
});
