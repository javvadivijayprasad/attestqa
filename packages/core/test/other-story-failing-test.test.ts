import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Another story's FAILING test is not this run's to change.
 *
 * Run 20261114T132625Z (TOOL-9, route B). TOOL-6's home page accessibility
 * scan failed on a real `list` violation in the filter checkboxes. The run
 * narrowed the scan — first by dropping `app-overview` from `.include(...)`,
 * then with `.exclude(".checkbox")` — and the test passed. `editsAPassingTest`
 * kept a run off another story's PASSING tests only.
 */

const PATH = "tests/epic-1-catalogue.spec.ts";
const OWN = "AC-1 Searching shows matching products";
const OTHER = "AC-accessibility Home page product list passes accessibility checks";
const SPEC = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test.describe("Product catalogue", () => {',
  "  // @story:TOOL-6",
  "  // @design:D5",
  `  test("${OTHER}", async ({ page }) => {`,
  '    await page.goto("/");',
  "    const axeResults = await new AxeBuilder({ page })",
  '      .include(".products, app-overview")',
  "      .analyze();",
  "    expect(axeResults.violations).toEqual([]);",
  "  });",
  "",
  "  // @story:TOOL-9",
  "  // @design:D11",
  `  test("${OWN}", async ({ page }) => {`,
  '    await page.goto("/");',
  '    await expect(page.getByText("Pliers").first()).toBeVisible();',
  "  });",
  "});",
  "",
].join("\n");

let n = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
const pair = (
  server: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): AnyRunEvent[] => {
  const id = ++n;
  return [
    { ...base, eventId: id, kind: "call", payload: { server, toolName, args, startedAt: 0 } },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as AnyRunEvent[];
};
const suite = (failing: string) =>
  pair(
    "pw",
    "run_tests",
    { spec: PATH },
    {
      green: false,
      passed: 1,
      failed: 1,
      tests: [OWN, OTHER].map((title) => ({
        title,
        status: title === failing ? "failed" : "passed",
      })),
      failures: [{ title: failing, message: "Error: axe violations — list (serious)" }],
    },
  );
const route = (story: string, title: string): AnyRunEvent =>
  ({
    ...base,
    eventId: ++n,
    kind: "route",
    payload: {
      path: "B",
      reason: "story unchanged: executing the existing tests",
      because: { spec: PATH, story, cases: [{ design: "D1", title, state: "exists" }] },
    },
  }) as unknown as AnyRunEvent;
const read = () => pair("fs", "read_file", { path: PATH }, { path: PATH, content: SPEC });
const edit = (oldText: string, newText: string) => ({
  toolName: "fs.replace_in_file",
  args: { path: PATH, old: oldText, new: newText },
});
const NARROWED = edit('.include(".products, app-overview")', '.include(".products")');

describe("a failing test of another story", () => {
  it("is not changed by this story's run", () => {
    const reason = storyRefusal(NARROWED, [route("TOOL-9", OWN), ...read(), ...suite(OTHER)], {
      workItem: "TOOL-9",
    });
    expect(reason).toContain(`"${OTHER}" belongs to another story`);
    expect(reason).toContain("reported with this run as that story's");
  });

  it("is still repaired by its own story's run", () => {
    expect(
      storyRefusal(NARROWED, [route("TOOL-6", OTHER), ...read(), ...suite(OTHER)], {
        workItem: "TOOL-6",
      }),
    ).toBeUndefined();
  });

  it("leaves the run free to repair its own failing test", () => {
    expect(
      storyRefusal(
        edit(
          'page.getByText("Pliers").first()',
          'page.getByRole("heading", { name: "Pliers" }).first()',
        ),
        [route("TOOL-9", OWN), ...read(), ...suite(OWN)],
        { workItem: "TOOL-9" },
      ),
    ).toBeUndefined();
  });
});

/** The real ledger and workspace; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261114T132625Z-9f090477", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "toolshop");
describe.skipIf(!existsSync(RUN) || !existsSync(WS))("run 20261114T132625Z, replayed", () => {
  const all = (): AnyRunEvent[] =>
    readFileSync(RUN, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);

  it("refuses the edit that narrowed TOOL-6's accessibility scan", () => {
    const events = all();
    const call = events.find(
      (e) =>
        e.kind === "call" &&
        e.payload.toolName === "replace_in_file" &&
        JSON.stringify(e.payload.args).includes("app-overview"),
    );
    if (!call || call.kind !== "call") throw new Error("the edit is not in the ledger");
    const reason = storyRefusal(
      { toolName: "fs.replace_in_file", args: call.payload.args },
      events.filter((e) => e.eventId < call.eventId - 2),
      { workspaceDir: WS, workItem: "TOOL-9" },
    );
    expect(reason).toContain("belongs to another story");
    expect(reason).toContain("AC-accessibility Home page product list");
  });
});
