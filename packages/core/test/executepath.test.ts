import { describe, it, expect } from "vitest";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Run 20260928T082428Z in test form.
 *
 * The agent decided a passing expectation was wrong because the application
 * disagreed with it. It was refused at the feature file, so it made the same
 * argument at the spec — and won, because the write it finally sent changed only
 * a comment, and every guard compared assertions. The write was harmless that
 * run and would have been read as fact by the next one.
 *
 * Four rules come out of that ledger, and these are them.
 */

const SPEC = "tests/epic-42-customer-account-access.spec.ts";

let id = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };

function route(path: "A" | "A-prime" | "B" | "P0"): AnyRunEvent {
  return {
    ...base,
    eventId: ++id,
    kind: "route",
    payload: { path, reason: "", because: {}, denied: [] },
  } as AnyRunEvent;
}

function call(tool: string, args: Record<string, unknown>, result: unknown = {}): AnyRunEvent[] {
  const callId = ++id;
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
      eventId: ++id,
      kind: "observation",
      payload: { eventIdOfCall: callId, ok: true, result, artefacts: [], durationMs: 1 },
    } as AnyRunEvent,
  ];
}

/** A spec whose Story-a test asserts the login redirect the product owner ruled on. */
const BEFORE = [
  "  // Story-a: Logout completes",
  "  // Juice Shop redirects to /#/ after logout.",
  '  test("Story-a — logout", async ({ page }) => {',
  '    await page.getByRole("menuitem", { name: "Logout" }).click();',
  "    await expect(page).toHaveURL(/\\/#\\/login/);",
  "  });",
].join("\n");

const readSpec = (text = BEFORE) =>
  call("fs.read_file", { path: SPEC }, { path: SPEC, content: text });

/** A run where Story-a failed on the assertion — a product disagreement, not a locator. */
const failedRun = (extra: Record<string, unknown> = {}) =>
  call(
    "pw.run_tests",
    { spec: SPEC, ...extra },
    {
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      green: false,
      failures: [
        {
          title: "Story-a — logout",
          file: SPEC,
          message:
            'Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /\\/#\\/login/\nReceived string: "http://localhost:3100/#/"',
        },
      ],
    },
  );

/** A locator failure — the one thing that legitimately edits an existing spec. */
const stuckRun = () =>
  call(
    "pw.run_tests",
    { spec: SPEC },
    {
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      green: false,
      failures: [
        {
          title: "Story-a — logout",
          file: SPEC,
          message:
            "Test timeout of 30000ms exceeded.\nwaiting for getByRole('menuitem', { name: 'Sign out' })",
        },
      ],
    },
  );

const write = (content: string) => ({ toolName: "fs.write_file", args: { path: SPEC, content } });

describe("a comment is not a free space", () => {
  it("refuses a write whose only change is prose, while a test is failing", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    const after = BEFORE.replace(
      "  // Juice Shop redirects to /#/ after logout.",
      "  // Redirecting to login is not required by the story.",
    );
    const why = storyRefusal(write(after), events);
    expect(why).toContain("every line this changes");
    expect(why).toContain("comment");
    expect(why).toContain("product owner");
  });

  it("says which test is failing, so the refusal is about something", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    const after = `${BEFORE}\n  // one more thought`;
    expect(storyRefusal(write(after), events)).toContain("Story-a — logout");
  });

  it("allows a comment change when nothing is failing — there is no verdict to launder", () => {
    const events = [
      route("B"),
      ...readSpec(),
      ...call(
        "pw.run_tests",
        { spec: SPEC },
        { passed: 2, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] },
      ),
    ];
    expect(storyRefusal(write(`${BEFORE}\n  // a note`), events)).toBeUndefined();
  });

  it("catches it through the edit tool too", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    const why = storyRefusal(
      {
        toolName: "fs.replace_in_file",
        args: {
          path: SPEC,
          old: "  // Juice Shop redirects to /#/ after logout.",
          new: "  // The application is correct here.",
        },
      },
      events,
    );
    expect(why).toContain("every line this changes");
  });
});

describe("path B writes nothing but a locator", () => {
  it("refuses a write that takes away an assertion to match the application", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    const after = BEFORE.replace("/\\/#\\/login/", "/\\/#\\//");
    const why = storyRefusal(write(after), events);
    expect(why).toContain("execute path");
    expect(why).toContain("leave it red");
  });

  it("allows the locator line while healing", () => {
    const events = [route("B"), ...readSpec(), ...stuckRun()];
    const after = BEFORE.replace('name: "Logout"', 'name: "Sign out"');
    expect(storyRefusal(write(after), events)).toBeUndefined();
  });

  it("refuses it during a heal too — a locator failure is no licence on the assertions", () => {
    const events = [route("B"), ...readSpec(), ...stuckRun()];
    const after = BEFORE.replace("toHaveURL(/\\/#\\/login/)", "toHaveURL(/\\/#\\//)");
    const why = storyRefusal(write(after), events);
    expect(why).toContain("neither");
    expect(why).toContain("may not be softened");
  });

  it("allows a fallback to be removed — that is repair, not retreat", () => {
    const withFallback = BEFORE.replace(
      '    await page.getByRole("menuitem", { name: "Logout" }).click();',
      '    await page.getByRole("menuitem", { name: "Logout" }).click().catch(() => {});',
    );
    const events = [route("B"), ...readSpec(withFallback), ...failedRun()];
    expect(storyRefusal(write(BEFORE), events)).toBeUndefined();
  });

  it("allows a line to be added — a test may be strengthened", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    const after = BEFORE.replace(
      "  });",
      '    await expect(page.getByRole("button", { name: "Account" })).toBeVisible();\n  });',
    );
    expect(storyRefusal(write(after), events)).toBeUndefined();
  });

  it("still refuses the .feature file, as before", () => {
    const events = [route("B")];
    expect(
      storyRefusal(
        { toolName: "fs.write_file", args: { path: "features/e.feature", content: "Feature: x" } },
        events,
      ),
    ).toContain("execute path");
  });

  it("is scoped to path B — the authoring path answers to other rules, not this one", () => {
    const events = [route("A"), ...readSpec(), ...failedRun()];
    const after = BEFORE.replace("/\\/#\\/login/", "/\\/#\\/account/");
    // Authoring has its own order of business (scaffold before spec, and so on).
    // What matters here is that the execute-path refusal is not among them.
    expect(storyRefusal(write(after), events) ?? "").not.toContain("execute path");
  });
});

describe("the suite does not run twice against the same bytes", () => {
  it("refuses a second full run when nothing has changed", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    const why = storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC } }, events);
    expect(why).toContain("already run");
    expect(why).toContain("grep");
  });

  it("allows the first run", () => {
    const events = [route("B"), ...readSpec()];
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC } }, events),
    ).toBeUndefined();
  });

  it("allows a full run once something has changed", () => {
    const events = [
      route("B"),
      ...readSpec(),
      ...failedRun(),
      ...call("fs.replace_in_file", { path: SPEC, old: "a", new: "b" }, { replaced: 1 }),
    ];
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC } }, events),
    ).toBeUndefined();
  });

  it("never refuses a filtered run — that is the healer proving one test", () => {
    const events = [route("B"), ...readSpec(), ...failedRun()];
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC, grep: "Story-a" } }, events),
    ).toBeUndefined();
  });

  it("a filtered run does not satisfy the suite, so the next full run is allowed", () => {
    const events = [route("B"), ...readSpec(), ...failedRun({ grep: "Story-a" })];
    expect(
      storyRefusal({ toolName: "pw.run_tests", args: { spec: SPEC } }, events),
    ).toBeUndefined();
  });
});

describe("a truncated read is not a read", () => {
  it("refuses the same view twice", () => {
    const events = [route("B"), ...readSpec()];
    const why = storyRefusal({ toolName: "fs.read_file", args: { path: SPEC } }, events);
    expect(why).toContain("already read");
    expect(why).toContain("fromLine");
  });

  it("allows a range it has not seen", () => {
    const events = [route("B"), ...readSpec()];
    expect(
      storyRefusal(
        { toolName: "fs.read_file", args: { path: SPEC, fromLine: 40, toLine: 80 } },
        events,
      ),
    ).toBeUndefined();
  });

  it("refuses the same range twice", () => {
    const events = [
      route("B"),
      ...call(
        "fs.read_file",
        { path: SPEC, fromLine: 40, toLine: 80 },
        { path: SPEC, content: "x", lines: 300, fromLine: 40, toLine: 80 },
      ),
    ];
    const why = storyRefusal(
      { toolName: "fs.read_file", args: { path: SPEC, fromLine: 40, toLine: 80 } },
      events,
    );
    expect(why).toContain("lines 40–80");
  });
});
