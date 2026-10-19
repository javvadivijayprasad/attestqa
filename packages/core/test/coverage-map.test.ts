import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageOfStory, renderCoverage } from "../src/design/coverage-map.js";
import { factsFrom, type StoryFacts } from "../src/design/test-design.js";

// Item 6 (docs/ENGINE_MAP.md §11): the design starts from what already covers
// the story, so a second run proposes only the gaps — or nothing.
const facts: StoryFacts = {
  acceptanceCriteria: [
    "AC-1: search shows matching products",
    "AC-2: pagination moves to page 2",
    "AC-3: sort by price",
  ],
  bugs: [{ id: "TOOL-9", state: "To Do", title: "price sort ignores decimals" }],
  tasks: [],
  story: { id: "TOOL-6", title: "Browse products" },
  epic: { id: "TOOL-1", title: "Catalogue" },
};

function workspace(feature?: string, spec?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aqa-cov-"));
  mkdirSync(join(dir, "features"));
  mkdirSync(join(dir, "tests"));
  if (feature) writeFileSync(join(dir, "features", "epic-tool-1-catalogue.feature"), feature);
  if (spec) writeFileSync(join(dir, "tests", "epic-tool-1-catalogue.spec.ts"), spec);
  return dir;
}

const FEATURE = `Feature: Catalogue

  @story:TOOL-6 @design:TD-1 @ac:1
  Scenario: Search shows matching products
    Given I am on the home page

  @story:TOOL-6 @design:TD-2 @ac:2
  Scenario: Pagination moves to page two
    Given I am on the home page

  @story:TOOL-5 @design:TD-1 @ac:3
  Scenario: Another story's sort
    Given I am on the home page
`;

const SPEC = `test("Search shows matching products", async () => {});\n`;

describe("coverageOfStory / renderCoverage", () => {
  it("says every item is new when the story has no scenarios", () => {
    const c = coverageOfStory(facts, workspace());
    expect(renderCoverage(c).join("\n")).toMatch(/EXISTING COVERAGE: none/);
  });

  it("lists covered criteria, the gaps, and scenarios with no script", () => {
    const c = coverageOfStory(facts, workspace(FEATURE, SPEC), ["functional", "accessibility"]);
    const text = renderCoverage(c).join("\n");
    expect(text).toMatch(/AC-1: TD-1 "Search shows matching products"(?! \(scenario only)/);
    expect(text).toMatch(
      /AC-2: TD-2 "Pagination moves to page two" \(scenario only — no script yet\)/,
    );
    // Another story's scenario does not count as coverage for this one.
    expect(text).toMatch(/AC-3: none/);
    expect(text).toMatch(/bug #TOOL-9 \[To Do\]: none/);
    expect(text).toMatch(/type accessibility: none/);
    expect(text).not.toMatch(/type functional/);
    expect(text).toMatch(
      /Propose new items only for what shows "none": AC-3, bug #TOOL-9 \[To Do\], type accessibility/,
    );
  });

  it("says no new test cases are required when nothing is missing", () => {
    const full = { ...facts, acceptanceCriteria: facts.acceptanceCriteria.slice(0, 2), bugs: [] };
    const text = renderCoverage(coverageOfStory(full, workspace(FEATURE, SPEC))).join("\n");
    expect(text).toMatch(/no new test cases are required/);
  });

  it("reads the digest's untyped facts", () => {
    const parsed = factsFrom(JSON.parse(JSON.stringify(facts)));
    expect(parsed?.story?.id).toBe("TOOL-6");
    expect(parsed?.acceptanceCriteria).toHaveLength(3);
    expect(factsFrom(undefined)).toBeUndefined();
  });
});
