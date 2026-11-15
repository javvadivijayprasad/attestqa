import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { criteriaWording, rangesIn, rangeValuesOwed } from "../src/design/stated-ranges.js";
import { parseDesign } from "../src/design/test-design.js";
import { makeStoryRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A design that tests the limits of a number range is sent back until the
 * examples generator has been asked for that range.
 *
 * Toolshop story TOOL-34, authored twice (20261113T232806Z, 20261114T141230Z):
 * `synthdata.examples` was offered, the design had boundary-value items on
 * "A customer aged 18 to 74 can register", and the tool was never called.
 */
function ledgerOf(
  entries: Array<{ tool: string; args?: Record<string, unknown>; result?: unknown; ok?: boolean }>,
): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  let id = 0;
  const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
  for (const e of entries) {
    const callId = ++id;
    events.push({
      ...base,
      eventId: callId,
      kind: "call",
      payload: {
        server: e.tool.split(".")[0] as string,
        toolName: e.tool.slice(e.tool.indexOf(".") + 1),
        args: e.args ?? {},
        startedAt: 0,
      },
    } as AnyRunEvent);
    events.push({
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: e.ok ?? true,
        result: e.result ?? {},
        artefacts: [],
        durationMs: 1,
      },
    } as AnyRunEvent);
  }
  return events;
}

/** The story as the stage-1 digest printed it in 20261114T141230Z. */
const CONTEXT = {
  tool: "aqa.story_context",
  result: {
    text: [
      "STORY TOOL-34 [Story, To Do] Registration enforces the age and password limits",
      "Acceptance criteria:",
      "  AC-1: A customer aged 18 to 74 can register; a date of birth that makes the customer 17 is refused with a message saying the customer must be 18, and one that makes the customer 75 is refused with a message saying the customer must be younger than 75.",
      "  AC-2: A password of 8 characters that has an uppercase letter, a lowercase letter, a number and a symbol is accepted; the same password one character shorter is refused with a message giving the minimum of 8 characters.",
      "Description:",
      "  The limits are: the customer is at least 18 and younger than 75 on the day of registration.",
      "",
      "PARENT TOOL-3 [Epic] Customer account",
    ].join("\n"),
    facts: {
      acceptanceCriteria: ["AC-1", "AC-2"],
      bugs: [],
      tasks: [],
      story: { id: "TOOL-34", title: "Registration enforces the age and password limits" },
    },
  },
};

const item = (id: string, covers: string, technique: string, conditions: string) => ({
  id,
  covers,
  type: "functional",
  technique,
  conditions: [conditions],
  expected: "the registration is accepted",
  source: covers,
  rationale: "TOOL-34 states the age limits, so the registration form is tested at them",
});
/** The design of 20261114T141230Z, shortened to what the rule reads. */
const DESIGN = {
  items: [
    item("D16", "AC-1", "boundary-value-analysis", "Date of birth makes the customer exactly 18"),
    item("D17", "AC-1", "boundary-value-analysis", "Date of birth makes the customer 17"),
    item("D18", "AC-1", "boundary-value-analysis", "Date of birth makes the customer 75"),
    item("D19", "AC-2", "boundary-value-analysis", "Password is exactly 8 characters"),
  ],
};

const examples = (profile: string | undefined, ddl: string, ok = true) => ({
  tool: "synthdata.examples",
  args: { ddl, out: "data", ...(profile ? { profile } : {}) },
  ok,
});
const AGE = "CREATE TABLE r (id INT PRIMARY KEY, age INT NOT NULL CHECK (age BETWEEN 18 AND 74));";

describe("a stated number range and the examples generator", () => {
  const design = parseDesign(DESIGN);

  it("reads the criteria and their ranges, and leaves a text length alone", () => {
    const wording = criteriaWording(ledgerOf([CONTEXT]));
    expect([...wording.keys()]).toEqual(["AC-1", "AC-2"]);
    expect(rangesIn("AC-1", wording.get("AC-1") ?? "")).toEqual([
      { criterion: "AC-1", low: 18, high: 74, phrase: "18 to 74" },
    ]);
    expect(rangesIn("AC-2", wording.get("AC-2") ?? "")).toEqual([]);

    const r = (t: string) => rangesIn("AC-1", t).map((x) => `${x.low}..${x.high}`);
    expect(r("The quantity is between 1 and 99.")).toEqual(["1..99"]);
    expect(r("A discount of 5–50 percent is accepted")).toEqual(["5..50"]);
    expect(r("Ages 18-74 are accepted")).toEqual(["18..74"]);
    // Booker #176: lengths, which the tool refuses.
    expect(r("Phone must be between 11 and 21 characters.")).toEqual([]);
    expect(r("The subject has a length of 5 to 100")).toEqual([]);
    // Not ranges.
    expect(r("Registered on 2026-11-14, see AC-1 to AC-3 and version 2.3.0")).toEqual([]);
    expect(r("Pages 9 to 3")).toEqual([]);
  });

  it("names the items, the criterion and both profiles when the tool was not called", () => {
    const owed = rangeValuesOwed(design, ledgerOf([CONTEXT]));
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatch(/^D16, D17, D18: AC-1 states a number range \("18 to 74"\)/);
    expect(owed[0]).toContain('profile "edge" and "negative"');
    expect(owed[0]).toContain("BETWEEN 18 AND 74");
  });

  it("asks only for the profile still missing, and is satisfied by both", () => {
    const one = rangeValuesOwed(design, ledgerOf([CONTEXT, examples(undefined, AGE)]));
    expect(one[0]).toContain('with profile "negative". Call');
    expect(
      rangeValuesOwed(
        design,
        ledgerOf([CONTEXT, examples("edge", AGE), examples("negative", AGE)]),
      ),
    ).toEqual([]);
  });

  it("does not count a call for another range, and counts one that ran and failed", () => {
    const other = AGE.replace("18 AND 74", "18 AND 120");
    expect(
      rangeValuesOwed(
        design,
        ledgerOf([CONTEXT, examples("edge", other), examples("negative", other)]),
      ),
    ).toHaveLength(1);
    expect(
      rangeValuesOwed(
        design,
        ledgerOf([CONTEXT, examples("edge", AGE, false), examples("negative", AGE, false)]),
      ),
    ).toEqual([]);
  });

  it("asks nothing of a design with no value item on that criterion", () => {
    const d = parseDesign({
      items: [item("D16", "AC-1", "state-transition", "A customer registers"), DESIGN.items[3]],
    });
    expect(rangeValuesOwed(d, ledgerOf([CONTEXT]))).toEqual([]);
  });

  it("is a rule only where the tool is offered", () => {
    const events = ledgerOf([CONTEXT]);
    const call = { toolName: "aqa.test_design", args: DESIGN };
    const types = ["functional"] as const;
    const withTool = makeStoryRefusal({ testTypes: types, examplesOffered: true })(call, events);
    expect(withTool).toContain("synthdata.examples tool is offered");
    const without = makeStoryRefusal({ testTypes: types })(call, events) ?? "";
    expect(without).not.toContain("synthdata.examples");

    const asked = ledgerOf([CONTEXT, examples("edge", AGE), examples("negative", AGE)]);
    const after = makeStoryRefusal({ testTypes: types, examplesOffered: true })(call, asked) ?? "";
    expect(after).not.toContain("synthdata.examples");
  });
});

/** The two real authoring runs: the design each submitted is sent back today. */
for (const run of ["20261113T232806Z-3bfd5f43", "20261114T141230Z-3b1afc43"]) {
  const file = join(__dirname, "..", ".aqa", "runs", run, "events.jsonl");
  describe.skipIf(!existsSync(file))(`run ${run}, replayed`, () => {
    it("the design that was approved without a generated value is sent back", () => {
      const events = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AnyRunEvent);
      const at = events.findIndex(
        (e) => e.kind === "call" && (e.payload as { toolName?: string }).toolName === "test_design",
      );
      expect(at).toBeGreaterThan(0);
      const before = events.slice(0, at);
      const args = (events[at]?.payload as { args: Record<string, unknown> }).args;
      const owed = rangeValuesOwed(parseDesign(args), before);
      expect(owed).toHaveLength(1);
      expect(owed[0]).toContain('AC-1 states a number range ("18 to 74")');
    });
  });
}
