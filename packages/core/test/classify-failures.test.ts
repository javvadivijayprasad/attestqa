import { describe, it, expect } from "vitest";
import { stuckAction, valueMismatch } from "../src/heal/locator.js";
import { roleFor } from "../src/agents/roles.js";
import type { AnyRunEvent } from "../src/types.js";

// Real failure messages from Toolshop run 20261018T223256Z (F1 in docs/ENGINE_MAP.md).
const WRONG_ATTRIBUTE =
  "Error: expect(locator).toHaveAttribute(expected) failed\n\nLocator: getByRole('button', { name: 'Page-2' })\n" +
  'Expected pattern: /active/\nReceived string:  "page-link"\nTimeout: 5000ms\n\nCall log:\n' +
  "  - Expect \"toHaveAttribute\" getByRole('button', { name: 'Page-2' }) with timeout 5000ms\n" +
  "  - waiting for getByRole('button', { name: 'Page-2' })\n" +
  '    9 × locator resolved to <button type="button" class="page-link" aria-label="Page-2">2</button>\n' +
  '      - unexpected value "page-link"';
const WRONG_URL =
  'Error: expect(page).toHaveURL(expected) failed\n\nExpected pattern: /page=2/\nReceived string:  "http://localhost:4200/"\n' +
  'Timeout: 5000ms\n\nCall log:\n  - Expect "toHaveURL" with timeout 5000ms\n    14 × locator resolved to <html lang="en">…</html>';
const DEEP_EQUAL =
  "Error: expect(received).toEqual(expected) // deep equality\n\n- Expected  -   1\n+ Received  + 877\n\n- Array []";
const COUNT =
  "Error: Expected page 2 products to differ\n\nexpect(received).toBeLessThan(expected)\n\nExpected: < 9\nReceived:   9";
const NOT_FOUND =
  "Error: expect(locator).toBeVisible() failed\n\nLocator: locator('.card').first().locator('.price').first()\n" +
  "Expected: visible\nTimeout: 5000ms\nError: element(s) not found\n\nCall log:\n" +
  "  - waiting for locator('.card').first().locator('.price').first()";
const CLICK_TIMEOUT =
  "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Log in' })";

describe("a wrong value is an assertion failure, not a missing element", () => {
  it("reads the real mismatches as assertions", () => {
    for (const m of [WRONG_ATTRIBUTE, WRONG_URL, DEEP_EQUAL, COUNT]) {
      expect(valueMismatch(m)).toBe(true);
      expect(stuckAction(m)).toBe(false);
    }
  });

  it("still reads an element that never appeared as a locator failure", () => {
    for (const m of [NOT_FOUND, CLICK_TIMEOUT]) {
      expect(valueMismatch(m)).toBe(false);
      expect(stuckAction(m)).toBe(true);
    }
  });

  it("does not hand an assertion failure to the heal agent", () => {
    const run = (message: string) =>
      [
        {
          tool: "attestqa",
          runId: "r",
          eventId: 1,
          timestamp: 1,
          kind: "call",
          payload: { server: "pw", toolName: "run_tests", args: {}, startedAt: 0 },
        },
        {
          tool: "attestqa",
          runId: "r",
          eventId: 2,
          timestamp: 1,
          kind: "observation",
          payload: {
            eventIdOfCall: 1,
            ok: true,
            result: {
              passed: 2,
              failed: 1,
              failures: [{ title: "AC-3 Current page control is marked", message }],
            },
            artefacts: [],
            durationMs: 1,
          },
        },
      ] as unknown as AnyRunEvent[];
    expect(roleFor(run(WRONG_ATTRIBUTE)).name).toBe("default");
    expect(roleFor(run(NOT_FOUND)).name).toBe("heal");
  });
});
