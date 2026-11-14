import { describe, expect, it } from "vitest";
import { triageGaps } from "../src/triage/step.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A held test whose failure changed with nothing written.
 *
 * Run 20261114T133638Z: the first suite run failed an accessibility scan, which
 * was held as a defect candidate; the runtime ran the suite again unchanged
 * and the scan passed. The verifier blocked the run for "modifying" the test.
 */
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
let n = 0;
const call = (toolName: string, args: Record<string, unknown>): AnyRunEvent[] => {
  const id = ++n;
  const [server, name] = toolName.split(".") as [string, string];
  return [
    { ...base, eventId: id, kind: "call", payload: { server, toolName: name, args, startedAt: 0 } },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: { eventIdOfCall: id, ok: true, result: {}, artefacts: [], durationMs: 1 },
    },
  ] as AnyRunEvent[];
};
const verdict = (test: string, evidence: string) => ({
  test,
  category: "real-defect",
  confidence: 0.33,
  matchedPatterns: ["axe"],
  evidence,
  rationale: "",
});
const triage = (attempt: number, verdicts: unknown[], quarantined: string[]): AnyRunEvent =>
  ({
    ...base,
    eventId: ++n,
    kind: "triage",
    payload: { attempt, reportFingerprint: `f${attempt}`, runLevel: null, verdicts, quarantined },
  }) as unknown as AnyRunEvent;

const SCAN = "a.spec.ts › Catalogue › the scan";
const run = () => call("pw.run_tests", { spec: "tests/a.spec.ts" });
const held = () => triage(1, [verdict(SCAN, "axe violations: list")], [SCAN]);
const other = () => triage(2, [verdict("a.spec.ts › Catalogue › sorting", "not found")], []);

describe("a held test that stopped failing", () => {
  it("is an unstable test, not lost evidence, when the suite was re-run with nothing written", () => {
    const g = triageGaps([...run(), held(), ...run(), other()]);
    expect(g.gaps.map((x) => x.code)).not.toContain("quarantined-test-modified");
    expect(g.limitations.join("\n")).toMatch(
      /the scan — failed, was held as a defect candidate, and then passed when the suite was run again with nothing changed/,
    );
  });

  it("is still asked about when the spec was written in between", () => {
    const g = triageGaps([
      ...run(),
      held(),
      ...call("fs.replace_in_file", { path: "tests/a.spec.ts", old: "a", new: "b" }),
      ...run(),
      other(),
    ]);
    expect(g.gaps.map((x) => x.code)).toContain("quarantined-test-modified");
  });

  it("is still asked about when the ledger does not show two full runs", () => {
    const g = triageGaps([...run(), held(), other()]);
    expect(g.gaps.map((x) => x.code)).toContain("quarantined-test-modified");
  });
});
