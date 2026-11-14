import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storyRefusal } from "../src/skills/story-rules.js";
import { storyToTestsSkill } from "../src/skills/story-to-tests.js";
import { suiteChangedSinceLastFullRun } from "../src/runtime/rerun.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Two things that ended every Toolshop run blocked (13–14 Nov 2026).
 *
 * 1. Triage answers the suite's first failure with "run it again unchanged",
 *    and `staleRerun` refused that run. The runtime now makes it, once.
 * 2. The verifier's `absolute-navigation` gap covered every page object in
 *    `pages/`, so a story was blocked on files its spec does not import.
 */

const SPEC = "tests/epic-42-customer-account-access.spec.ts";
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };

type Entry =
  | { tool: string; args?: Record<string, unknown>; result?: unknown }
  | { triage: Record<string, unknown> };

function ledgerOf(entries: Entry[]): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  let id = 0;
  for (const e of entries) {
    if ("triage" in e) {
      events.push({
        ...base,
        eventId: ++id,
        kind: "triage",
        payload: e.triage,
      } as unknown as AnyRunEvent);
      continue;
    }
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
const RED = {
  tool: "pw.run_tests",
  args: { spec: SPEC },
  result: {
    passed: 0,
    failed: 1,
    skipped: 0,
    flaky: 0,
    green: false,
    failures: [{ title: "x", message: "Timeout 5000ms exceeded" }],
  },
};
const TRIAGE = (attempt: number, extra: Record<string, unknown> = {}) => ({
  triage: {
    attempt,
    reportFingerprint: `f${attempt}`,
    runLevel: null,
    verdicts: [
      {
        test: "x",
        category: "flake",
        confidence: 0.25,
        matchedPatterns: [],
        evidence: "Timeout 5000ms exceeded",
        rationale: "",
      },
    ],
    quarantined: [],
    ...extra,
  },
});

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-rerun-"));
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(join(ws, SPEC), 'test("x", async () => {});');
  return ws;
}
const skill = (ws: string) =>
  storyToTestsSkill({ workItem: "44", workspaceDir: ws, testTypes: ["functional"] });
const fullRun = { toolName: "pw.run_tests", args: { spec: SPEC } };

describe("the suite's first failure is run again unchanged", () => {
  const first = () => ledgerOf([CONTEXT, DESIGN, RED, TRIAGE(1)]);

  it("is owed after the first failing report, and only then", () => {
    expect(suiteChangedSinceLastFullRun(first()).retryOwed).toBe(true);
    // Not before triage has spoken, not after a second run, not on a later attempt.
    expect(suiteChangedSinceLastFullRun(ledgerOf([CONTEXT, DESIGN, RED])).retryOwed).toBe(false);
    expect(
      suiteChangedSinceLastFullRun(ledgerOf([CONTEXT, DESIGN, RED, TRIAGE(1), RED])).retryOwed,
    ).toBe(false);
    expect(
      suiteChangedSinceLastFullRun(ledgerOf([CONTEXT, DESIGN, RED, TRIAGE(1), RED, TRIAGE(2)]))
        .retryOwed,
    ).toBe(false);
  });

  it("is made by the runtime, which says why", () => {
    const at = skill(workspace()).autoRun?.(first());
    expect(at?.toolName).toBe("pw.run_tests");
    expect(at?.args).toEqual({ spec: SPEC });
    expect(at?.why).toContain("run again unchanged");
  });

  it("is not refused as a run of unchanged files", () => {
    expect(storyRefusal(fullRun, first())).toBeUndefined();
  });

  it("happens once: the run after it is refused and the runtime does not repeat it", () => {
    const twice = ledgerOf([CONTEXT, DESIGN, RED, TRIAGE(1), RED, TRIAGE(2)]);
    expect(skill(workspace()).autoRun?.(twice)).toBeUndefined();
    expect(storyRefusal(fullRun, twice)).toContain("nothing in the suite has changed since");
    // Also when the second report read the same and triage said nothing new.
    const silent = ledgerOf([CONTEXT, DESIGN, RED, TRIAGE(1), RED]);
    expect(skill(workspace()).autoRun?.(silent)).toBeUndefined();
    expect(storyRefusal(fullRun, silent)).toContain("nothing in the suite has changed since");
  });

  it("is not owed for a suite that passed", () => {
    const green = ledgerOf([
      CONTEXT,
      DESIGN,
      { ...RED, result: { passed: 1, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] } },
    ]);
    expect(skill(workspace()).autoRun?.(green)).toBeUndefined();
    expect(storyRefusal(fullRun, green)).toContain("nothing in the suite has changed since");
  });
});

describe("a page object with the application's address in it", () => {
  const ABSOLUTE =
    'export class P { async goto() { await this.page.goto("http://localhost:4200"); } }';
  const GREEN = { passed: 1, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] };
  function ws(spec: string): string {
    const dir = mkdtempSync(join(tmpdir(), "aqa-pages-"));
    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "pages"), { recursive: true });
    writeFileSync(join(dir, "tests", "a.spec.ts"), spec);
    writeFileSync(join(dir, "pages", "home.page.ts"), ABSOLUTE);
    writeFileSync(join(dir, "pages", "cart.page.ts"), ABSOLUTE);
    return dir;
  }
  const ran: Entry[] = [
    { tool: "ado.wit_work_item", args: { action: "get", id: 1, expand: "Relations" } },
    { tool: "pw.run_tests", args: { spec: "tests/a.spec.ts" }, result: GREEN },
  ];
  const verify = (events: AnyRunEvent[], dir: string) =>
    new StoryToTestsVerifier({ workItem: "1" }).verify({ events, workspaceDir: dir });

  it("is a gap when the run's spec imports it, and only named when it does not", async () => {
    const dir = ws('import { P } from "../pages/home.page";\ntest("t", async () => {});');
    const out = await verify(ledgerOf(ran), dir);
    const gap = out.gaps.find((g) => g.code === "absolute-navigation");
    expect(gap?.message).toContain("pages/home.page.ts");
    expect(gap?.message).not.toContain("pages/cart.page.ts");
    expect((out.limitations ?? []).join("\n")).toMatch(
      /pages\/cart\.page\.ts navigates to an absolute address.*No spec of this run imports it/,
    );
  });

  it("is no gap when no spec of the run imports any of them", async () => {
    const dir = ws('test("t", async () => {});');
    const out = await verify(ledgerOf(ran), dir);
    expect(out.gaps.map((g) => g.code)).not.toContain("absolute-navigation");
    expect((out.limitations ?? []).join("\n")).toContain("pages/cart.page.ts, pages/home.page.ts");
  });

  it("is a gap when this run wrote the file, imported or not", async () => {
    const dir = ws('test("t", async () => {});');
    const out = await verify(
      ledgerOf([
        ...ran,
        { tool: "fs.replace_in_file", args: { path: "pages/cart.page.ts", old: "a", new: "b" } },
      ]),
      dir,
    );
    const gap = out.gaps.find((g) => g.code === "absolute-navigation");
    expect(gap?.message).toContain("pages/cart.page.ts");
    expect(gap?.message).not.toContain("pages/home.page.ts");
  });
});

/** The real ledger and workspace; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261114T011832Z-495b3129", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "toolshop");
describe.skipIf(!existsSync(RUN) || !existsSync(join(WS, "pages", "cart.page.ts")))(
  "run 20261114T011832Z, replayed",
  () => {
    const all = (): AnyRunEvent[] =>
      readFileSync(RUN, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AnyRunEvent);

    it("does not refuse the re-run triage had just asked for", () => {
      const events = all();
      const refused = events.find(
        (e) =>
          e.kind === "policy" &&
          (e.payload as { toolName?: string; decision?: string }).toolName === "pw.run_tests" &&
          (e.payload as { decision?: string }).decision === "refuse",
      );
      if (!refused) throw new Error("the refused re-run is not in the ledger");
      const before = events.filter((e) => e.eventId < refused.eventId);
      expect(suiteChangedSinceLastFullRun(before).retryOwed).toBe(true);
      expect(
        storyRefusal(
          {
            toolName: "pw.run_tests",
            args: { spec: "tests/epic-tool-1-product-catalogue.spec.ts" },
          },
          before,
          { workspaceDir: WS, workItem: "TOOL-9" },
        ),
      ).toBeUndefined();
    });

    it("is not blocked on page objects of other epics", async () => {
      const events = all();
      const firstVerify = events.find((e) => e.kind === "verify");
      const upTo = events.filter((e) => e.eventId < (firstVerify?.eventId ?? 0));
      const out = await new StoryToTestsVerifier({ workItem: "TOOL-9", tracker: "jira" }).verify({
        events: upTo,
        workspaceDir: WS,
      });
      expect(out.gaps.map((g) => g.code)).not.toContain("absolute-navigation");
      expect((out.limitations ?? []).join("\n")).toContain("pages/cart.page.ts");
    });
  },
);

describe.skipIf(
  !existsSync(join(__dirname, "..", ".aqa", "runs", "20261114T133638Z-052b2a03", "events.jsonl")) ||
    !existsSync(join(WS, "pages", "cart.page.ts")),
)("run 20261114T133638Z, replayed", () => {
  it("is not blocked for a held test that passed the unchanged re-run", async () => {
    const events = readFileSync(
      join(__dirname, "..", ".aqa", "runs", "20261114T133638Z-052b2a03", "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    const firstVerify = events.find((e) => e.kind === "verify");
    const out = await new StoryToTestsVerifier({ workItem: "TOOL-9", tracker: "jira" }).verify({
      events: events.filter((e) => e.eventId < (firstVerify?.eventId ?? 0)),
      workspaceDir: WS,
    });
    expect(out.gaps.map((g) => g.code)).not.toContain("quarantined-test-modified");
    expect((out.limitations ?? []).join("\n")).toMatch(
      /AC-accessibility Home page product list.*passed when the suite was run again with nothing changed/,
    );
    expect(out.done).toBe(true);
  });
});
