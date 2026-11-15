import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdit, editHits } from "../src/design/edits.js";
import { sameTest, shownTitle, TitleSet } from "../src/design/titles.js";
import {
  fileTextFromEvents,
  otherStoryTestTitles,
  storyTestTitles,
  testBody,
} from "../src/design/test-design.js";
import { ownTestTitles } from "../src/triage/settle.js";
import { triageGaps } from "../src/triage/step.js";
import { regressedByEdit } from "../src/triage/quarantine.js";
import { editsAPassingTest, storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * The tests of a Scenario Outline are the story's own.
 *
 * Toolshop TOOL-34, 20261115T004103Z. The spec writes an outline's tests in a
 * loop with the row's value in the title; Playwright reports "… age 75". The
 * run reported its own failing test as another story's, and was then blocked
 * for "modifying" a test that had only failed once and passed on the re-run.
 */
const SPEC = [
  'import { test, expect } from "@playwright/test";',
  'test.describe("Customer account", () => {',
  "  // @story:TOOL-13",
  "  // @design:D2",
  '  test("AC-2 A wrong password shows an error", async ({ page }) => {',
  '    await expect(page.getByText("Invalid")).toBeVisible();',
  "  });",
  "",
  "  for (const example of ageLimitExamples) {",
  "    // @story:TOOL-34",
  "    // @ac:1",
  "    // @design:D16",
  "    test(`AC-1 Registration enforces the customer age limits age ${example.age}`, async ({ page }) => {",
  "      await expect(page).toHaveURL(/auth\\/login/);",
  "    });",
  "  }",
  "",
  "  // @story:TOOL-34",
  "  // @design:D19",
  '  test("AC-accessibility The registration page passes an automated accessibility scan", async ({ page }) => {',
  "    const results = await new AxeBuilder({ page }).analyze();",
  "    expect(results.violations).toEqual([]);",
  "  });",
  "});",
  "",
].join("\n");

const AGE_75 = "AC-1 Registration enforces the customer age limits age 75";
const SCAN = "AC-accessibility The registration page passes an automated accessibility scan";
const OTHER = "AC-2 A wrong password shows an error";
const PREFIX = "epic-tool-3-customer-account.spec.ts › Customer account › ";

let nextId = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
function call(
  tool: string,
  args: Record<string, unknown>,
  result: unknown = {},
  ok = true,
): AnyRunEvent[] {
  const callId = ++nextId;
  return [
    {
      ...base,
      eventId: callId,
      kind: "call",
      payload: {
        server: tool.split(".")[0] as string,
        toolName: tool.slice(tool.indexOf(".") + 1),
        args,
        startedAt: 0,
      },
    } as AnyRunEvent,
    {
      ...base,
      eventId: ++nextId,
      kind: "observation",
      payload: { eventIdOfCall: callId, ok, result, artefacts: [], durationMs: 1 },
    } as AnyRunEvent,
  ];
}
function triage(attempt: number, failing: string[], quarantined: string[]): AnyRunEvent {
  return {
    ...base,
    eventId: ++nextId,
    kind: "triage",
    payload: {
      attempt,
      reportFingerprint: `f${attempt}`,
      runLevel: null,
      quarantined: quarantined.map((t) => PREFIX + t),
      verdicts: failing.map((t) => ({
        test: PREFIX + t,
        category: "real-defect",
        confidence: 0.33,
        matchedPatterns: ["(?i)\\btoHave(URL)\\b"],
        evidence: `Error: expect(page).toHaveURL(expected) failed · ${t}`,
        rationale: "",
        triagedBy: "builtin",
      })),
    },
  } as unknown as AnyRunEvent;
}
const run = (failing: string[]) =>
  call(
    "pw.run_tests",
    {},
    { green: false, failures: failing.map((title) => ({ title, message: "Error" })) },
  );

describe("a test title written as a template", () => {
  it("is the test of every title it prints, and of nothing else", () => {
    const written = "AC-1 Registration enforces the customer age limits age ${example.age}";
    expect(sameTest(written, AGE_75)).toBe(true);
    expect(sameTest(written, "AC-1 Registration enforces the customer age limits")).toBe(false);
    expect(sameTest(written, "AC-1 Registration enforces the password limits age 75")).toBe(false);
    expect(
      sameTest("password ${example.password.length} characters", "password 8 characters"),
    ).toBe(true);
    expect(sameTest("${a ? `x` : { b }} and done", "anything and done")).toBe(true);
    // A title that is only a placeholder answers for nothing.
    expect(sameTest("${example.title}", AGE_75)).toBe(false);
    expect(sameTest(OTHER, OTHER)).toBe(true);
    expect(shownTitle(written)).toBe(
      "AC-1 Registration enforces the customer age limits age <age>",
    );
  });

  it("puts an outline's reported tests with their story", () => {
    const mine = storyTestTitles(SPEC, "TOOL-34");
    expect(mine.has(AGE_75)).toBe(true);
    expect(mine.has(SCAN)).toBe(true);
    expect(mine.has(OTHER)).toBe(false);
    const others = otherStoryTestTitles(SPEC, "TOOL-34");
    expect(others.has(OTHER)).toBe(true);
    expect(others.has(AGE_75)).toBe(false);
    expect(testBody(SPEC, AGE_75)).toContain("toHaveURL");
    expect(testBody(SPEC, "AC-9 no such test")).toBeUndefined();
  });

  it("reads the route's scenario names as the names an outline's tests begin with", () => {
    const listed = new TitleSet(["AC-1 Registration enforces the customer age limits", SCAN], true);
    expect(listed.has(AGE_75)).toBe(true);
    expect(listed.has("AC-1 Registration enforces the customer age limitsX")).toBe(false);
    expect(listed.has(OTHER)).toBe(false);
    // Spec titles are not prefixes.
    expect(new TitleSet(["AC-1 Registration enforces the customer age limits"]).has(AGE_75)).toBe(
      false,
    );
  });
});

describe("an edit replayed from the ledger", () => {
  const crlf = SPEC.replace(/\n/g, "\r\n");
  const old = '  // @design:D19\n  test("AC-accessibility';
  const next = '  // @design:D19\n  // scoped\n  test("AC-accessibility';

  it("is applied across line endings, in the file's own", () => {
    const out = applyEdit(crlf, old, next);
    expect(out).toContain("// @design:D19\r\n  // scoped\r\n  test(");
    expect(out?.includes("\n  // scoped\n")).toBe(false);
    expect(applyEdit(crlf, "not in the file", "x")).toBeUndefined();
    expect(applyEdit("a $& b", "a", "$1")).toBe("$1 $& b");
    expect(applyEdit("x x x", "x", "y", true)).toBe("y y y");
  });

  it("reads a masked value in `old` as the value it hides, across line endings", () => {
    const text = "// see http://127.0.0.1:4900/x\r\n  // TODO\r\n";
    const masked = "// see http://[IP]:4900/x\n  // TODO";
    expect(editHits(text, masked)).toBe(1);
    expect(applyEdit(text, masked, "// done [IP]")).toBe("// done 127.0.0.1\r\n");
    expect(applyEdit(text.replace(/\r\n/g, "\n"), masked, "// done")).toBe("// done\n");
  });

  it("leaves the run with its view of a CRLF spec it edited with LF", () => {
    nextId = 0;
    const path = "tests/epic-tool-3-customer-account.spec.ts";
    const events = [
      ...call("fs.read_file", { path }, { path, lines: 25, content: crlf }),
      ...call("fs.replace_in_file", { path, old, new: next }, { path, replaced: 1 }),
    ];
    const text = fileTextFromEvents(events, path);
    expect(text).toContain("// scoped");
    expect(storyTestTitles(text ?? "", "TOOL-34").has(AGE_75)).toBe(true);
  });
});

describe("a held test that changed on an unchanged re-run", () => {
  const path = "tests/epic-tool-3-customer-account.spec.ts";
  const flaky = "AC-2 Registration enforces the password minimum length password 8 characters";

  it("is unstable, whatever is edited later in the run", () => {
    nextId = 0;
    const events = [
      ...run([AGE_75, flaky]),
      triage(1, [AGE_75, flaky], [flaky]),
      ...run([AGE_75]),
      triage(2, [AGE_75], []),
      ...call("fs.read_file", { path }, { path, lines: 25, content: SPEC }),
      ...call(
        "fs.replace_in_file",
        { path, old: "new AxeBuilder({ page })", new: 'new AxeBuilder({ page }).include("form")' },
        { path, replaced: 1 },
      ),
      ...run([AGE_75]),
      triage(3, [AGE_75], []),
    ];
    const { gaps, limitations } = triageGaps(events);
    expect(gaps.map((g) => g.code)).not.toContain("quarantined-test-modified");
    expect(limitations.join("\n")).toMatch(/password 8 characters — failed, was held .* passed/);
  });

  it("is still asked about when a spec was written before its failure changed", () => {
    nextId = 0;
    const events = [
      ...call("fs.read_file", { path }, { path, lines: 25, content: SPEC }),
      ...run([AGE_75]),
      triage(1, [AGE_75], [AGE_75]),
      ...call(
        "fs.replace_in_file",
        { path, old: "await expect(page).toHaveURL(/auth\\/login/);", new: "// nothing" },
        { path, replaced: 1 },
      ),
      ...run([]),
      triage(2, [], []),
    ];
    expect(triageGaps(events).gaps.map((g) => g.code)).toContain("quarantined-test-modified");
  });

  it("counts an edit to an outline's test against the titles it is reported under", () => {
    nextId = 0;
    const tests = (status: string) => ({
      green: status === "passed",
      failures: status === "passed" ? [] : [{ title: AGE_75, message: "Error" }],
      tests: [{ title: PREFIX + AGE_75, status }],
    });
    const events = [
      ...call("fs.read_file", { path }, { path, lines: 25, content: SPEC }),
      ...call("pw.run_tests", {}, tests("passed")),
      ...call(
        "fs.replace_in_file",
        { path, old: "/auth\\/login/", new: "/auth\\/register/" },
        { path, replaced: 1 },
      ),
      ...call("pw.run_tests", {}, tests("failed")),
    ];
    expect([...regressedByEdit(events)]).toEqual([AGE_75]);
  });
});

/** The real run: its own failing outline test, and the test it was blocked for. */
const file = join(__dirname, "..", ".aqa", "runs", "20261115T004103Z-f18010c0", "events.jsonl");
describe.skipIf(!existsSync(file))("run 20261115T004103Z-f18010c0, replayed", () => {
  const events = () =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);

  it("knows the age-75 test as TOOL-34's, before and after the spec is read and edited", () => {
    const all = events();
    const firstTriage = all.findIndex((e) => e.kind === "triage");
    for (const upTo of [firstTriage + 1, all.length]) {
      const mine = ownTestTitles(all.slice(0, upTo), "TOOL-34");
      expect(mine?.has(AGE_75)).toBe(true);
      expect(mine?.has(SCAN)).toBe(true);
      expect(
        mine?.has(
          "AC-2 A wrong password shows an error and the customer stays on the sign-in page",
        ),
      ).toBe(false);
    }
  });

  it("is not blocked for a test that passed on an unchanged re-run", () => {
    const { gaps, limitations } = triageGaps(events());
    expect(gaps.map((g) => g.code)).not.toContain("quarantined-test-modified");
    expect(limitations.join("\n")).toContain("The test is not stable");
  });
});

/**
 * Another story's UNFINISHED test is not this run's to write.
 *
 * 20261115T124325Z (TOOL-34, route B): the suite result listed two skipped
 * tests of TOOL-13 as not implemented, and the run wrote their steps.
 */
describe("another story's unfinished test", () => {
  const path = "tests/epic-tool-3-customer-account.spec.ts";
  const unfinished = "AC-3 Signing out signs the customer out";
  const spec = SPEC.replace(
    "  for (const example of ageLimitExamples) {",
    [
      "  // @story:TOOL-13",
      "  // @design:D4",
      `  test("${unfinished}", async ({ page }) => {`,
      '    test.fixme(true, "bdd2pw: 1 step(s) not bound");',
      '    await test.step("[SKIPPED] When I sign out", async () => {',
      "      // TODO: no rule matched",
      "    });",
      "  });",
      "",
      "  for (const example of ageLimitExamples) {",
    ].join("\n"),
  );
  const ledger = (story: string, title: string): AnyRunEvent[] => [
    {
      ...base,
      eventId: ++nextId,
      kind: "route",
      payload: {
        path: "B",
        reason: "story unchanged: executing the existing tests",
        because: { spec: path, story, cases: [{ design: "D16", title, state: "exists" }] },
      },
    } as unknown as AnyRunEvent,
    ...call("fs.read_file", { path }, { path, content: spec }),
    ...call(
      "pw.run_tests",
      { spec: path },
      {
        green: false,
        tests: [
          { title: OTHER, status: "passed" },
          { title: unfinished, status: "skipped" },
          { title: AGE_75, status: "failed" },
        ],
        failures: [{ title: AGE_75, message: "Error" }],
      },
    ),
  ];
  const writeSteps = {
    toolName: "fs.replace_in_file",
    args: { path, old: "      // TODO: no rule matched", new: '      await page.click("a");' },
  };

  it("is left as it is by a run of another story", () => {
    nextId = 0;
    const reason = storyRefusal(
      writeSteps,
      ledger("TOOL-34", "AC-1 Registration enforces the customer age limits"),
      { workItem: "TOOL-34" },
    );
    expect(reason).toContain(`"${unfinished}" belongs to another story`);
  });

  it("leaves the run free to repair its own failing outline test", () => {
    nextId = 0;
    const content = applyEdit(
      spec,
      "toHaveURL(/auth\\/login/)",
      "toHaveURL(/auth\\/login/, { timeout: 15000 })",
    );
    expect(content).toBeDefined();
    expect(
      editsAPassingTest(
        { toolName: "fs.write_file", args: { path, content } },
        ledger("TOOL-34", "AC-1 Registration enforces the customer age limits"),
        undefined,
        "TOOL-34",
      ),
    ).toBeUndefined();
  });
});

const file2 = join(__dirname, "..", ".aqa", "runs", "20261115T124325Z-0f4541c8", "events.jsonl");
describe.skipIf(!existsSync(file2))("run 20261115T124325Z-0f4541c8, replayed", () => {
  it("refuses the steps it wrote into TOOL-13's unfinished tests", () => {
    const all = readFileSync(file2, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    const at = all.findIndex(
      (e) =>
        e.kind === "call" &&
        (e.payload as { toolName?: string }).toolName === "replace_in_file" &&
        String((e.payload as { args: Record<string, unknown> }).args["old"]).includes("[SKIPPED]"),
    );
    expect(at).toBeGreaterThan(0);
    const args = (all[at]?.payload as { args: Record<string, unknown> }).args;
    const reason = storyRefusal({ toolName: "fs.replace_in_file", args }, all.slice(0, at), {
      workItem: "TOOL-34",
    });
    expect(reason).toMatch(/belongs? to another story/);
  });
});
