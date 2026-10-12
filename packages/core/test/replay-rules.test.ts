import { describe, it, expect } from "vitest";
import { replayRules } from "../src/replay/rules.js";
import { storyToTestsSkill } from "../src/skills/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * `aqa check-rules`: a recorded run's proposals, re-judged by today's rules.
 * The SCRUM-8 runs of 2026-10-11/12 found one rule conflict per live run;
 * replaying them found the last one in seconds.
 */
describe("replaying a run through today's rules", () => {
  const base = { tool: "attestqa", runId: "r1", timestamp: 1 };
  let id = 0;
  const ev = (kind: string, payload: Record<string, unknown>) =>
    ({ ...base, eventId: ++id, kind, payload }) as unknown as AnyRunEvent;
  const read = (path: string) => {
    const callId = id + 2;
    return [
      ev("inference", { toolName: "fs.read_file", args: { path } }),
      ev("policy", { toolName: "fs.read_file", decision: "execute", reason: "read-only" }),
      {
        ...base,
        eventId: callId,
        kind: "call",
        payload: { server: "fs", toolName: "read_file", args: { path }, startedAt: 0 },
      } as unknown as AnyRunEvent,
      ev("observation", {
        eventIdOfCall: callId,
        ok: true,
        result: { content: "x" },
        artefacts: [],
        durationMs: 1,
      }),
    ];
  };

  it("reports a decision that differs today, with today's reason", () => {
    id = 0;
    const events = [
      ev("request", { text: "Write tests for SCRUM-8", skill: "story-to-tests", configHash: "x" }),
      ...read("features/a.feature"),
      ...read("features/a.feature"), // the run was allowed a second identical read
    ];
    const r = replayRules(events, storyToTestsSkill({ workItem: "SCRUM-8", tracker: "jira" }));
    expect(r.proposals).toBe(2);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0]).toMatchObject({
      toolName: "fs.read_file",
      then: "execute",
      now: "refused",
    });
    expect(r.changed[0]?.reason).toMatch(/already read/);
    expect(r.probe).toBeUndefined(); // not on the completion route: nothing to probe
  });
});
