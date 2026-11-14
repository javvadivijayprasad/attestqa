import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { traceProblems } from "../src/design/test-design.js";
import { bugIsAbout, settleBugs } from "../src/triage/settle.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

type ProposedCall = Parameters<typeof settleBugs>[0][number];

/**
 * Whose scenario, whose test, whose bug — in a spec several stories share.
 *
 * Run 20261114T141230Z (TOOL-34, Jira). The run wrote its tests, found two
 * real defects, and ended blocked on three misattributions: another story's
 * scenario of the same title was read as its own; a bug labelled "AC-1" could
 * not be told from a second bug labelled "AC-1" about a different test, so a
 * real defect was dropped; and the red-suite gap told it to finish another
 * story's TODO tests.
 */

const SCAN = "AC-accessibility The registration page passes an automated accessibility scan";
const FEATURE = [
  "Feature: Customer account",
  "",
  "  @story:TOOL-14 @ac:1 @design:D10 @type:accessibility",
  `  Scenario: ${SCAN}`,
  "    Given I navigate to the registration page",
  "",
  "  @story:TOOL-34 @ac:1 @design:D21 @type:accessibility",
  `  Scenario: ${SCAN}`,
  "    Given I navigate to the registration page",
  "",
].join("\n");

describe("two stories with a scenario of the same title", () => {
  const design = {
    items: [{ id: "D21", covers: "story", type: "accessibility" }],
  } as unknown as Parameters<typeof traceProblems>[0];
  const features = [{ path: "features/epic.feature", text: FEATURE }];

  it("are each read with their own story and design tags", () => {
    expect(traceProblems(design, features, [], "TOOL-34").untagged).toEqual([]);
    expect(traceProblems(design, features, [], "TOOL-34").untested).toEqual([]);
  });

  it("still reports the other story's scenario when that story is the run's", () => {
    // D10 is not in this design: for TOOL-14 it is a scenario outside it.
    expect(traceProblems(design, features, [], "TOOL-14").untagged).toHaveLength(1);
  });
});

const AGE_18 = "AC-1a A customer aged 18 to 74 can register";
const AGE_75 =
  "AC-1c A customer aged 75 is refused with a message saying the customer must be younger than 75";
const BUG_18 = "AC-1: Customer aged exactly 18 is not accepted during registration";
const BUG_75 =
  "AC-1: Customer aged exactly 75 is accepted instead of refused with younger-than-75 message";

describe("a bug labelled with a criterion that has several failing tests", () => {
  const failing = [AGE_18, AGE_75];

  it("is about the test its title describes", () => {
    expect(bugIsAbout(BUG_18, AGE_18, failing)).toBe(true);
    expect(bugIsAbout(BUG_18, AGE_75, failing)).toBe(false);
    expect(bugIsAbout(BUG_75, AGE_75, failing)).toBe(true);
    expect(bugIsAbout(BUG_75, AGE_18, failing)).toBe(false);
  });

  it("is about the only failing test of that criterion, sub-label or not", () => {
    expect(bugIsAbout("AC-1: registration fails", AGE_18, [AGE_18, "AC-2 something else"])).toBe(
      true,
    );
  });

  it("is not told apart when the title describes neither better", () => {
    // Both stay under the criterion, as before: one bug for it.
    expect(bugIsAbout("AC-1: it is broken", AGE_18, failing)).toBe(false);
    expect(bugIsAbout("AC-1: it is broken", AGE_75, failing)).toBe(false);
  });
});

/** The real ledger and workspace; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261114T141230Z-3b1afc43", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "toolshop");
describe.skipIf(!existsSync(RUN) || !existsSync(WS))("run 20261114T141230Z, replayed", () => {
  const all = (): AnyRunEvent[] =>
    readFileSync(RUN, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
  const lastVerify = (events: AnyRunEvent[]) =>
    [...events].reverse().find((e) => e.kind === "verify");

  it("keeps the bug about the 75-year-old beside the one about the 18-year-old", () => {
    const events = all();
    const bugs: ProposedCall[] = events
      .filter((e) => e.kind === "inference")
      .map((e) => e.payload as { toolName?: string | null; args?: Record<string, unknown> })
      .filter((p) => p.toolName === "jira.create_bug")
      .map((p) => ({ toolName: "jira.create_bug", args: p.args ?? {} }));
    expect(bugs).toHaveLength(3);
    const upTo = events.filter((e) => e.eventId <= (lastVerify(events)?.eventId ?? 0));
    const s = settleBugs(bugs, upTo, { workItem: "TOOL-34", runLevel: null, workspaceDir: WS });
    expect(s.drop.map((d) => d.reason)).toEqual([]);
    expect(s.keep).toHaveLength(3);
  });

  it("does not answer for TOOL-14's scenario or TOOL-13's unfinished tests", async () => {
    const events = all();
    const out = await new StoryToTestsVerifier({ workItem: "TOOL-34", tracker: "jira" }).verify({
      events: events.filter((e) => e.eventId < (lastVerify(events)?.eventId ?? 0)),
      workspaceDir: WS,
    });
    expect(out.gaps.map((g) => g.code)).not.toContain("scenario-not-in-design");
    expect(JSON.stringify(out.gaps.map((g) => g.message))).not.toContain(
      "AC-2b The error message does not reveal",
    );
  });
});

describe("a ranged read that covers the whole file", () => {
  it("is a full view, and a real fragment is not", async () => {
    const { isPartialRead } = await import("../src/design/test-design.js");
    const whole = { path: "a", lines: 198, fromLine: 1, toLine: 198, content: "x" };
    expect(isPartialRead({ fromLine: 1, toLine: 220 }, whole)).toBe(false);
    expect(isPartialRead({ fromLine: 1, toLine: 260 }, { ...whole, lines: 335, toLine: 260 })).toBe(
      true,
    );
    expect(
      isPartialRead({ fromLine: 261 }, { ...whole, lines: 335, fromLine: 261, toLine: 335 }),
    ).toBe(true);
    expect(isPartialRead({}, { path: "a", lines: 10, content: "x" })).toBe(false);
    // Nothing to judge by: a range asked for is a fragment, as before.
    expect(isPartialRead({ fromLine: 1, toLine: 5 }, {})).toBe(true);
  });
});

/** The run after it: same story, executed again, two of its bugs already filed. */
const RUN2 = join(__dirname, "..", ".aqa", "runs", "20261114T144930Z-e27492a4", "events.jsonl");
describe.skipIf(!existsSync(RUN2) || !existsSync(WS))("run 20261114T144930Z, replayed", () => {
  it("counts a failing test as reported when a bug linked to the story is about it", async () => {
    const events = readFileSync(RUN2, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    // What Stage 1 records since this fix: which open bugs the story links.
    for (const e of events) {
      const facts = (
        e.payload as { result?: { facts?: { filedBugs?: Array<Record<string, unknown>> } } }
      ).result?.facts;
      for (const b of facts?.filedBugs ?? [])
        if (b["id"] === "TOOL-36" || b["id"] === "TOOL-37") b["linked"] = true;
    }
    const last = [...events].reverse().find((e) => e.kind === "verify");
    const out = await new StoryToTestsVerifier({ workItem: "TOOL-34", tracker: "jira" }).verify({
      events: events.filter((e) => e.eventId < (last?.eventId ?? 0)),
      workspaceDir: WS,
    });
    const said = (out.limitations ?? []).join("\n");
    expect(said).toMatch(/"AC-1a A customer aged 18 to 74 can register" fails, and bug #TOOL-36/);
    expect(said).toMatch(/accessibility scan" fails, and bug #TOOL-37/);
    // The 75-year-old has no bug yet: that one is still the run's to report.
    const red = out.gaps.find((g) => g.code === "suite-not-green");
    expect(red?.message).toContain("AC-1c A customer aged 75");
  });

  it("does not count a bug the story does not link", async () => {
    const events = readFileSync(RUN2, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    const last = [...events].reverse().find((e) => e.kind === "verify");
    const out = await new StoryToTestsVerifier({ workItem: "TOOL-34", tracker: "jira" }).verify({
      events: events.filter((e) => e.eventId < (last?.eventId ?? 0)),
      workspaceDir: WS,
    });
    expect((out.limitations ?? []).join("\n")).not.toMatch(/bug #TOOL-3[67]/);
  });
});
