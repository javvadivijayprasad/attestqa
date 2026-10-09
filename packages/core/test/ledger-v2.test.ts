import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger, parseLedger } from "../src/ledger/ledger.js";
import { computeStats, renderMarkdown } from "../src/ledger/replay.js";

/**
 * Ledger 2.0 (attestqa 2.0.0).
 *
 * The rename changes what a new ledger says about itself, and adds three kinds
 * of event a person writes. It must not change how any old ledger reads: every
 * run in the Paper I corpus was written as "agentic-qa", and the paper's
 * numbers are counted from those files.
 */

// A frozen copy of the fixture as 1.x wrote it. The live fixture is a golden
// file of what THIS version writes, so it moved to "attestqa" with the rename;
// this copy stays as it was, so the 1.x read path is always tested.
const FIXTURE = join(process.cwd(), "test", "fixtures", "ledger-1x-agentic-qa.jsonl");
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const tmp = () => mkdtempSync(join(tmpdir(), "aqa-ledger2-"));

describe("ledger 2.0 envelope", () => {
  it("writes new ledgers as attestqa", () => {
    const l = new Ledger(tmp(), "run-v2");
    l.append("request", { text: "t", skill: "s", configHash: "h" }, 1);
    expect(JSON.parse(readFileSync(l.file, "utf8").trim()).tool).toBe("attestqa");
  });

  it("still reads a 1.x ledger written as agentic-qa, unchanged", () => {
    const events = parseLedger(readFileSync(FIXTURE, "utf8"), FIXTURE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.tool === "agentic-qa")).toBe(true);
  });

  it("reads a ledger that mixes both names, as a resumed 1.x run would", () => {
    const text =
      line({
        tool: "agentic-qa",
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "request",
        payload: { text: "t", skill: "s", configHash: "h" },
      }) +
      "\n" +
      line({
        tool: "attestqa",
        runId: "r",
        eventId: 2,
        timestamp: 2,
        kind: "end",
        payload: { status: "done", summary: "s", exitCode: 0 },
      }) +
      "\n";
    expect(parseLedger(text, "mixed").map((e) => e.tool)).toEqual(["agentic-qa", "attestqa"]);
  });

  it("still refuses any other tool name", () => {
    const text =
      line({
        tool: "something-else",
        runId: "r",
        eventId: 1,
        timestamp: 1,
        kind: "plan",
        payload: {},
      }) + "\n";
    expect(() => parseLedger(text, "x")).toThrow(/tool must be one of "attestqa", "agentic-qa"/);
  });

  it("resumes a 1.x ledger and keeps numbering, writing the new name from then on", () => {
    const root = tmp();
    const dir = join(root, "runs", "run-old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "events.jsonl"),
      line({
        tool: "agentic-qa",
        runId: "run-old",
        eventId: 1,
        timestamp: 1,
        kind: "request",
        payload: { text: "t", skill: "s", configHash: "h" },
      }) + "\n",
    );
    const l = new Ledger(root, "run-old");
    const e = l.append("end", { status: "done", summary: "s", exitCode: 0 }, 2);
    expect(e.eventId).toBe(2);
    expect(l.read().map((x) => x.tool)).toEqual(["agentic-qa", "attestqa"]);
  });
});

describe("events a person writes", () => {
  it("records a ruling, a user edit and an aborted run, and replays them", () => {
    const l = new Ledger(tmp(), "run-people");
    l.append("request", { text: "test story 44", skill: "story-to-tests", configHash: "h" }, 1);
    l.append(
      "ruling",
      {
        subject: { type: "ac", ref: "AB#44 AC-3" },
        decision: "stands as written",
        reason: "logout must land on the login page",
        author: "vijay",
        source: "ui",
      },
      2,
    );
    l.append(
      "user_edit",
      {
        path: "features/epic-42.feature",
        before: "a",
        after: "b",
        author: "vijay",
        reason: "clearer step",
      },
      3,
    );
    l.append("run_aborted", { reason: "worker exited", lastEventId: 3, exitCode: 1 }, 4);

    const events = l.read();
    expect(events.map((e) => e.kind)).toEqual(["request", "ruling", "user_edit", "run_aborted"]);
    const md = renderMarkdown(events);
    expect(md).toContain("Ruling by vijay on ac AB#44 AC-3: stands as written");
    expect(md).toContain("Edited by vijay: features/epic-42.feature — clearer step");
    expect(md).toContain("Run aborted after event 3: worker exited");
    // People's events are not refusals, calls or approvals: the counted
    // report must not move because a person ruled or edited.
    const stats = computeStats(events);
    expect(stats.refusals).toBe(0);
    expect(stats.calls).toBe(0);
    expect(stats.approvals).toBe(0);
    expect(stats.status).toBe("aborted");
  });
});
