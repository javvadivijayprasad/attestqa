import { describe, it, expect } from "vitest";
import { renderCoverage, specTests, storyCoverage, type Ledger } from "../src/report/coverage.js";
import type { AnyRunEvent } from "../src/types.js";

let id = 0;
function call(toolName: string, args: Record<string, unknown>, result: unknown): AnyRunEvent[] {
  const callId = ++id;
  const [server, name] = toolName.split(".");
  return [
    { eventId: callId, kind: "call", payload: { server, toolName: name, args, startedAt: 0 } },
    {
      eventId: ++id,
      kind: "observation",
      payload: { eventIdOfCall: callId, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as unknown as AnyRunEvent[];
}

const FACTS = {
  facts: {
    story: { id: "SCRUM-8", title: "Customer signs out" },
    acceptanceCriteria: ["AC-1: Logout signs the customer out", "AC-2: Returns to home"],
    bugs: [{ id: "SCRUM-12", state: "In Progress", title: "Token accepted after logout" }],
    tasks: [],
  },
};

const item = (id: string, covers: string, extra: Record<string, unknown> = {}) => ({
  id,
  covers,
  type: "functional",
  technique: "state-transition",
  conditions: ["x"],
  expected: "y",
  source: covers,
  ...extra,
});

const FEATURE = [
  "@story:SCRUM-8 @design:D1",
  "Scenario: Logout signs out",
  "  Given x",
  "@story:SCRUM-8 @design:D2",
  "Scenario: Returns home",
  "  Given x",
  "@story:SCRUM-8 @bug:SCRUM-12 @design:D3",
  "Scenario: Token refused",
  "  Given x",
  "@story:SCRUM-8",
  "Scenario: Something nobody designed",
  "  Given x",
].join("\n");

const SPEC = [
  'test.describe("Account", () => {',
  "  // @story:SCRUM-8",
  "  // @design:D1",
  '  test("Logout signs out", async () => {});',
  "  // @story:SCRUM-8",
  "  // @bug:SCRUM-12",
  "  // @design:D3",
  '  test("Token refused", async () => {',
  '    test.fail(true, "Bug #SCRUM-12");',
  "  });",
  "});",
].join("\n");

function ledger(): Ledger {
  return {
    runId: "20261012T161004Z-786e4805",
    events: [
      ...call("aqa.story_context", {}, FACTS),
      ...call(
        "aqa.test_design",
        {
          items: [
            item("D1", "AC-1"),
            item("D2", "AC-2"),
            item("D3", "bug #SCRUM-12", { expectFail: true }),
          ],
        },
        { recorded: true },
      ),
      ...call(
        "pw.run_tests",
        { spec: "tests/a.spec.ts" },
        {
          passed: 2,
          failed: 0,
          tests: [
            { title: "Logout signs out", status: "passed" },
            { title: "Token refused", status: "expected-failure" },
          ],
        },
      ),
    ],
  };
}

describe("aqa coverage", () => {
  const files = {
    features: [{ path: "features/epic.feature", text: FEATURE }],
    specs: [{ path: "tests/a.spec.ts", text: SPEC }],
  };

  it("reads each test with the tags above it", () => {
    expect(specTests(SPEC)).toEqual([
      { title: "Logout signs out", stories: ["SCRUM-8"], designs: ["D1"] },
      { title: "Token refused", stories: ["SCRUM-8"], designs: ["D3"] },
    ]);
  });

  it("traces every approved item to its scenario, its test and its last result", () => {
    const [s] = storyCoverage([ledger()], files);
    expect(s?.story).toBe("SCRUM-8");
    expect(s?.designRun).toBe("20261012T161004Z-786e4805");
    expect(s?.items.map((i) => [i.id, i.state])).toEqual([
      ["D1", "passing"],
      ["D2", "no test"],
      ["D3", "known bug reproduced"],
    ]);
    // AC-2's only item has no test.
    expect(s?.uncoveredCriteria).toEqual(["AC-2"]);
    expect(s?.outsideDesign).toEqual(["Something nobody designed"]);
  });

  it("lists a story tagged on disk that no run has designed", () => {
    const other = {
      features: [{ path: "f.feature", text: "@story:SCRUM-6\nScenario: Sign in\n  Given x" }],
      specs: [],
    };
    const [s] = storyCoverage([], other);
    expect(s?.story).toBe("SCRUM-6");
    expect(s?.designRun).toBeUndefined();
    expect(renderCoverage([s!])).toMatch(/No approved test design is recorded/);
  });

  it("filters to one story", () => {
    expect(storyCoverage([ledger()], files, { story: "SCRUM-99" })).toEqual([]);
  });

  it("renders the gaps in bold", () => {
    const md = renderCoverage(storyCoverage([ledger()], files));
    expect(md).toMatch(/\| SCRUM-8 Customer signs out \| 3 \| 1 \| 1 \| 2 \|/);
    expect(md).toMatch(/\*\*no test\*\*/);
    expect(md).toMatch(/Acceptance criteria with no test:\*\* AC-2/);
  });
});
