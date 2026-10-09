import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTriage } from "../src/triage/step.js";
import { PwTools, extractJson } from "../src/mcp/adapters/pw.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A filtered run is a working step, not a result.
 *
 * 20260928T091417Z: the full suite quarantined two failing tests, the model then
 * ran ONE test with --grep, it passed, and triage — which reads Playwright's
 * report file, and a filtered run overwrites that file — announced "suite is
 * green, the earlier failures are gone" with both defects still red. The run
 * would have reported green and dropped its bugs, and the ledger would have
 * agreed with it.
 */

let id = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1000 };

function run(args: Record<string, unknown>, ok = true): AnyRunEvent[] {
  const callId = ++id;
  return [
    {
      ...base,
      eventId: callId,
      kind: "call",
      payload: { server: "pw", toolName: "run_tests", args, startedAt: 0 },
    },
    {
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok,
        result: { passed: 1, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}

/** A workspace holding a Playwright report that says one test passed. */
function greenReport(): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-filtered-"));
  mkdirSync(join(ws, ".aqa-report"), { recursive: true });
  writeFileSync(
    join(ws, ".aqa-report", "playwright.json"),
    JSON.stringify({
      stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
      suites: [
        {
          title: "s",
          specs: [
            {
              title: "Security — JWT token is absent from localStorage after logout",
              file: "tests/epic-42.spec.ts",
              tests: [{ status: "expected", results: [{ status: "passed", duration: 10 }] }],
            },
          ],
        },
      ],
    }),
  );
  return ws;
}

/** The same workspace, but the report says a test failed on an assertion. */
function redReport(): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-filtered-red-"));
  mkdirSync(join(ws, ".aqa-report"), { recursive: true });
  writeFileSync(
    join(ws, ".aqa-report", "playwright.json"),
    JSON.stringify({
      stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0 },
      suites: [
        {
          title: "s",
          specs: [
            {
              title: "Story-a — Signed-in user can log out via the account menu",
              file: "tests/epic-42.spec.ts",
              ok: false,
              tests: [
                {
                  status: "unexpected",
                  results: [
                    {
                      status: "failed",
                      duration: 10,
                      error: {
                        message:
                          'Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /login/\nReceived string: "http://localhost:3100/#/"',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  return ws;
}

describe("triage reads the whole suite or nothing", () => {
  it("does not triage a report left by a filtered run", async () => {
    const ws = greenReport();
    const events = [
      ...run({ spec: "tests/epic-42.spec.ts" }),
      ...run({ spec: "tests/epic-42.spec.ts", grep: "Security" }),
    ];
    expect(await runTriage({ events, workspaceDir: ws })).toBeUndefined();
  });

  it("does not triage it when the filtered run FAILED either — the file is still its", async () => {
    // A grep that matched nothing comes back as an error, and Playwright has
    // already overwritten the report. "The last run that worked was the full
    // suite" is not the same question as "is this file the full suite's".
    const ws = greenReport();
    const events = [
      ...run({ spec: "tests/epic-42.spec.ts" }),
      ...run({ spec: "tests/epic-42.spec.ts", grep: "story:44" }, false),
    ];
    expect(await runTriage({ events, workspaceDir: ws })).toBeUndefined();
  });

  it("triages a full run normally", async () => {
    const ws = redReport();
    const events = run({ spec: "tests/epic-42.spec.ts" });
    const t = await runTriage({ events, workspaceDir: ws });
    expect(t).toBeDefined();
    expect(t?.verdicts).toHaveLength(1);
  });

  it("treats every filtering argument the same way", async () => {
    const ws = greenReport();
    for (const filter of [
      { grep: "x" },
      { shard: "1/2" },
      { project: "chromium" },
      { lastFailed: true },
    ]) {
      const events = [...run({ spec: "s" }), ...run({ spec: "s", ...filter })];
      expect(await runTriage({ events, workspaceDir: ws })).toBeUndefined();
    }
  });
});

describe("a filter that matched nothing is an error, not a red suite", () => {
  const emptyReport = JSON.stringify({
    stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 },
    suites: [],
  });

  const tools = (stdout: string) =>
    new PwTools(mkdtempSync(join(tmpdir(), "aqa-pw-")), {
      runner: async () => ({ code: 0, stdout, stderr: "" }),
    });

  it("refuses to report 0 passed, 0 failed as a result", async () => {
    const r = await tools(emptyReport).call("pw", "run_tests", { grep: "story:44" });
    expect(r.ok).toBe(false);
    const message = JSON.stringify(r.result);
    expect(message).toContain("matched no tests");
    expect(message).toContain("TITLE");
    expect(message).toContain("list_tests");
  });

  it("reads the totals, not the per-test rows: a report can have stats and no detail", async () => {
    // A green filtered run whose report carries totals but no per-test list is
    // still a green filtered run.
    const statsOnly = JSON.stringify({
      stats: { expected: 4, unexpected: 0, skipped: 0 },
      suites: [],
    });
    const r = await tools(statsOnly).call("pw", "run_tests", { grep: "AC-1" });
    expect(r.ok).toBe(true);
  });

  it("says nothing about an unfiltered run that legitimately found no tests", async () => {
    // No filter and no tests is a project problem, not a mistaken grep, and the
    // summary already says so honestly: green is false.
    const r = await tools(emptyReport).call("pw", "run_tests", {});
    expect(r.ok).toBe(true);
  });
});

describe("the JSON report is found wherever it starts, and a stale file is never it", () => {
  const report = JSON.stringify({ stats: { expected: 2, unexpected: 0, skipped: 0 }, suites: [] });

  it("reads the reporter's JSON past a globalSetup log line", () => {
    const stdout =
      "[global-setup] test account *@example.test is not registered — registering it\n" +
      report +
      "\n";
    expect(extractJson(stdout)).toBeDefined();
    expect(JSON.parse(extractJson(stdout) as string).stats.expected).toBe(2);
  });

  it("still takes clean JSON as before", () => {
    expect(extractJson(report)).toBe(report);
  });

  it("returns nothing for output with no JSON object", () => {
    expect(extractJson("Error: something\nmore text")).toBeUndefined();
  });

  it("does not report a file left by an earlier run as this call's result", async () => {
    // 20261007T201833Z: stdout had a log line before the JSON, the adapter fell
    // back to the report file, and the file was the PREVIOUS run's last
    // filtered test. Fourteen tests ran; one stale 401 was reported.
    const ws = mkdtempSync(join(tmpdir(), "aqa-pw-stale-"));
    mkdirSync(join(ws, ".aqa-report"), { recursive: true });
    const stale = join(ws, ".aqa-report", "playwright.json");
    writeFileSync(
      stale,
      JSON.stringify({ stats: { expected: 0, unexpected: 1, skipped: 0 }, suites: [] }),
    );
    const old = Date.now() - 60_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(stale, old / 1000, old / 1000);

    const pw = new PwTools(ws, {
      runner: async () => ({ code: 1, stdout: "not json at all", stderr: "" }),
    });
    const r = await pw.call("pw", "run_tests", { spec: "tests/x.spec.ts" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.result)).toContain("predates this call");
  });
});
