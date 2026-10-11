import { describe, it, expect } from "vitest";
import { classifyFailure, triageRun } from "../src/triage/classify.js";
import { applyRepetition } from "../src/triage/step.js";
import { coverageOf, type TestDesign } from "../src/design/test-design.js";
import { liveLine } from "../src/cli.js";
import type { AnyRunEvent, TriagePayload } from "../src/types.js";

/**
 * Lessons from the first Jira runs against Juice Shop (SCRUM-8, 2026-10-11),
 * each pinned with the failure text the run actually produced.
 */

const HOOK_TIMEOUT = 'Test timeout of 30000ms exceeded while running "beforeEach" hook.';
const BAD_SELECTOR =
  'Error: locator.click: Unexpected token "" while parsing css selector "". Did you mean to CSS.escape it?';

describe("triage: failures that never reached the product", () => {
  it("calls a setup-hook failure environmental, not a flake that becomes a defect", () => {
    const v = classifyFailure({ testId: "AC-1: logout", message: HOOK_TIMEOUT });
    expect(v.category).toBe("environmental");
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
    expect(v.rationale).toMatch(/setup hook failed/i);
    // Every test failing in setup means nothing measured the product.
    const run = triageRun([
      { testId: "a", message: HOOK_TIMEOUT },
      { testId: "b", message: HOOK_TIMEOUT },
    ]);
    expect(run.runLevel).toBe("environmental");
  });

  it("calls an invalid selector the test's fault, and keeps it so when it repeats", () => {
    const v = classifyFailure({ testId: "AC-2: home page", message: BAD_SELECTOR });
    expect(v.category).toBe("flake");
    expect(v.rationale).toMatch(/^The test's own code is invalid/);
    const history = [{ verdicts: [v] } as unknown as TriagePayload];
    const [again] = applyRepetition([v], history);
    expect(again?.category).toBe("flake"); // not upgraded to real-defect
  });

  it("still upgrades an ordinary repeating timeout to a defect candidate", () => {
    const v = classifyFailure({
      testId: "t",
      message: "locator.click: Timeout 5000ms exceeded. waiting for locator('#x')",
    });
    expect(v.category).toBe("flake");
    const [again] = applyRepetition([v], [{ verdicts: [v] } as unknown as TriagePayload]);
    expect(again?.category).toBe("real-defect");
  });
});

describe("the live line says what triage actually knows", () => {
  const ev = (verdicts: unknown[]) =>
    ({ kind: "triage", payload: { verdicts } }) as unknown as AnyRunEvent;

  it("does not present a no-pattern default as a product defect", () => {
    const line = liveLine(ev([{ category: "real-defect", confidence: 0.1, rationale: "x" }]));
    expect(line).toMatch(/matched no known failure pattern/);
    expect(line).not.toMatch(/look like a product defect/);
  });

  it("keeps the product-defect wording for a real match, and names test-code faults", () => {
    const line = liveLine(
      ev([
        { category: "real-defect", confidence: 0.6, rationale: "assertion" },
        { category: "flake", confidence: 0.9, rationale: "The test's own code is invalid (…)" },
      ]),
    );
    expect(line).toMatch(/1 looks like a product defect/);
    expect(line).toMatch(/1 looks like the test's fault/);
  });
});

describe("coverage: same criterion, different type of test", () => {
  const feature = [
    "Feature: Customer account access",
    "  @story:SCRUM-8 @ac:1 @design:D1 @type:functional",
    "  Scenario: AC-1: Logout offers Login again",
    "    Given x",
  ].join("\n");
  const design = {
    items: [
      {
        id: "D1",
        covers: "AC-1",
        type: "functional",
        technique: "state-transition",
        conditions: [],
        expected: "",
        source: "AC-1",
      },
      {
        id: "D3",
        covers: "AC-1",
        type: "security",
        technique: "state-transition",
        conditions: [],
        expected: "",
        source: "task SCRUM-9",
      },
    ],
    excluded: [],
  } as unknown as TestDesign;

  it("does not report a security item as tested by a functional scenario", () => {
    const c = coverageOf(design, { featureText: feature, story: "SCRUM-8" });
    expect(c.get("D1")?.how).toBe("criterion");
    expect(c.has("D3")).toBe(false);
  });

  it("still matches when the scenario names no type at all", () => {
    const untyped = feature.replace(" @type:functional", "");
    const c = coverageOf(design, { featureText: untyped, story: "SCRUM-8" });
    expect(c.has("D3")).toBe(true);
  });
});
