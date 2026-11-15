import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/mcp/adapters/process.js";
import { belowMinimumMissing, SynthdataTools } from "../src/mcp/adapters/synthdata.js";

/**
 * synthdata 1.4.0's `negative` profile breaks a number range on one side only.
 * The CSVs below are what the real CLI printed on 14 Nov 2026 (seed 42) for
 * the rule of Toolshop story TOOL-34, "the customer is at least 18 and younger
 * than 75", and for a basket quantity and price. The value above the maximum is
 * there; the value below the minimum never is, on any seed. The tool's own
 * description had promised "the value one outside a range".
 */
const AGE_DDL =
  "CREATE TABLE registration (id INT PRIMARY KEY, age INT NOT NULL CHECK (age BETWEEN 18 AND 74));";
const AGE_NEGATIVE =
  "id,age,_violation\n" +
  "1,75,age: outside CHECK range (75)\n" +
  "2,,age: NULL in NOT NULL column\n" +
  "3,75,age: outside CHECK range (75)\n" +
  "4,,age: NULL in NOT NULL column\n";
const AGE_EDGE = "id,age\n1,18\n2,74\n3,46\n";

const BASKET_DDL =
  "CREATE TABLE basket (id INT PRIMARY KEY, quantity INT NOT NULL CHECK (quantity BETWEEN 1 AND 99), " +
  "price DECIMAL(6,2) CHECK (price BETWEEN 0.01 AND 999.99));";
const BASKET_NEGATIVE =
  "id,quantity,price,_violation\n" +
  "1,100,695.32,quantity: outside CHECK range (100)\n" +
  "2,,631.86,quantity: NULL in NOT NULL column\n" +
  "3,42,1000.99,price: outside CHECK range (1000.99)\n";

const writing =
  (csv: string): CommandRunner =>
  async (_command, args, opts) => {
    const dir = args[args.indexOf("--csv") + 1] as string;
    writeFileSync(join(opts.cwd, dir, "t.csv"), csv);
    return { code: 0, stdout: "OK: 1 tables", stderr: "" };
  };

const run = async (ddl: string, csv: string, profile: string) => {
  const ws = mkdtempSync(join(tmpdir(), "aqa-synth-"));
  const t = new SynthdataTools("", ws, { examplesCli: "synthdata", runner: writing(csv) });
  const r = await t.call("synthdata", "examples", { ddl, profile, out: "data" });
  expect(r.ok).toBe(true);
  return r.result as { note?: string; belowMinimumMissing?: string[] };
};

describe("synthdata.examples says which invalid boundary it did not return", () => {
  it("names the value below the minimum when the rows break the range only above it", async () => {
    const result = await run(AGE_DDL, AGE_NEGATIVE, "negative");
    expect(result.belowMinimumMissing).toEqual([
      "age: no row is below the minimum 18; the value one below it is 17",
    ]);
    expect(result.note).toMatch(/_violation/);
    expect(result.note).toMatch(/NOT among them/);
    expect(result.note).toContain("the value one below it is 17");
  });

  it("names each range, and gives no value for a range that is not in whole numbers", async () => {
    const result = await run(BASKET_DDL, BASKET_NEGATIVE, "negative");
    expect(result.belowMinimumMissing).toEqual([
      "quantity: no row is below the minimum 1; the value one below it is 0",
      "price: no row is below the minimum 0.01",
    ]);
  });

  it("is quiet once a row below the minimum comes back", async () => {
    const both = AGE_NEGATIVE + "5,17,age: outside CHECK range (17)\n";
    const result = await run(AGE_DDL, both, "negative");
    expect(result.belowMinimumMissing).toBeUndefined();
    expect(result.note).not.toMatch(/NOT among them/);
  });

  it("says nothing on the edge profile, whose rows are all valid", async () => {
    const result = await run(AGE_DDL, AGE_EDGE, "edge");
    expect(result.belowMinimumMissing).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("reads the column whatever its case, and ignores a schema with no range", () => {
    expect(
      belowMinimumMissing("CREATE TABLE t (Age INT CHECK (Age BETWEEN 18 AND 74));", [
        { columns: ["id", "age"], data: [["1", "75"]] },
      ]),
    ).toHaveLength(1);
    expect(
      belowMinimumMissing("CREATE TABLE t (name VARCHAR(20) NOT NULL);", [
        { columns: ["id", "name"], data: [["1", ""]] },
      ]),
    ).toEqual([]);
  });
});
