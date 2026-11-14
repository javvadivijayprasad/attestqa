import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storyRefusal } from "../src/skills/story-rules.js";
import { roleFor } from "../src/agents/roles.js";
import { ownTestTitles } from "../src/triage/settle.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * An assertion pointed at something else, on the path that only executes.
 *
 * Run 20261113T232526Z (TOOL-9, route B). A test of TOOL-10 failed; the heal
 * step changed its `expect(page.getByText("Combination Pliers").first())
 * .toBeVisible()` into `expect(page.getByRole("checkbox", { name: "Pliers" }))
 * .toBeVisible()` — a filter checkbox that is always there — and the suite went
 * green. Three things let it through: the test was another story's and the run
 * could not tell (it had read no file); the execute-path rule looked for the
 * removed assertion's shape anywhere in the file; and on a CRLF file the rules
 * did not recognise a multi-line edit at all.
 */

const SORT = "AC-1 Sorting by name A to Z lists products in alphabetical order";
const SEARCH =
  "AC-1 Searching for a matching word shows only products whose names contain that word";
const SPEC = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test.describe("Product catalogue", () => {',
  "  // @story:TOOL-9",
  "  // @design:D11",
  `  test("${SEARCH}", async ({ page }) => {`,
  '    await page.goto("/");',
  '    await expect(page.getByText("Pliers").first()).toBeVisible();',
  '    await expect(page.getByText("Bolt Cutters").first()).toBeVisible();',
  "  });",
  "",
  "  // @story:TOOL-10",
  "  // @design:D15",
  `  test("${SORT}", async ({ page }) => {`,
  '    await page.goto("/");',
  '    await test.step("And the page displays \\"Combination Pliers\\"", async () => {',
  '      await expect(page.getByText("Combination Pliers").first()).toBeVisible();',
  "    });",
  "  });",
  "});",
  "",
].join("\n");
const PATH = "tests/epic-tool-1-product-catalogue.spec.ts";

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
const routeB = (): AnyRunEvent =>
  ({
    ...base,
    eventId: ++n,
    kind: "route",
    payload: {
      path: "B",
      reason: "story unchanged: executing the existing tests",
      because: {
        spec: PATH,
        story: "TOOL-9",
        cases: [{ caseId: "TOOL-9-D11", design: "D11", title: SEARCH, state: "exists" }],
      },
    },
  }) as unknown as AnyRunEvent;
const redSuite = (): AnyRunEvent[] =>
  pair(
    "pw",
    "run_tests",
    { spec: PATH },
    {
      green: false,
      passed: 1,
      failed: 1,
      tests: [
        { title: SEARCH, status: "passed" },
        { title: SORT, status: "failed" },
      ],
      failures: [
        {
          title: SORT,
          message:
            "Error: expect(locator).toBeVisible() failed\nLocator: getByText('Combination Pliers').first()\n" +
            "Expected: visible\nTimeout: 5000ms\nError: element(s) not found\n" +
            "Call log:\n  - waiting for getByText('Combination Pliers').first()",
        },
      ],
    },
  );
const readSpec = (text = SPEC) =>
  pair("fs", "read_file", { path: PATH }, { path: PATH, content: text });
const edit = (oldText: string, newText: string) => ({
  toolName: "fs.replace_in_file",
  args: { path: PATH, old: oldText, new: newText },
});
const OLD = '      await expect(page.getByText("Combination Pliers").first()).toBeVisible();';

describe("an assertion moved to another locator, on the execute path", () => {
  const events = () => [routeB(), ...readSpec(), ...redSuite()];

  it("is refused when the new locator names something else", () => {
    const reason = storyRefusal(
      edit(
        OLD,
        '      await expect(page.getByRole("checkbox", { name: "Pliers" })).toBeVisible();',
      ),
      events(),
    );
    expect(reason).toContain("this run took the execute path");
    expect(reason).toContain('getByText("Combination Pliers")');
    expect(reason).toContain("only if it still names the same text");
  });

  it("is refused although another test has an assertion of the same shape", () => {
    // `expect(<locator>.first()).toBeVisible()` is also what the search test says twice.
    const reason = storyRefusal(
      edit(OLD, '      await expect(page.getByText("Pliers").first()).toBeVisible();'),
      events(),
    );
    expect(reason).toContain("takes away 1 line(s)");
  });

  it("is allowed when the new locator still names the same thing", () => {
    for (const next of [
      '      await expect(page.getByRole("heading", { name: "Combination Pliers" }).first()).toBeVisible();',
      '      await expect(page.locator(".card", { hasText: "Combination Pliers" }).first()).toBeVisible();',
    ])
      expect(storyRefusal(edit(OLD, next), events())).toBeUndefined();
  });

  it("still lets a locator with no wording move", () => {
    const spec = SPEC.replace(
      'page.getByText("Combination Pliers")',
      'page.locator(".product-name")',
    );
    const ev = [routeB(), ...readSpec(spec), ...redSuite()];
    expect(
      storyRefusal(
        edit(
          '      await expect(page.locator(".product-name").first()).toBeVisible();',
          '      await expect(page.getByTestId("product-name").first()).toBeVisible();',
        ),
        ev,
      ),
    ).toBeUndefined();
  });
});

describe("a multi-line edit of a file with CRLF line endings", () => {
  const dir = mkdtempSync(join(tmpdir(), "aqa-crlf-"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, PATH), SPEC.replace(/\n/g, "\r\n"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is judged by the write rules like any other", () => {
    // The run read nothing: the file on disk is the baseline, and it is CRLF.
    const reason = storyRefusal(
      edit(
        '    await test.step("And the page displays \\"Combination Pliers\\"", async () => {\n' +
          OLD +
          "\n    });",
        '    await test.step("And the page displays \\"Combination Pliers\\"", async () => {\n' +
          '      await expect(page.getByRole("checkbox", { name: "Pliers" })).toBeVisible();\n    });',
      ),
      [routeB(), ...redSuite()],
      { workspaceDir: dir, workItem: "TOOL-9" },
    );
    expect(reason).toContain("this run took the execute path");
  });
});

describe("whose test it is, in a run that read no file", () => {
  it("is known from the cases the route listed, on route B only", () => {
    expect([...(ownTestTitles([routeB(), ...redSuite()], "TOOL-9") ?? [])]).toEqual([SEARCH]);
    const a2 = routeB();
    (a2.payload as unknown as { path: string }).path = "A2";
    expect(ownTestTitles([a2, ...redSuite()], "TOOL-9")).toBeUndefined();
  });

  it("keeps another story's failing test out of the heal role", () => {
    expect(roleFor([routeB(), ...redSuite()], "TOOL-9").name).toBe("default");
    // The story's own test failing the same way is still healed.
    const own = redSuite().map((e) =>
      JSON.parse(
        JSON.stringify(e).split(SORT).join("@@").split(SEARCH).join(SORT).split("@@").join(SEARCH),
      ),
    ) as AnyRunEvent[];
    expect(roleFor([routeB(), ...own], "TOOL-9").name).toBe("heal");
  });
});

/** The real ledger and workspace; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261113T232526Z-a077ed1f", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "toolshop");
describe.skipIf(!existsSync(RUN) || !existsSync(join(WS, PATH)))(
  "run 20261113T232526Z, replayed",
  () => {
    const all = (): AnyRunEvent[] =>
      readFileSync(RUN, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AnyRunEvent);

    it("refuses the edit that turned the suite green", () => {
      const call = all().find(
        (e) =>
          e.kind === "call" &&
          e.payload.toolName === "replace_in_file" &&
          JSON.stringify(e.payload.args).includes("And the page displays"),
      );
      if (!call || call.kind !== "call") throw new Error("the edit is not in the ledger");
      const reason = storyRefusal(
        { toolName: "fs.replace_in_file", args: call.payload.args },
        all().filter((e) => e.eventId < call.eventId - 2),
        { workspaceDir: WS, workItem: "TOOL-9" },
      );
      expect(reason).toContain("this run took the execute path");
      expect(reason).toContain("Combination Pliers");
    });

    it("does not send TOOL-10's failing test to the heal role", () => {
      const events = all();
      const firstRun = events.find((e) => e.kind === "triage");
      const upTo = events.filter((e) => e.eventId <= (firstRun?.eventId ?? 0));
      expect(JSON.stringify(upTo)).toContain(SORT);
      expect(roleFor(upTo, "TOOL-9").name).toBe("default");
    });
  },
);
