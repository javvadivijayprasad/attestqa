import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storyToTestsSkill, waitingForNewTests } from "../src/skills/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Executing a suite is not a judgement. Once a design is approved and a spec
 * exists, the suite runs — so the runtime runs it, and the model spends its
 * turns on the things that need one. These tests are about WHEN.
 */
function ledgerOf(
  entries: Array<{ tool: string; args?: Record<string, unknown>; result?: unknown }>,
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
        ok: true,
        result: e.result ?? {},
        artefacts: [],
        durationMs: 1,
      },
    } as AnyRunEvent);
  }
  return events;
}

const SPEC = "tests/epic-42-customer-account-access.spec.ts";
const FEATURE = "features/epic-42-customer-account-access.feature";
const OTHER_STORY = [
  "Feature: Customer account access",
  "",
  "  @story:43 @design:D1 @type:functional",
  "  Scenario: Story-b signing in",
  "    Given I am on the sign-in page",
  "",
].join("\n");
const OWN_SCENARIO = [
  "  @story:44 @design:D9 @type:functional",
  "  Scenario: Story-a signing out ends the session",
  "    Given I am signed in",
  "",
].join("\n");
const OTHER_TEST = 'test("Story-b signing in", async () => {});\n';
const OWN_TEST = 'test("Story-a signing out ends the session", async () => {});\n';

/** The epic's files with story 44's test in them — or, `own: false`, only a neighbour's. */
function workspace(own = true): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-autorun-"));
  mkdirSync(join(ws, "tests"), { recursive: true });
  mkdirSync(join(ws, "features"), { recursive: true });
  writeFileSync(join(ws, FEATURE), OTHER_STORY + (own ? OWN_SCENARIO : ""));
  writeFileSync(join(ws, SPEC), OTHER_TEST + (own ? OWN_TEST : ""));
  return ws;
}

const CONTEXT = {
  tool: "aqa.story_context",
  result: {
    kind: "preflight",
    summary: {},
    text: "story 44",
    facts: {
      acceptanceCriteria: [],
      bugs: [],
      tasks: [],
      story: { id: 44, title: "Log out" },
      epic: { id: 42, title: "Customer account access" },
    },
  },
};

const DESIGN = {
  tool: "aqa.test_design",
  args: {
    items: [
      {
        id: "D9",
        covers: "story",
        type: "functional",
        technique: "state-transition",
        conditions: ["c"],
        expected: "e",
        source: "story description",
      },
    ],
  },
};

const RUN = (extra: Record<string, unknown> = {}) => ({
  tool: "pw.run_tests",
  args: { spec: SPEC, ...extra },
  result: { passed: 1, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] },
});

const skill = (ws: string) =>
  storyToTestsSkill({ workItem: "44", workspaceDir: ws, testTypes: ["functional"] });

describe("the runtime runs the suite, and says why", () => {
  it("runs once a design is approved and a spec exists", () => {
    const ws = workspace();
    const at = skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN]));
    expect(at?.toolName).toBe("pw.run_tests");
    expect(at?.args).toEqual({ spec: SPEC });
    expect(at?.why).toBe("nothing has run yet");
  });

  it("does not run before the design is approved", () => {
    const ws = workspace();
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT]))).toBeUndefined();
  });

  it("does not run again when nothing has changed", () => {
    const ws = workspace();
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN, RUN()]))).toBeUndefined();
  });

  it("runs again after the spec is edited, naming the file", () => {
    const ws = workspace();
    const at = skill(ws).autoRun?.(
      ledgerOf([
        CONTEXT,
        DESIGN,
        RUN(),
        {
          tool: "fs.replace_in_file",
          args: { path: SPEC, old: "a", new: "b" },
          result: { replaced: 1 },
        },
      ]),
    );
    expect(at?.why).toContain(SPEC);
    expect(at?.why).toContain("changed since the last full run");
  });

  it("ignores a filtered run — that is the healer checking one test", () => {
    const ws = workspace();
    // A grep run happened, but the full suite has not: the runtime still owes one.
    const at = skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN, RUN({ grep: "Story-a" })]));
    expect(at?.why).toBe("nothing has run yet");
  });

  it("does not run when there is no spec to run", () => {
    const ws = mkdtempSync(join(tmpdir(), "aqa-empty-"));
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN]))).toBeUndefined();
  });
});

/**
 * The suite's first run waits for the story's own tests.
 *
 * Booker #92, 20261116T145534Z: a new story in an epic file two other stories
 * already had tests in. The design was approved and the runtime ran the suite
 * at once — nine tests, none of them this story's — and again, because one
 * failed. The agent's next turn began with a suite that had run and held
 * contact-form tests (story 176's); it reported the story done without writing
 * anything, and the run ended blocked on `design-item-not-tested`.
 */
type Entry = Parameters<typeof ledgerOf>[0][number];
/**
 * A ledger with the agent's turns in it: an entry is a completed call, a number
 * is that many turns (one `context` event each), "done" is the agent ending a
 * turn with no call (a `verify` event). Built in one go so every event id is
 * its own.
 */
function seq(parts: Array<Entry | number | "done">): AnyRunEvent[] {
  const calls = ledgerOf(parts.filter((x): x is Entry => typeof x === "object"));
  const out: AnyRunEvent[] = [];
  const base = { tool: "agentic-qa", runId: "r", timestamp: 1 };
  let k = 0;
  let id = 1000;
  for (const part of parts) {
    if (typeof part === "object") {
      out.push(calls[2 * k] as AnyRunEvent, calls[2 * k + 1] as AnyRunEvent);
      k++;
    } else if (part === "done") {
      out.push({
        ...base,
        eventId: ++id,
        kind: "verify",
        payload: { done: false, gaps: [{ code: "design-item-not-tested", message: "" }] },
      } as unknown as AnyRunEvent);
    } else {
      for (let i = 0; i < part; i++)
        out.push({
          ...base,
          eventId: ++id,
          kind: "context",
          payload: { sections: [] },
        } as unknown as AnyRunEvent);
    }
  }
  return out;
}
const WRITE = (path: string) => ({
  tool: "fs.replace_in_file",
  args: { path, old: "a", new: "b" },
  result: { replaced: 1 },
});

describe("the first run waits for the story's own tests", () => {
  it("does not run a suite that has none of the story's tests yet", () => {
    const ws = workspace(false);
    expect(skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN]))).toBeUndefined();
    // Still waiting while the agent is writing them.
    expect(skill(ws).autoRun?.(seq([CONTEXT, DESIGN, 3, WRITE(FEATURE)]))).toBeUndefined();
  });

  it("runs once the approved items have their tests", () => {
    const ws = workspace(false);
    const events = seq([CONTEXT, DESIGN, 2]);
    expect(skill(ws).autoRun?.(events)).toBeUndefined();
    writeFileSync(join(ws, FEATURE), OTHER_STORY + OWN_SCENARIO);
    // A scenario without a test is not a test.
    expect(skill(ws).autoRun?.(events)).toBeUndefined();
    writeFileSync(join(ws, SPEC), OTHER_TEST + OWN_TEST);
    expect(skill(ws).autoRun?.(events)?.why).toBe("nothing has run yet");
  });

  it("is not a count of turns: reading the page to write the spec is the work", () => {
    // Booker #93, 20261116T155959Z: the feature at the fifth turn, then six
    // turns of exploring before the spec. A first version ran the suite there.
    const ws = workspace(false);
    const exploring = seq([CONTEXT, DESIGN, 5, WRITE(FEATURE), 30]);
    expect(skill(ws).autoRun?.(exploring)).toBeUndefined();
  });

  it("runs when the agent says it has finished and the tests are still not there", () => {
    const ws = workspace(false);
    const stopped = seq([CONTEXT, DESIGN, 1, "done"]);
    expect(skill(ws).autoRun?.(stopped)?.why).toBe("nothing has run yet");
    // What it said before the design was approved is about an earlier design.
    const earlier = seq([CONTEXT, "done", DESIGN, 1]);
    expect(skill(ws).autoRun?.(earlier)).toBeUndefined();
  });

  it("is only about the first run: after it, a change is run as before", () => {
    const ws = workspace(false);
    const at = skill(ws).autoRun?.(ledgerOf([CONTEXT, DESIGN, RUN(), WRITE(SPEC)]));
    expect(at?.why).toContain("changed since the last full run");
  });

  it("waits for nothing when every item has a test, or there is no design", () => {
    expect(waitingForNewTests(ledgerOf([CONTEXT, DESIGN]), [])).toBe(false);
    expect(waitingForNewTests([], ["D9"])).toBe(true);
    const noDesign = storyToTestsSkill({ workItem: "44", workspaceDir: workspace(false) });
    expect(noDesign.autoRun?.(ledgerOf([CONTEXT]))?.why).toBe("nothing has run yet");
  });
});

/** The real runs; local, not committed. */
const real = (run: string): { file: string; events: AnyRunEvent[] } => {
  const file = join(__dirname, "..", ".aqa", "runs", run, "events.jsonl");
  return {
    file,
    events: existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as AnyRunEvent)
      : [],
  };
};
const isCall = (e: AnyRunEvent, name: string): boolean =>
  e.kind === "call" && (e.payload as { toolName: string }).toolName === name;

const R92 = real("20261116T145534Z-c91258e7");
describe.skipIf(!existsSync(R92.file))("run 20261116T145534Z (Booker #92), replayed", () => {
  const all = R92.events;
  const UNTESTED = ["D10", "D11", "D12", "D13"];
  const firstRun = all.findIndex((e) => isCall(e, "run_tests"));

  it("would have waited where the runtime ran the neighbours' tests", () => {
    expect(firstRun).toBeGreaterThan(0);
    expect(waitingForNewTests(all.slice(0, firstRun), UNTESTED)).toBe(true);
    // Both runs came before the agent had a single turn after the design.
    const design = all.map((e) => isCall(e, "test_design")).lastIndexOf(true);
    expect(all.slice(design, firstRun).filter((e) => e.kind === "context")).toEqual([]);
  });

  it("stops waiting when the agent reports the story done with nothing written", () => {
    const said = all.findIndex((e) => e.kind === "verify");
    expect(said).toBeGreaterThan(firstRun);
    expect(waitingForNewTests(all.slice(0, said), UNTESTED)).toBe(true);
    expect(waitingForNewTests(all.slice(0, said + 1), UNTESTED)).toBe(false);
  });
});

const R93 = real("20261116T155959Z-5e2639ff");
describe.skipIf(!existsSync(R93.file))("run 20261116T155959Z (Booker #93), replayed", () => {
  it("keeps waiting through the turns the agent spent exploring the page", () => {
    const all = R93.events;
    // The run was stopped where the six-turn version asked to run the suite.
    const asked = all.map((e) => e.kind === "approval_requested").lastIndexOf(true);
    expect(asked).toBeGreaterThan(0);
    const design = all.map((e) => isCall(e, "test_design")).lastIndexOf(true);
    expect(
      all.slice(design, asked).filter((e) => e.kind === "context").length,
    ).toBeGreaterThanOrEqual(6);
    expect(waitingForNewTests(all.slice(0, asked - 1), ["D14", "D15", "D16", "D17", "D18"])).toBe(
      true,
    );
  });
});
