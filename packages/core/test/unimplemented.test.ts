import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withUnimplemented, type TestRunSummary } from "../src/mcp/adapters/pw.js";

// 20261019T171551Z ran "green, 4 passed" with 6 of 10 assertion steps left
// empty by the generator: an empty step passes. Such a test is not a pass.
const SPEC = [
  'import { test, expect } from "@playwright/test";',
  'test.describe("Product catalogue", () => {',
  '  test("AC-1 Home page lists products with name, price and image", async ({ page }) => {',
  '    await test.step("Given I am on the home page", async () => {',
  "      await page.goto('/');",
  "    });",
  '    await test.step("[SKIPPED] Then each product card shows a name", async () => {',
  "      // @bdd2pw lane=todo",
  "      // TODO: No POM field maps to a generic product card name element",
  "    });",
  "  });",
  '  test("AC-3 The current page control is marked as the current page", async ({ page }) => {',
  "    await expect(page.getByRole('button', { name: 'Page-2' })).toBeVisible();",
  "  });",
  "});",
].join("\n");

const summary = (): TestRunSummary => ({
  passed: 2,
  failed: 0,
  skipped: 0,
  flaky: 0,
  green: true,
  failures: [],
  tests: [
    {
      title: "AC-1 Home page lists products with name, price and image",
      file: "e.spec.ts",
      status: "passed",
      durationMs: 1,
    },
    {
      title: "AC-3 The current page control is marked as the current page",
      file: "e.spec.ts",
      status: "passed",
      durationMs: 1,
    },
  ],
  testsOmitted: 0,
  unexpectedPasses: [],
  exitCode: 0,
});

describe("a test with empty TODO steps is not a pass", () => {
  it("marks it unimplemented, does not count it as passed, and the suite is not green", () => {
    const ws = mkdtempSync(join(tmpdir(), "aqa-todo-"));
    mkdirSync(join(ws, "tests"));
    writeFileSync(join(ws, "tests", "e.spec.ts"), SPEC);
    const r = withUnimplemented(summary(), ws)!;
    expect(r.green).toBe(false);
    expect(r.passed).toBe(1);
    expect(r.unimplemented).toEqual([
      {
        title: "AC-1 Home page lists products with name, price and image",
        file: "e.spec.ts",
        steps: ["[SKIPPED] Then each product card shows a name"],
      },
    ]);
    expect(r.tests[0]?.status).toBe("unimplemented");
    expect(r.tests[1]?.status).toBe("passed");
  });

  it("leaves a fully implemented suite green", () => {
    const ws = mkdtempSync(join(tmpdir(), "aqa-todo-"));
    mkdirSync(join(ws, "tests"));
    writeFileSync(
      join(ws, "tests", "e.spec.ts"),
      SPEC.split("\n")
        .filter((l) => !/SKIPPED|lane=todo|TODO:|^\s{4}\}\);$/.test(l) || /goto/.test(l))
        .join("\n"),
    );
    const r = withUnimplemented(summary(), ws)!;
    expect(r.unimplemented).toBeUndefined();
  });
});
