import { describe, expect, it } from "vitest";
import { isReviewOnly, parseDesign, traceProblems } from "../src/design/test-design.js";
import { StageTracker } from "../src/runtime/stages.js";
import type { AnyRunEvent } from "../src/types.js";

// Decided 19 Oct 2026: a test that is broken or fake stops the run; a test that
// works but checks less, or more broadly, than its design gets one fix attempt
// and then goes to the reviewer.

const design = parseDesign({
  items: [
    {
      id: "D3",
      covers: "AC-3",
      type: "functional",
      technique: "state-transition",
      conditions: ["Page 2 is clicked"],
      expected: "page 2 is current; page 1 is not",
      source: "AC-3",
    },
    {
      id: "D4",
      covers: "story",
      type: "accessibility",
      technique: "checklist-based",
      conditions: ["product list"],
      expected: "no violations",
      source: "agent.test_types",
    },
  ],
});
const feature = [
  "Feature: x",
  "  @story:TOOL-6 @ac:3 @design:D3 @type:functional @technique:state-transition",
  "  Scenario: AC-3 current page",
  "    Given I am on the home page",
  "  @story:TOOL-6 @design:D4 @type:accessibility @technique:checklist-based",
  "  Scenario: AC-story axe",
  "    Given I am on the home page",
].join("\n");
const spec = (ac3: string) =>
  [
    "// @story:TOOL-6 @ac:3 @design:D3",
    `test("AC-3 current page", async ({ page }) => { ${ac3} });`,
    "// @story:TOOL-6 @design:D4",
    'test("AC-story axe", async ({ page }) => { const r = await new AxeBuilder({ page }).analyze(); expect(r.violations.map((v) => v.id)).toEqual([]); });',
  ].join("\n");

describe("broken stops the run; weaker goes to review", () => {
  it("files an unscoped scan as review-only and a transition with no action as blocking", () => {
    const t = traceProblems(
      design,
      [{ path: "f.feature", text: feature }],
      [{ path: "s.spec.ts", text: spec("await expect(page1).toBeVisible();") }],
      "TOOL-6",
    );
    expect(t.wrongShape.join(" ")).toContain("performs no action");
    expect(t.reviewShape.join(" ")).toContain("the scan is not scoped");
    expect(t.wrongShape.join(" ")).not.toContain("the scan is not scoped");
  });

  it("classifies the shape messages", () => {
    expect(isReviewOnly("the scan is not scoped — add .include(…)")).toBe(true);
    expect(isReviewOnly("the test catches its own failure and carries on")).toBe(false);
  });

  it("shows review items in the report under their own heading", () => {
    const t = new StageTracker();
    const ev = (eventId: number, kind: string, payload: Record<string, unknown>) =>
      ({
        tool: "attestqa",
        runId: "r",
        timestamp: 1,
        eventId,
        kind,
        payload,
      } as unknown as AnyRunEvent);
    t.line(ev(1, "request", { text: "Write tests for TOOL-6" }));
    t.line(
      ev(2, "verify", {
        done: true,
        gaps: [],
        limitations: ["for your review — D4 (story): the scan is not scoped"],
      }),
    );
    const text = t.line(ev(3, "end", { status: "done", summary: "ok" }));
    expect(text).toContain("Needs your review (1)");
    expect(text).toContain("D4 (story): the scan is not scoped");
  });
});

describe("one fix attempt, then the reviewer", () => {
  const verify = (items: string[]) =>
    ({
      tool: "attestqa",
      runId: "r",
      timestamp: 1,
      eventId: 9,
      kind: "verify",
      payload: {
        done: false,
        gaps: [{ code: "test-is-weaker-than-its-design", evidence: { items } }],
      },
    } as unknown as AnyRunEvent);

  it("asks the agent first, and sends it to review only once it has been asked", async () => {
    const { splitReviewItems } = await import("../src/verify/story-to-tests.js");
    const item = "D4 (story): the scan is not scoped";
    expect(splitReviewItems([item], [])).toEqual({ fresh: [item], forReview: [] });
    expect(splitReviewItems([item], [verify([item])])).toEqual({ fresh: [], forReview: [item] });
  });

  it("treats a new weakness found later as a fresh one", async () => {
    const { splitReviewItems } = await import("../src/verify/story-to-tests.js");
    const r = splitReviewItems(["a", "b"], [verify(["a"])]);
    expect(r).toEqual({ fresh: ["b"], forReview: ["a"] });
  });
});

describe("the reviewer reads one sentence, not the agent's instructions", () => {
  it("keeps the first sentence of a review item", async () => {
    const { forReviewer } = await import("../src/design/test-design.js");
    expect(
      forReviewer(
        'D4 (story): the scan is not scoped — add .include(<x>) so a violation elsewhere is not reported. .include takes a CSS selector (20261019T181040Z tried ".products").',
      ),
    ).toBe(
      "D4 (story): the scan is not scoped — add .include(<x>) so a violation elsewhere is not reported",
    );
  });
});
