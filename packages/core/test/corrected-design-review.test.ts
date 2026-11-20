import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changedAtSwitchOf, StoryToTestsVerifier } from "../src/verify/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * An item put back to what its test was written for is not "changed".
 *
 * Booker #176, 20261115T142723Z. The design approved first in that run gave
 * five items in looser words than the design of the earlier run ("refused with
 * a message giving the range" for the quoted message). The run switched routes
 * and recorded the five as changed. The verifier pointed the difference out,
 * the design was submitted again with the earlier wording and approved — and
 * the run still ended "5 for your review", each line comparing the earlier
 * design with one that was no longer in force.
 */
const item = (id: string, expected: string) => ({
  id,
  covers: "AC-1",
  type: "functional",
  technique: "boundary-value-analysis",
  conditions: ["Phone value length 10, 11, 21 and 22 characters"],
  expected,
  source: "AC-1",
});
const EXACT = 'refused with "Phone must be between 11 and 21 characters."';
const LOOSE = "refused with a message giving the range 11 to 21";

let n = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
const route = (because: Record<string, unknown>): AnyRunEvent =>
  ({
    ...base,
    eventId: ++n,
    kind: "route",
    payload: { path: "A2", reason: "", because },
  }) as unknown as AnyRunEvent;
function design(expected: string): AnyRunEvent[] {
  const id = ++n;
  return [
    {
      ...base,
      eventId: id,
      kind: "call",
      payload: {
        server: "aqa",
        toolName: "test_design",
        args: { items: [item("D5", expected)] },
        startedAt: 0,
      },
    },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: {
        eventIdOfCall: id,
        ok: true,
        result: { recorded: true },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}
const start = () => [
  route({ previousDesign: { runId: "earlier", args: { items: [item("D5", EXACT)] } } }),
  ...design(LOOSE),
  route({
    changed: [
      {
        id: "D5",
        scenario: "AC-1 Contact form phone length boundaries",
        body: "Given I am on the home page",
        test: "abc123def456",
        was: EXACT,
        now: LOOSE,
      },
    ],
  }),
];

describe("the items a route recorded as changed", () => {
  it("are the run's while the design that changed them is in force", () => {
    n = 0;
    expect(changedAtSwitchOf(start()).map((c) => c.id)).toEqual(["D5"]);
  });

  it("are no longer changed once a later design puts them back", () => {
    n = 0;
    expect(changedAtSwitchOf([...start(), ...design(EXACT)])).toEqual([]);
    // The same expectation in other punctuation and case is the same expectation.
    n = 0;
    expect(
      changedAtSwitchOf([
        ...start(),
        ...design('Refused with: "phone must be between 11 and 21 characters"'),
      ]),
    ).toEqual([]);
  });

  it("stay changed when the later design still differs", () => {
    n = 0;
    const events = [...start(), ...design("refused with a message naming the limits 11 and 21")];
    expect(changedAtSwitchOf(events).map((c) => c.id)).toEqual(["D5"]);
  });
});

/** The real run and the workspace it ran in; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261115T142723Z-da84bb0e", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "booker");
describe.skipIf(!existsSync(RUN) || !existsSync(WS))("run 20261115T142723Z, replayed", () => {
  it("ends with nothing for review about a design that was corrected", async () => {
    const events = readFileSync(RUN, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    // Four of the five were put back. D8's expected result was put back too,
    // but its conditions still state other values, so it stays — with the
    // wording of the design in force, not of the one it replaced.
    const left = changedAtSwitchOf(events);
    expect(left.map((c) => c.id)).toEqual(["D8"]);
    expect(left[0]?.now).toBe(left[0]?.was);
    const out = await new StoryToTestsVerifier({ workItem: "176", tracker: "ado" }).verify({
      events,
      workspaceDir: WS,
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("the approved design changed what this item expects");
    expect(text).not.toMatch(/D[5679]: the approved design/);
  });
});
