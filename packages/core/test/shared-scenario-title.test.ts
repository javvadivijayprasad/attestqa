import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { specTests, storyCoverage, type Ledger } from "../src/report/coverage.js";
import { composeQaRecord } from "../src/report/qa-record.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Two stories, one scenario title.
 *
 * Toolshop's customer-account feature has "AC-accessibility The registration
 * page passes an automated accessibility scan" twice: once for TOOL-14 and
 * once for TOOL-34. The coverage read a scenario's design tags by its title,
 * so TOOL-34's item D19 got TOOL-14's tags, and its QA record said "not
 * written yet" on every run (20261115T130446Z, 20261115T145727Z) beside a test
 * that existed and ran.
 */
const SCAN = "AC-accessibility The registration page passes an automated accessibility scan";

const FEATURE = [
  "Feature: Customer account",
  "",
  "  @story:TOOL-14 @design:D7 @type:accessibility",
  `  Scenario: ${SCAN}`,
  "    Given I navigate to the registration page",
  "",
  "  @story:TOOL-34 @ac:1 @design:D16",
  "  Scenario Outline: AC-1 Registration enforces the customer age limits",
  "    Given I navigate to the registration page",
  "",
  "  @story:TOOL-34 @ac:1 @design:D19 @type:accessibility",
  `  Scenario: ${SCAN}`,
  "    Given I navigate to the registration page",
  "",
].join("\n");

const SPEC = [
  'test.describe("Customer account", () => {',
  "  // @story:TOOL-14",
  "  // @design:D7",
  `  test("${SCAN}", async ({ page }) => {});`,
  "",
  "  for (const example of ageLimitExamples) {",
  "    // @story:TOOL-34",
  "    // @design:D16",
  "    test(`AC-1 Registration enforces the customer age limits age ${example.age}`, async ({ page }) => {});",
  "  }",
  "",
  "  // @story:TOOL-34",
  "  // @design:D19",
  `  test("${SCAN}", async ({ page }) => {});`,
  "});",
  "",
].join("\n");

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
const item = (design: string, covers: string, type: string) => ({
  id: design,
  covers,
  type,
  technique: type === "accessibility" ? "checklist-based" : "boundary-value-analysis",
  conditions: ["the registration page"],
  expected: "as the story says",
  source: covers,
});
const ledger = (): Ledger => ({
  runId: "20261115T145727Z-d6aba4a1",
  events: [
    ...call(
      "aqa.story_context",
      {},
      {
        facts: {
          story: { id: "TOOL-34", title: "Registration enforces the age and password limits" },
          acceptanceCriteria: ["AC-1"],
          bugs: [],
          tasks: [],
        },
      },
    ),
    ...call(
      "aqa.test_design",
      { items: [item("D16", "AC-1", "functional"), item("D19", "story", "accessibility")] },
      { recorded: true },
    ),
  ],
});
const files = {
  features: [{ path: "features/epic-tool-3-customer-account.feature", text: FEATURE }],
  specs: [{ path: "tests/epic-tool-3-customer-account.spec.ts", text: SPEC }],
};

describe("two scenarios with one title", () => {
  it("reads each test with the tags above its own line", () => {
    expect(specTests(SPEC)).toEqual([
      { title: SCAN, stories: ["TOOL-14"], designs: ["D7"] },
      {
        title: "AC-1 Registration enforces the customer age limits age ${example.age}",
        stories: ["TOOL-34"],
        designs: ["D16"],
      },
      { title: SCAN, stories: ["TOOL-34"], designs: ["D19"] },
    ]);
  });

  it("gives each story's scenario its own design item", () => {
    const [story] = storyCoverage([ledger()], files, { story: "TOOL-34" });
    const d19 = story?.items.find((i) => i.id === "D19");
    expect(d19?.scenario?.title).toBe(SCAN);
    expect(d19?.test?.title).toBe(SCAN);
    expect(d19?.state).not.toBe("no scenario");
    expect(story?.outsideDesign).toEqual([]);

    const [other] = storyCoverage([ledger()], files, { story: "TOOL-14" });
    expect(other?.outsideDesign).toEqual([SCAN]);
  });

  it("says so in the QA record", () => {
    const record = composeQaRecord(ledger().events, {
      runId: ledger().runId,
      storyKey: "TOOL-34",
      files,
    });
    const text = JSON.stringify(record);
    expect(record).toBeDefined();
    expect(text).not.toContain("not written yet");
    expect(text).toContain("TOOL-34-D19");
  });
});

/** The real run and the workspace it ran in; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261115T145727Z-d6aba4a1", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "toolshop");
const F = join(WS, "features", "epic-tool-3-customer-account.feature");
const S = join(WS, "tests", "epic-tool-3-customer-account.spec.ts");
describe.skipIf(!existsSync(RUN) || !existsSync(F) || !existsSync(S))(
  "run 20261115T145727Z, replayed",
  () => {
    it("records TOOL-34-D19 with its scenario", () => {
      const events = readFileSync(RUN, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AnyRunEvent);
      const record = composeQaRecord(events, {
        runId: "20261115T145727Z-d6aba4a1",
        storyKey: "TOOL-34",
        files: {
          features: [
            {
              path: "features/epic-tool-3-customer-account.feature",
              text: readFileSync(F, "utf8"),
            },
          ],
          specs: [
            { path: "tests/epic-tool-3-customer-account.spec.ts", text: readFileSync(S, "utf8") },
          ],
        },
      });
      expect(JSON.stringify(record)).not.toContain("not written yet");
    });
  },
);
