import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSeed, renderSeed, SEED_MANIFEST, unreadRules } from "../src/seed/seed.js";
import { main, seed } from "../src/cli.js";
import type { CommandRunner } from "../src/mcp/adapters/process.js";

/**
 * `aqa seed`: seed data for the application, generated into the workspace and
 * loaded nowhere.
 *
 * The runner below writes what synthdata 1.4.0 wrote for this schema on
 * 15 Nov 2026 (`auto --rows 5 --seed 42`, every output flag), so the command is
 * tested without the generator installed; the last block runs the real one
 * where it is.
 */
const SCHEMA = [
  "CREATE TABLE customers (",
  "  id INTEGER PRIMARY KEY,",
  "  email VARCHAR(80) NOT NULL UNIQUE,",
  "  age INTEGER NOT NULL CHECK (age BETWEEN 18 AND 74)",
  ");",
  "CREATE TABLE orders (",
  "  id INTEGER PRIMARY KEY,",
  "  customer_id INTEGER NOT NULL REFERENCES customers(id),",
  "  total DECIMAL(8,2) NOT NULL CHECK (total BETWEEN 1 AND 5000)",
  ");",
  "",
].join("\n");

let ws: string;
let calls: Array<{ command: string; args: string[]; cwd: string }>;
const value = (args: string[], name: string) => args[args.indexOf(name) + 1] as string;

/** Stands in for the synthdata CLI: writes the files its flags ask for. */
const fakeSynthdata: CommandRunner = async (command, args, opts) => {
  calls.push({ command, args, cwd: opts.cwd });
  const csv = join(opts.cwd, value(args, "--csv"));
  writeFileSync(
    join(csv, "customers.csv"),
    "id,email,age\n1,user1@example.com,58\n2,user2@example.com,54\n",
  );
  writeFileSync(join(csv, "orders.csv"), "id,customer_id,total\n1,2,374.98\n");
  for (const flag of ["--sql", "--pg", "--mysql", "-o"])
    if (args.includes(flag)) writeFileSync(join(opts.cwd, value(args, flag)), `-- ${flag}\n`);
  return { code: 0, stdout: "OK: 2 tables, 3 rows (seed=42)", stderr: "" };
};

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, cli: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "aqa-seed-"));
  mkdirSync(join(ws, "db"));
  writeFileSync(join(ws, "db", "schema.sql"), SCHEMA);
  calls = [];
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const base = () => ({
  cli: "npx synthdata",
  workspace: ws,
  schema: "db/schema.sql",
  runner: fakeSynthdata,
});

describe("aqa seed", () => {
  it("runs synthdata in auto mode inside the workspace and records what was made", async () => {
    const r = await generateSeed({ ...base(), formats: ["csv", "postgres"], rows: 5 });
    if (!r.ok) throw new Error(r.message);

    expect(calls).toHaveLength(1);
    const { args, cwd } = calls[0]!;
    expect(cwd).toBe(ws);
    expect(args.slice(0, 2)).toEqual(["synthdata", "auto"]);
    expect(value(args, "-s")).toBe("seed-data/schema.sql");
    expect(value(args, "--rows")).toBe("5");
    expect(value(args, "--seed")).toBe("42");
    expect(value(args, "--profile")).toBe("functional");
    expect(value(args, "--pg")).toBe("seed-data/seed.pg.sql");
    // No plan, no case file, no key: nothing that would call a model.
    expect(args.some((a) => ["plan", "run", "-c", "-k", "-P"].includes(a))).toBe(false);

    expect(r.manifest.tables).toEqual([
      { table: "customers", rows: 2, csv: "customers.csv" },
      { table: "orders", rows: 1, csv: "orders.csv" },
    ]);
    expect(r.manifest.files).toEqual([
      "schema.sql",
      "customers.csv",
      "orders.csv",
      "seed.pg.sql",
      SEED_MANIFEST,
    ]);
    expect(readFileSync(join(ws, "seed-data", "schema.sql"), "utf8")).toBe(SCHEMA);
    const onDisk = JSON.parse(readFileSync(join(ws, "seed-data", SEED_MANIFEST), "utf8"));
    expect(onDisk).toEqual(r.manifest);
    // The same schema and seed give the same record: there is no date in it.
    expect(JSON.stringify(onDisk)).not.toMatch(/20\d\d-\d\d-\d\d/);

    const text = renderSeed(r, ["csv", "postgres"]);
    expect(text).toContain("customers  2 row(s)");
    expect(text).toContain("Nothing was loaded");
    expect(text).toContain("seed.pg.sql creates the tables");
  });

  it("keeps only the formats asked for", async () => {
    const r = await generateSeed({ ...base(), formats: ["sql"] });
    if (!r.ok) throw new Error(r.message);
    expect(r.manifest.files).toEqual(["schema.sql", "seed.sql", SEED_MANIFEST]);
    expect(existsSync(join(ws, "seed-data", "customers.csv"))).toBe(false);
    // The tables and their sizes are still known.
    expect(r.manifest.tables).toEqual([
      { table: "customers", rows: 2 },
      { table: "orders", rows: 1 },
    ]);
  });

  it("does nothing without SYNTHDATA_CLI, and says how to set it", async () => {
    const r = await generateSeed({ ...base(), cli: "" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("SYNTHDATA_CLI=npx synthdata");
    expect(calls).toHaveLength(0);
    expect(existsSync(join(ws, "seed-data"))).toBe(false);
  });

  it("writes only inside the workspace", async () => {
    for (const out of ["../elsewhere", ".", join(tmpdir(), "aqa-seed-outside")]) {
      const r = await generateSeed({ ...base(), out });
      expect(r.ok, out).toBe(false);
      expect(!r.ok && r.message).toContain("inside the workspace");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses rows that break a rule on purpose, and settings that are not what they say", async () => {
    const bad = async (o: object) => {
      const r = await generateSeed({ ...base(), ...o });
      return r.ok ? "" : r.message;
    };
    expect(await bad({ profile: "negative" })).toContain("not for seed data");
    expect(await bad({ rows: 0 })).toContain("--rows");
    expect(await bad({ seed: -1 })).toContain("--seed");
    expect(await bad({ formats: ["xlsx"] })).toContain("unknown xlsx");
    expect(await bad({ schema: "db/none.sql" })).toContain("no such schema file");
    writeFileSync(join(ws, "db", "notes.sql"), "-- nothing here\n");
    expect(await bad({ schema: "db/notes.sql" })).toContain("no CREATE TABLE");
    expect(calls).toHaveLength(0);
  });

  it("leaves a folder it did not write alone, and replaces its own earlier output", async () => {
    mkdirSync(join(ws, "fixtures"));
    writeFileSync(join(ws, "fixtures", "users.json"), "[]");
    const refused = await generateSeed({ ...base(), out: "fixtures" });
    expect(!refused.ok && refused.message).toContain("was not written by aqa seed");
    expect(calls).toHaveLength(0);

    const forced = await generateSeed({ ...base(), out: "fixtures", force: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(join(ws, "fixtures", "users.json"), "utf8")).toBe("[]");

    // A second run with other formats takes the first run's files away.
    await generateSeed({ ...base(), formats: ["csv", "mysql"] });
    const again = await generateSeed({ ...base(), formats: ["sql"] });
    expect(again.ok).toBe(true);
    expect(existsSync(join(ws, "seed-data", "seed.mysql.sql"))).toBe(false);
    expect(existsSync(join(ws, "seed-data", "seed.sql"))).toBe(true);
  });

  it("reports a generator that failed or wrote nothing", async () => {
    const failing: CommandRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "error: bad schema",
    });
    const a = await generateSeed({ ...base(), runner: failing });
    expect(!a.ok && a.message).toBe("synthdata exited 1: error: bad schema");
    const silent: CommandRunner = async () => ({ code: 0, stdout: "OK", stderr: "" });
    const b = await generateSeed({ ...base(), out: "other", runner: silent });
    expect(!b.ok && b.message).toContain("wrote no data");
  });

  it("names the rules synthdata does not read", () => {
    expect(unreadRules(SCHEMA)).toEqual([]);
    const found = unreadRules(
      "CREATE TABLE t (phone VARCHAR(30) CHECK (LENGTH(phone) BETWEEN 11 AND 21),\n" +
        " age INT CHECK (age >= 18 AND age <= 74), -- CHECK (LENGTH(x) > 1) in a comment\n" +
        " qty INT CHECK (qty BETWEEN 1 AND 9));",
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("LENGTH(phone) BETWEEN 11 AND 21");
    expect(found[1]).toContain("write it as BETWEEN");
  });
});

describe("aqa seed, from the command line", () => {
  const saved = process.env["SYNTHDATA_CLI"];
  afterEach(() => {
    if (saved === undefined) delete process.env["SYNTHDATA_CLI"];
    else process.env["SYNTHDATA_CLI"] = saved;
  });
  const none = join(tmpdir(), "aqa-seed-no.env");

  it("needs a schema", async () => {
    const { cli, err } = io();
    expect(await main(["seed"], cli)).toBe(1);
    expect(err.join("")).toContain("--schema <schema.sql> is required");
  });

  it("is off until SYNTHDATA_CLI is set", async () => {
    delete process.env["SYNTHDATA_CLI"];
    const { cli, err } = io();
    const code = await main(
      ["seed", "--schema", "db/schema.sql", "--workspace", ws, "--env", none],
      cli,
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("SYNTHDATA_CLI is not set");
  });

  it("passes its flags through and prints what was written", async () => {
    process.env["SYNTHDATA_CLI"] = "npx synthdata";
    const { cli, out, err } = io();
    const code = await seed(
      [
        "--schema",
        "db/schema.sql",
        "--workspace",
        ws,
        "--env",
        none,
        "--out",
        "data/seed",
        "--rows",
        "20",
        "--seed",
        "7",
        "--profile",
        "edge",
        "--format",
        "csv, SQLite",
      ],
      cli,
      fakeSynthdata,
    );
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    const { args } = calls[0]!;
    expect(value(args, "--rows")).toBe("20");
    expect(value(args, "--seed")).toBe("7");
    expect(value(args, "--profile")).toBe("edge");
    expect(value(args, "-o")).toBe("data/seed/seed.db");
    expect(out.join("")).toContain("Seed data written to data/seed/ (profile edge, seed 7");

    const bad = io();
    expect(await seed(["--schema", "db/schema.sql", "--rows", "ten"], bad.cli, fakeSynthdata)).toBe(
      1,
    );
    expect(bad.err.join("")).toContain("--rows must be a whole number");
  });
});

/** The real generator, where this machine has it. */
const REAL = "E:/Sy/testforge/bin/cli.js";
describe.skipIf(!existsSync(REAL))("aqa seed with synthdata itself", () => {
  it("writes every format, keeps foreign keys, and gives the same rows for the same seed", async () => {
    const run = (out: string, seedValue: number) =>
      generateSeed({
        cli: `node ${REAL}`,
        workspace: ws,
        schema: "db/schema.sql",
        out,
        rows: 8,
        seed: seedValue,
        formats: ["csv", "sql", "postgres", "mysql", "sqlite"],
      });
    const a = await run("a", 42);
    if (!a.ok) throw new Error(a.message);
    expect(a.manifest.tables).toEqual([
      { table: "customers", rows: 8, csv: "customers.csv" },
      { table: "orders", rows: 8, csv: "orders.csv" },
    ]);
    for (const f of a.manifest.files) expect(existsSync(join(ws, "a", f)), f).toBe(true);

    const rowsOf = (dir: string, t: string) =>
      readFileSync(join(ws, dir, `${t}.csv`), "utf8")
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.split(","));
    const ids = new Set(rowsOf("a", "customers").map((r) => r[0]));
    for (const o of rowsOf("a", "orders")) expect(ids.has(o[1])).toBe(true);
    for (const c of rowsOf("a", "customers")) {
      expect(Number(c[2])).toBeGreaterThanOrEqual(18);
      expect(Number(c[2])).toBeLessThanOrEqual(74);
    }

    const b = await run("b", 42);
    const c = await run("c", 7);
    expect(b.ok && c.ok).toBe(true);
    const text = (dir: string) => readFileSync(join(ws, dir, "customers.csv"), "utf8");
    expect(text("b")).toBe(text("a"));
    expect(text("c")).not.toBe(text("a"));
  }, 60_000);
});
