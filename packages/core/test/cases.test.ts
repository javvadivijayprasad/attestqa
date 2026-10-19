import { describe, expect, it } from "vitest";
import { caseId, caseTally, designCases, existingCases, renderCases } from "../src/design/cases.js";
import { parseDesign } from "../src/design/test-design.js";
import { StageTracker } from "../src/runtime/stages.js";
import type { AnyRunEvent } from "../src/types.js";

// Item 8 (docs/ENGINE_MAP.md §11): each case has one id everywhere, and every
// run lists the cases with their state.

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  covers: "AC-1",
  type: "functional",
  technique: "equivalence-partitioning",
  conditions: ["valid user"],
  expected: "signed in",
  source: "AC-1",
  ...over,
});
const scenarios = [
  { design: "D1", scenario: "AC-1: signs in", tags: [], scripted: true },
  { design: "D2", scenario: "AC-2: shows an error", tags: [], scripted: false },
  { design: "D3", scenario: "AC-3: remembers me", tags: [], scripted: true },
];

describe("test-case ids and states", () => {
  it("names a case by story and design item", () => {
    expect(caseId("TOOL-6", "D3")).toBe("TOOL-6-D3");
    expect(caseId(12, "D1")).toBe("12-D1");
  });

  it("lists the cases on disk, scripted or not", () => {
    const c = existingCases("TOOL-6", scenarios);
    expect(c.map((x) => `${x.caseId} ${x.state}`)).toEqual([
      "TOOL-6-D1 exists",
      "TOOL-6-D2 exists (no script yet)",
      "TOOL-6-D3 exists",
    ]);
    expect(caseTally(c)).toBe("2 exists, 1 exists (no script yet)");
  });

  it("marks a design's items exists, no script yet, changed or new", () => {
    const design = parseDesign({
      items: [
        item("D1"),
        item("D2"),
        item("D3", { expected: "stays signed in after restart" }),
        item("D4"),
      ],
    });
    const previous = parseDesign({ items: [item("D1"), item("D2"), item("D3")] });
    const covered = new Map([
      ["D1", { scenario: "AC-1: signs in" }],
      ["D2", { scenario: "AC-2: shows an error" }],
      ["D3", { scenario: "AC-3: remembers me" }],
    ]);
    const c = designCases("TOOL-6", design, covered, scenarios, previous);
    expect(c.map((x) => x.state)).toEqual(["exists", "exists (no script yet)", "changed", "new"]);
    expect(renderCases(c)[3]).toMatch(/^ {2}TOOL-6-D4 +new +AC-1: signed in$/);
  });

  it("prints the case list when the run starts", () => {
    const route = {
      tool: "agentic-qa",
      runId: "r",
      timestamp: 1,
      eventId: 1,
      kind: "route",
      payload: {
        path: "B",
        reason: "",
        denied: [],
        because: { cases: existingCases("TOOL-6", scenarios) },
      },
    } as unknown as AnyRunEvent;
    const text = new StageTracker().line(route);
    expect(text).toContain("== Test cases: 3 existing (2 exists, 1 exists (no script yet))");
    expect(text).toMatch(/TOOL-6-D2 +exists \(no script yet\) +AC-2: shows an error/);
  });
});
