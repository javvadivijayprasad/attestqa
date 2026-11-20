import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_UNCHANGED_RERUNS, suiteChangedSinceLastFullRun } from "../src/runtime/rerun.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A test that fails for the first time in the re-run gets its own second look.
 *
 * Toolshop TOOL-9, 20261115T144048Z, the application just started. The first
 * run failed one test; the unchanged re-run passed it and failed two others.
 * Each of those passed when run alone, a full run was refused ("nothing in the
 * suite has changed"), and the story ended blocked on `suite-not-green`. Four
 * plain Playwright runs of the same suite then passed 13 of 13.
 */
const SPEC = "tests/epic-tool-1-product-catalogue.spec.ts";
const A = "AC-1 Home page lists products with name, price and image";
const B = "AC-1 Searching for a matching word shows only products whose names contain that word";
const C = "AC-accessibility Home page product list passes accessibility checks";

let n = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
function run(failing: string[], args: Record<string, unknown> = {}): AnyRunEvent[] {
  const id = ++n;
  return [
    {
      ...base,
      eventId: id,
      kind: "call",
      payload: { server: "pw", toolName: "run_tests", args: { spec: SPEC, ...args }, startedAt: 0 },
    },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: {
        eventIdOfCall: id,
        ok: true,
        result: { green: failing.length === 0, failures: failing.map((title) => ({ title })) },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}
function triage(attempt: number, failing: string[]): AnyRunEvent {
  return {
    ...base,
    eventId: ++n,
    kind: "triage",
    payload: {
      attempt,
      runLevel: null,
      quarantined: [],
      verdicts: failing.map((t) => ({
        test: `${SPEC} › Product catalogue › ${t}`,
        category: "flake",
      })),
    },
  } as unknown as AnyRunEvent;
}
function edit(): AnyRunEvent[] {
  const id = ++n;
  return [
    {
      ...base,
      eventId: id,
      kind: "call",
      payload: {
        server: "fs",
        toolName: "replace_in_file",
        args: { path: SPEC, old: "a", new: "b" },
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
        result: { replaced: 1 },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}
const fullRun = { toolName: "pw.run_tests", args: { spec: SPEC } };

describe("a first failure in the re-run", () => {
  it("is run once more unchanged, by the runtime and through the gate", () => {
    n = 0;
    const events = [...run([A]), triage(1, [A]), ...run([B, C]), triage(2, [B, C])];
    const state = suiteChangedSinceLastFullRun(events);
    expect(state.retryOwed).toBe(true);
    expect(state.newFailures).toHaveLength(2);
    expect(storyRefusal(fullRun, events)).toBeUndefined();
  });

  it("is not owed when the re-run failed the same tests", () => {
    n = 0;
    const events = [...run([A]), triage(1, [A]), ...run([A]), triage(2, [A])];
    const state = suiteChangedSinceLastFullRun(events);
    expect(state.retryOwed).toBe(false);
    expect(state.newFailures).toEqual([]);
    expect(storyRefusal(fullRun, events)).toContain("nothing in the suite has changed");
  });

  it("stops at the bound: a suite that fails a different test every time is not re-run for ever", () => {
    n = 0;
    expect(MAX_UNCHANGED_RERUNS).toBe(2);
    const events = [
      ...run([A]),
      triage(1, [A]),
      ...run([B]),
      triage(2, [B]),
      ...run([C]),
      triage(3, [C]),
    ];
    expect(suiteChangedSinceLastFullRun(events).retryOwed).toBe(false);
  });

  it("counts only runs of unchanged bytes against the bound", () => {
    n = 0;
    // The first failure, its re-run, an edit and the run after it: one
    // unchanged re-run so far, so a new failure in the latest run earns one.
    const events = [
      ...run([A]),
      triage(1, [A]),
      ...run([A]),
      triage(2, [A]),
      ...edit(),
      ...run([B]),
      triage(3, [B]),
    ];
    expect(suiteChangedSinceLastFullRun(events).retryOwed).toBe(true);
  });

  it("keeps the first failure's re-run as it was, and owes nothing once a file is written", () => {
    n = 0;
    const first = [...run([A]), triage(1, [A])];
    expect(suiteChangedSinceLastFullRun(first)).toMatchObject({ retryOwed: true, newFailures: [] });
    const written = [...first, ...run([B]), triage(2, [B]), ...edit()];
    const state = suiteChangedSinceLastFullRun(written);
    expect(state.retryOwed).toBe(false);
    expect(state.changed).toEqual([SPEC]);
    // A filtered run is not the suite.
    n = 0;
    const filtered = [...run([A]), triage(1, [A]), ...run([], { grep: "AC-1" })];
    expect(suiteChangedSinceLastFullRun(filtered).retryOwed).toBe(true);
  });
});

/** The real run; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261115T144048Z-beb7578f", "events.jsonl");
describe.skipIf(!existsSync(RUN))("run 20261115T144048Z, replayed", () => {
  it("owes a third run after the re-run failed two tests for the first time", () => {
    const all = readFileSync(RUN, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    const second = all.findIndex(
      (e) => e.kind === "triage" && (e.payload as { attempt?: number }).attempt === 2,
    );
    expect(second).toBeGreaterThan(0);
    const state = suiteChangedSinceLastFullRun(all.slice(0, second + 1));
    expect(state.retryOwed).toBe(true);
    expect(state.newFailures.map((t) => t.split(" › ").pop())).toEqual([C, B]);
  });
});
