import { describe, it, expect } from "vitest";
import { coverageOf, parseDesign, renderDesign } from "../src/design/test-design.js";

/**
 * S3: the design step must say what is ALREADY tested.
 *
 * Story #44's reviewer was shown five items as fresh work on every run while
 * the tests had been on disk since the day before ("Test are already writen
 * right why you think it wrighting agagin"). Approval is still required — the
 * design is this run's statement of what will be checked — but the reviewer
 * should be reading what is new.
 */
const FEATURE = [
  "Feature: Customer account access",
  "",
  "  @story:1 @ac:1 @design:D1",
  "  Scenario: AC-1 — signs in with correct credentials",
  "    Given I am on the login page",
  "",
  "  @story:44 @design:D9",
  "  Scenario: Story-a — logs out via the account menu",
  "    Given I am signed in",
  "",
  "  @story:44 @design:D10 @bug:50",
  "  Scenario: Story-b — the session token is removed after logout",
  "    Given I am signed in",
].join("\n");

const SPEC = [
  'test("Story-a — logs out via the account menu", async () => {});',
  'test("Story-b — the session token is removed after logout", async () => {});',
].join("\n");

const DESIGN = parseDesign({
  items: [
    {
      id: "D9",
      covers: "story",
      type: "functional",
      technique: "state-transition",
      conditions: ["clicks Logout"],
      expected: "the URL is /#/login",
      source: "story description",
    },
    {
      id: "D10",
      covers: "bug #50",
      type: "confirmation",
      technique: "state-transition",
      conditions: ["signs in, logs out"],
      expected: "the token is absent",
      source: "bug #50",
    },
    {
      id: "D14",
      covers: "story",
      type: "security",
      technique: "state-transition",
      conditions: ["logs out, inspects storage"],
      expected: "no JWT remains",
      source: "story description",
    },
  ],
});

describe("what the design already has tests for", () => {
  it("matches a bug item by its @bug tag and a story item by its @design tag", () => {
    const covered = coverageOf(DESIGN, { featureText: FEATURE, specText: SPEC, story: 44 });
    expect(covered.get("D10")?.how).toBe("bug");
    expect(covered.get("D9")?.how).toBe("design id");
    // D14 has no scenario: reported as new, which is the safe direction.
    expect(covered.has("D14")).toBe(false);
  });

  it("does not count another story's scenario", () => {
    const covered = coverageOf(
      parseDesign({
        items: [
          {
            id: "D1",
            covers: "AC-1",
            type: "functional",
            technique: "state-transition",
            conditions: ["x"],
            expected: "y",
            source: "AC-1",
          },
        ],
      }),
      { featureText: FEATURE, specText: SPEC, story: 44 },
    );
    expect(covered.size).toBe(0);
  });

  it("does not count a scenario with no test in the spec", () => {
    const covered = coverageOf(DESIGN, { featureText: FEATURE, specText: "", story: 44 });
    expect(covered.size).toBe(0);
  });

  it("says so in the approval text", () => {
    const covered = coverageOf(DESIGN, { featureText: FEATURE, specText: SPEC, story: 44 });
    const lines = renderDesign(DESIGN, { covered });
    expect(lines[0]).toContain("2 already covered, 1 new");
    expect(lines.join("\n")).toContain(
      'ALREADY TESTED by "Story-a — logs out via the account menu"',
    );
  });
});

describe("the reviewer sees the marks beside the items", () => {
  it("renders ALREADY TESTED in the approval, from the request", async () => {
    const { renderApproval } = await import("../src/runtime/render-approval.js");
    const { coverageOf } = await import("../src/design/test-design.js");
    const covered = coverageOf(DESIGN, { featureText: FEATURE, specText: SPEC, story: 44 });
    const text = renderApproval(
      [
        {
          toolName: "aqa.test_design",
          args: { items: DESIGN.items },
        } as never,
      ],
      { covered },
    );
    expect(text).toContain("2 already covered, 1 new");
    expect(text).toContain("ALREADY TESTED");
  });
});
