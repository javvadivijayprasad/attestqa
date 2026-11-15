import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseCsv } from "../mcp/adapters/synthdata.js";
import { execFileRunner, splitCommand, type CommandRunner } from "../mcp/adapters/process.js";

/**
 * `aqa seed`: application seed data, generated into the workspace.
 *
 * A story's tests often need data that is already in the application — fifty
 * customers, their orders. This turns the project's own schema (CREATE TABLE
 * statements) into rows for every table, with the synthdata CLI in its `auto`
 * mode: no model is called, nothing leaves the machine, and the same seed gives
 * the same rows.
 *
 * It GENERATES and stops there. Loading the files into an application or a
 * database is a step of the project, not of this tool (decided 5 Nov 2026): a
 * command that writes to a database is a network tool with credentials, and
 * that is not something to add beside a test generator. It is also not part of
 * `aqa run`: no agent calls it, no ledger records it, and nothing happens
 * unless a person types the command with SYNTHDATA_CLI set.
 */

/** Output formats, and the synthdata flag and file each one is. */
export const SEED_FORMATS = {
  csv: { flag: "--csv", file: undefined },
  sql: { flag: "--sql", file: "seed.sql" },
  postgres: { flag: "--pg", file: "seed.pg.sql" },
  mysql: { flag: "--mysql", file: "seed.mysql.sql" },
  sqlite: { flag: "-o", file: "seed.db" },
} as const;
export type SeedFormat = keyof typeof SEED_FORMATS;

/**
 * Valid data only. `negative` (rows that break a rule) is for a form field's
 * Examples table — `synthdata.examples` — and has no place in a database a
 * suite is about to run against.
 */
export const SEED_PROFILES = ["functional", "edge", "volume"] as const;
export type SeedProfile = (typeof SEED_PROFILES)[number];

export const MAX_SEED_ROWS = 100_000;
/** The record of what was generated, written beside the data. */
export const SEED_MANIFEST = "seed.json";

/** Characters that mean something to a command interpreter (a `.cmd` launcher runs through one). */
const SHELL_UNSAFE = /[&|<>^"'`$;%\r\n]/;

export interface SeedOptions {
  /** The synthdata CLI, as configured in SYNTHDATA_CLI (`npx synthdata`). */
  cli: string;
  /** The Playwright project. Everything is written inside it. */
  workspace: string;
  /** The schema file: absolute, or relative to the workspace. May live outside it. */
  schema: string;
  /** Output directory, workspace-relative. */
  out?: string;
  rows?: number;
  seed?: number;
  profile?: string;
  formats?: readonly string[];
  /** Write into a directory that holds files this command did not make. */
  force?: boolean;
  runner?: CommandRunner;
  timeoutMs?: number;
}

export interface SeedManifest {
  generator: string;
  mode: "auto";
  profile: SeedProfile;
  rows: number;
  seed: number;
  /** sha256 of the schema the rows were made from, first 12 characters. */
  schemaHash: string;
  tables: Array<{ table: string; rows: number; csv?: string }>;
  /** Every file written, relative to the output directory. */
  files: string[];
}

export type SeedResult =
  | { ok: true; out: string; manifest: SeedManifest; warnings: string[] }
  | { ok: false; message: string };

/**
 * Rules synthdata 1.4.0 does not read, so the rows it writes for them may break
 * the very rule they are generated from (probes of 12 Nov 2026; both handed to
 * its maintainer). For an Examples table the adapter refuses such a rule; for a
 * whole schema that is not this command's to refuse — the schema is the
 * project's — so the person is told which rules to check the rows against.
 */
export function unreadRules(ddl: string): string[] {
  const out: string[] = [];
  const text = ddl.replace(/--[^\n]*/g, "");
  for (const m of text.matchAll(/CHECK\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi)) {
    const rule = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (/\b(?:CHAR_LENGTH|CHARACTER_LENGTH|LENGTH|LEN)\s*\(/i.test(rule))
      out.push(`CHECK (${rule}) — a rule on the length of a text is not read`);
    else if (/[<>]=?[^()]*\bAND\b[^()]*[<>]=?/i.test(rule))
      out.push(
        `CHECK (${rule}) — a range written as two comparisons is half read; write it as BETWEEN`,
      );
  }
  return out;
}

const fail = (message: string): SeedResult => ({ ok: false, message });

export async function generateSeed(opts: SeedOptions): Promise<SeedResult> {
  if (!opts.cli.trim())
    return fail(
      "SYNTHDATA_CLI is not set. aqa seed runs the synthdata CLI: install " +
        "@vijaypjavvadi/synthdata in the project and add SYNTHDATA_CLI=npx synthdata to .env",
    );
  const parts = splitCommand(opts.cli);
  if (!parts) return fail("SYNTHDATA_CLI is empty");

  const workspace = resolve(opts.workspace);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory())
    return fail(`no such workspace: ${opts.workspace}`);

  const schemaAbs = isAbsolute(opts.schema) ? opts.schema : resolve(workspace, opts.schema);
  if (!existsSync(schemaAbs) || !statSync(schemaAbs).isFile())
    return fail(`no such schema file: ${opts.schema}`);
  const ddl = readFileSync(schemaAbs, "utf8");
  if (!/\bCREATE\s+TABLE\b/i.test(ddl)) return fail(`${opts.schema} has no CREATE TABLE statement`);

  const profile = opts.profile ?? "functional";
  if (!(SEED_PROFILES as readonly string[]).includes(profile))
    return fail(
      `--profile must be one of ${SEED_PROFILES.join(", ")}` +
        (profile === "negative"
          ? " (negative rows break a rule on purpose; they are for a form field's Examples table, not for seed data)"
          : ""),
    );
  const rows = opts.rows ?? 50;
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_SEED_ROWS)
    return fail(`--rows must be a whole number from 1 to ${MAX_SEED_ROWS}`);
  const seed = opts.seed ?? 42;
  if (!Number.isInteger(seed) || seed < 0) return fail("--seed must be a whole number, 0 or more");

  const formats = [...new Set(opts.formats && opts.formats.length > 0 ? opts.formats : ["csv"])];
  const unknown = formats.filter((f) => !(f in SEED_FORMATS));
  if (unknown.length > 0)
    return fail(
      `--format: unknown ${unknown.join(", ")}; choose from ${Object.keys(SEED_FORMATS).join(", ")}`,
    );

  const out = (opts.out ?? "seed-data").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!out || SHELL_UNSAFE.test(out)) return fail(`--out contains unsafe characters: ${out}`);
  const outAbs = resolve(workspace, out);
  const rel = relative(workspace, outAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    return fail(`--out must be a directory inside the workspace: ${out}`);
  if (existsSync(outAbs) && !statSync(outAbs).isDirectory())
    return fail(`--out must be a directory, and ${out} is a file`);

  // Only this command's own earlier output is replaced. A directory holding
  // anything else is somebody's, and is not written into without being told.
  const existing = existsSync(outAbs) ? readdirSync(outAbs) : [];
  const previous = readManifest(outAbs);
  if (existing.length > 0 && !previous && !opts.force)
    return fail(
      `${out} is not empty and was not written by aqa seed (no ${SEED_MANIFEST}). ` +
        "Choose another --out, or pass --force to write into it",
    );
  for (const f of previous?.files ?? []) {
    const p = resolve(outAbs, f);
    if (p.startsWith(outAbs + sep) && existsSync(p)) rmSync(p, { force: true });
  }

  mkdirSync(outAbs, { recursive: true });
  writeFileSync(join(outAbs, "schema.sql"), ddl.endsWith("\n") ? ddl : `${ddl}\n`, "utf8");

  const posix = rel.split(sep).join("/");
  const args = [
    ...parts.args,
    "auto",
    "-s",
    `${posix}/schema.sql`,
    "--rows",
    String(rows),
    "--profile",
    profile,
    "--seed",
    String(seed),
  ];
  // CSV is always written: the table list and the row counts are read from it.
  args.push("--csv", posix);
  for (const f of formats) {
    const spec = SEED_FORMATS[f as SeedFormat];
    if (spec.file) args.push(spec.flag, `${posix}/${spec.file}`);
  }

  // `npx` on Windows is a batch launcher and cannot be spawned by its bare name.
  const command =
    process.platform === "win32" && parts.command === "npx" ? "npx.cmd" : parts.command;
  const r = await (opts.runner ?? execFileRunner)(command, args, {
    cwd: workspace,
    timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
  });
  if (r.code !== 0)
    return fail(`synthdata exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-500)}`);

  const csvFiles = readdirSync(outAbs)
    .filter((f) => /\.csv$/i.test(f))
    .sort();
  if (csvFiles.length === 0)
    return fail(`synthdata reported success but wrote no data into ${out}`);

  const keepCsv = formats.includes("csv");
  const tables = csvFiles.map((f) => {
    const n = Math.max(0, parseCsv(readFileSync(join(outAbs, f), "utf8")).length - 1);
    return { table: f.replace(/\.csv$/i, ""), rows: n, ...(keepCsv ? { csv: f } : {}) };
  });
  if (!keepCsv) for (const f of csvFiles) rmSync(join(outAbs, f), { force: true });

  const files = [
    "schema.sql",
    ...(keepCsv ? csvFiles : []),
    ...formats
      .map((f) => SEED_FORMATS[f as SeedFormat].file)
      .filter((f): f is NonNullable<typeof f> => f !== undefined && existsSync(join(outAbs, f))),
    SEED_MANIFEST,
  ];
  const missing = formats
    .map((f) => SEED_FORMATS[f as SeedFormat].file)
    .filter((f) => f !== undefined && !existsSync(join(outAbs, f)));
  if (missing.length > 0)
    return fail(`synthdata reported success but did not write ${missing.join(", ")} into ${out}`);

  const manifest: SeedManifest = {
    generator: "synthdata",
    mode: "auto",
    profile: profile as SeedProfile,
    rows,
    seed,
    schemaHash: createHash("sha256").update(ddl).digest("hex").slice(0, 12),
    tables,
    files,
  };
  // No date in it: the same schema and seed give the same folder, byte for byte.
  writeFileSync(join(outAbs, SEED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { ok: true, out: posix, manifest, warnings: unreadRules(ddl) };
}

function readManifest(dir: string): SeedManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, SEED_MANIFEST), "utf8")) as SeedManifest;
    return m.generator === "synthdata" && Array.isArray(m.files) ? m : undefined;
  } catch {
    return undefined;
  }
}

/** What the command prints when it is done. */
export function renderSeed(
  r: Extract<SeedResult, { ok: true }>,
  formats: readonly string[],
): string {
  const m = r.manifest;
  const w = Math.max(...m.tables.map((t) => t.table.length));
  const lines = [
    `Seed data written to ${r.out}/ (profile ${m.profile}, seed ${m.seed}; the same seed gives the same rows)`,
    ...m.tables.map((t) => `  ${t.table.padEnd(w)}  ${t.rows} row(s)`),
    `Files: ${m.files.join(", ")}`,
  ];
  for (const x of r.warnings)
    lines.push(`Check the rows against this rule, which synthdata does not read: ${x}`);
  // What each script is, as synthdata 1.4.0 writes it (probe of 15 Nov 2026):
  // the Postgres and MySQL scripts create the tables, seed.sql does not.
  if (formats.includes("sql"))
    lines.push(
      "seed.sql holds INSERT statements only, for a database that already has the tables.",
    );
  if (formats.includes("postgres"))
    lines.push(
      `seed.pg.sql creates the tables and inserts the rows (psql -d <database> -f ${r.out}/seed.pg.sql).`,
    );
  if (formats.includes("mysql"))
    lines.push(
      `seed.mysql.sql creates the tables and inserts the rows (mysql <database> < ${r.out}/seed.mysql.sql).`,
    );
  lines.push(
    "Nothing was loaded: putting this data into the application is a step of your project.",
  );
  return `${lines.join("\n")}\n`;
}
