import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { axeSummary } from "../src/mcp/adapters/pw.js";

// The failure message of Booker's accessibility test (20261021T232323Z): the
// violations array as JSON, 20,884 characters. Cut to 600, it named one rule's
// tags and no element, and bug #127 said "one or more text elements".
const BOOKER = readFileSync(join(__dirname, "fixtures", "axe-color-contrast-booker.txt"), "utf8");

describe("an axe failure says which elements failed", () => {
  it("names each rule, its elements and the measured contrast", () => {
    const s = axeSummary(BOOKER) ?? "";
    expect(s).toContain("color-contrast (serious) on 4 element(s)");
    expect(s).toContain('a[href$="cookie"]');
    expect(s).toContain("3.42:1 (needs 4.5:1)");
    expect(s).toContain("label (critical) on 3 element(s)");
    expect(s).toContain("link-name (serious)");
    expect(s.length).toBeLessThan(900);
  });

  it("leaves any other failure alone", () => {
    expect(axeSummary("Error: expect(received).toBe(expected)")).toBeUndefined();
    expect(axeSummary("Error: axe violations: [ not json")).toBeUndefined();
  });
});

describe("triage reads the summary as the product's answer", () => {
  it("matches a real-defect pattern", async () => {
    const { PW_REAL_DEFECT_PATTERNS } = await import("../src/triage/patterns.js");
    const s = axeSummary(BOOKER) ?? "";
    expect(PW_REAL_DEFECT_PATTERNS.some((p) => p.re.test(s))).toBe(true);
  });
});
