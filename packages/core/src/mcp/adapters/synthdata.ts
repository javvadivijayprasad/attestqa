import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { FsTools } from "./fs.js";
import { execFileRunner, splitCommand, type CommandRunner } from "./process.js";

export interface SynthdataOptions {
  runner?: CommandRunner;
  timeoutMs?: number;
  /**
   * The synthdata CLI itself (`SYNTHDATA_CLI`, e.g. `npx synthdata`), which
   * switches on `synthdata.examples`. Separate from the constructor's command
   * line, which is the project's OWN generator behind `SYNTHDATA_CMD`: the two
   * have different calling conventions and a project may have either or both.
   */
  examplesCli?: string;
}

/** The synthdata profiles that make sense for a form field's Examples table. */
export const EXAMPLE_PROFILES = ["edge", "negative", "functional"] as const;
export type ExampleProfile = (typeof EXAMPLE_PROFILES)[number];

/** Rows a single call may ask for. An Examples table is read by a person. */
export const MAX_EXAMPLE_ROWS = 50;
const MAX_DDL_CHARS = 8000;
const MAX_TABLES_REPORTED = 3;
const MAX_CELL_CHARS = 200;

/** Characters that mean something to a command interpreter (a `.cmd` launcher runs through one). */
const SHELL_UNSAFE = /[&|<>^"'`$;%\r\n]/;

/**
 * A range written as one compound comparison, `CHECK (age >= 18 AND age <= 120)`.
 *
 * synthdata 1.4.0 reads only the first half of it: it emitted 518 and 1018 for
 * that rule (probe of 12 Nov 2026), which are neither boundaries nor valid, and
 * nothing in its output says so. `BETWEEN` is read correctly. Refused here so a
 * wrong boundary never reaches an Examples table; remove this once the fix
 * ships (handed to the synthdata maintainer on 12 Nov 2026).
 */
const COMPOUND_RANGE_CHECK = /CHECK\s*\([^()]*[<>]=?[^()]*\bAND\b[^()]*[<>]=?[^()]*\)/i;

/**
 * In-process `synthdata` adapter. Two tools, each behind its own setting:
 *
 * `generate` — the project's own synthetic test-data generator, configured as
 * `SYNTHDATA_CMD` (e.g. `python tools/synthdata.py`). Invoked as
 *
 *     <SYNTHDATA_CMD> --schema <schema> --count <n> --out <path>
 *
 * `examples` — the synthdata CLI (`@vijaypjavvadi/synthdata`), configured as
 * `SYNTHDATA_CLI` (e.g. `npx synthdata`). Invoked as
 *
 *     <SYNTHDATA_CLI> auto -s <out>/schema.sql --rows <n> --profile <p> --csv <out> --seed <s>
 *
 * `auto` is the mode with no model and no plan, so nothing leaves the machine
 * and the same seed gives the same rows.
 *
 * Output paths are forced inside the workspace. No shell is involved, so
 * nothing in an argument can be interpreted as a command.
 */
export class SynthdataTools implements ToolClient {
  readonly server = "synthdata";
  private readonly fs: FsTools;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  private readonly examplesCli: string | undefined;

  constructor(
    private readonly commandLine: string,
    private readonly workspace: string,
    opts: SynthdataOptions = {},
  ) {
    this.fs = new FsTools(workspace);
    this.runner = opts.runner ?? execFileRunner;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    this.examplesCli = opts.examplesCli?.trim() ? opts.examplesCli : undefined;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const tools: ToolDescriptor[] = [];
    if (this.commandLine.trim())
      tools.push({
        server: this.server,
        name: "generate",
        description:
          "Generate synthetic test data for a named schema into a workspace file. Never touches real data.",
        inputSchema: {
          type: "object",
          properties: {
            schema: { type: "string", description: "Schema or entity name to generate" },
            count: { type: "integer", description: "How many records", default: 10 },
            out: { type: "string", description: "Output file, workspace-relative" },
          },
          required: ["schema", "out"],
        },
        policyClass: "write_workspace",
      });
    if (this.examplesCli)
      tools.push({
        server: this.server,
        name: "examples",
        description:
          "Generate the rows for a Scenario Outline's Examples table from a form field's rules. " +
          "State the rules as one small CREATE TABLE: a required field is NOT NULL, a maximum " +
          "length is VARCHAR(n), a range is CHECK (col BETWEEN a AND b), an allowed set is " +
          "CHECK (col IN ('a','b')). Profile 'edge' gives the valid boundaries (minimum, maximum, " +
          "longest string, every allowed value); 'negative' gives invalid rows, one broken rule " +
          "each, named in a _violation column (the value one outside a range is here, not in " +
          "'edge'); 'functional' gives ordinary valid rows. The same seed always gives the same " +
          "rows. Writes CSV into the workspace and returns the rows as a ready Examples table. " +
          "No model is called and no real data is touched.",
        inputSchema: {
          type: "object",
          properties: {
            ddl: {
              type: "string",
              description:
                "One or more CREATE TABLE statements stating the field rules. Write a range as BETWEEN.",
            },
            profile: {
              type: "string",
              enum: [...EXAMPLE_PROFILES],
              description:
                "edge (valid boundaries), negative (invalid rows), functional (valid rows)",
              default: "edge",
            },
            rows: {
              type: "integer",
              description: `Rows per table, 1 to ${MAX_EXAMPLE_ROWS}`,
              default: 6,
            },
            seed: { type: "integer", description: "Seed for reproducible rows", default: 42 },
            out: {
              type: "string",
              description:
                "Output DIRECTORY, workspace-relative; receives schema.sql and one CSV per table",
            },
          },
          required: ["ddl", "out"],
        },
        policyClass: "write_workspace",
      });
    return tools;
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`unknown synthdata tool: ${server}.${name}`);
    if (name === "generate") return this.generate(args);
    if (name === "examples") return this.examples(args);
    return fail(`unknown synthdata tool: ${server}.${name}`);
  }

  private async generate(args: Record<string, unknown>): Promise<ToolResult> {
    const schema = args["schema"];
    const out = args["out"];
    if (typeof schema !== "string" || !schema) return fail(`"schema" is required`);
    if (typeof out !== "string" || !out) return fail(`"out" is required`);
    const outAbs = this.fs.inside(out);
    if (!outAbs) return fail(`path escapes the workspace: ${out}`);
    const count = typeof args["count"] === "number" ? Math.trunc(args["count"]) : 10;
    if (!Number.isFinite(count) || count < 1) return fail(`"count" must be a positive integer`);

    const parts = splitCommand(this.commandLine);
    if (!parts) return fail(`SYNTHDATA_CMD is empty`);
    const r = await this.runner(
      parts.command,
      [...parts.args, "--schema", schema, "--count", String(count), "--out", out],
      { cwd: this.workspace, timeoutMs: this.timeoutMs },
    );
    if (r.code !== 0) {
      return fail(`synthdata exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    }
    const wrote = existsSync(outAbs);
    return {
      ok: true,
      result: {
        path: out,
        schema,
        count,
        bytes: wrote ? statSync(outAbs).size : 0,
        stdout: r.stdout.trim().slice(-2000),
      },
      artefacts: wrote ? [out] : [],
    };
  }

  private async examples(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.examplesCli) return fail(`SYNTHDATA_CLI is not set`);
    const ddl = args["ddl"];
    if (typeof ddl !== "string" || !/\bCREATE\s+TABLE\b/i.test(ddl))
      return fail(`"ddl" is required and must contain a CREATE TABLE statement`);
    if (ddl.length > MAX_DDL_CHARS)
      return fail(`"ddl" is too long (${ddl.length} characters; the limit is ${MAX_DDL_CHARS})`);
    if (COMPOUND_RANGE_CHECK.test(ddl))
      return fail(
        "write the range as CHECK (col BETWEEN a AND b), not as two comparisons joined by AND: " +
          "synthdata reads only half of the compound form and returns values that are not boundaries",
      );

    const profile = args["profile"] === undefined ? "edge" : args["profile"];
    if (typeof profile !== "string" || !(EXAMPLE_PROFILES as readonly string[]).includes(profile))
      return fail(`"profile" must be one of ${EXAMPLE_PROFILES.join(", ")}`);

    const rows = args["rows"] === undefined ? 6 : args["rows"];
    if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 1 || rows > MAX_EXAMPLE_ROWS)
      return fail(`"rows" must be a whole number from 1 to ${MAX_EXAMPLE_ROWS}`);
    const seed = args["seed"] === undefined ? 42 : args["seed"];
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0)
      return fail(`"seed" must be a whole number, 0 or more`);

    const out = args["out"];
    if (typeof out !== "string" || !out) return fail(`"out" is required`);
    const outAbs = this.fs.inside(out);
    if (!outAbs) return fail(`path escapes the workspace: ${out}`);
    if (SHELL_UNSAFE.test(out)) return fail(`"out" contains unsafe characters`);
    if (existsSync(outAbs) && !statSync(outAbs).isDirectory())
      return fail(`"out" must be a directory, and ${out} is a file`);

    const parts = splitCommand(this.examplesCli);
    if (!parts) return fail(`SYNTHDATA_CLI is empty`);
    // `npx` on Windows is a batch launcher and cannot be spawned by its bare name.
    const command =
      process.platform === "win32" && parts.command === "npx" ? "npx.cmd" : parts.command;

    const rel = out.replace(/\\/g, "/").replace(/\/+$/, "");
    const schemaRel = `${rel}/schema.sql`;
    mkdirSync(outAbs, { recursive: true });
    writeFileSync(join(outAbs, "schema.sql"), ddl.endsWith("\n") ? ddl : `${ddl}\n`, "utf8");

    const r = await this.runner(
      command,
      [
        ...parts.args,
        "auto",
        "-s",
        schemaRel,
        "--rows",
        String(rows),
        "--profile",
        profile,
        "--csv",
        rel,
        "--seed",
        String(seed),
      ],
      { cwd: this.workspace, timeoutMs: this.timeoutMs },
    );
    if (r.code !== 0) {
      return fail(`synthdata exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    }

    let csvFiles: string[] = [];
    try {
      csvFiles = readdirSync(outAbs)
        .filter((f) => /\.csv$/i.test(f))
        .sort();
    } catch {
      csvFiles = [];
    }
    if (csvFiles.length === 0)
      return fail(`synthdata reported success but wrote no CSV into ${rel}`);

    const tables = csvFiles.slice(0, MAX_TABLES_REPORTED).map((f) => {
      const parsed = parseCsv(readFileSync(join(outAbs, f), "utf8"));
      const [columns = [], ...data] = parsed;
      return {
        table: f.replace(/\.csv$/i, ""),
        csv: `${rel}/${f}`,
        columns,
        rowCount: data.length,
        examples: examplesTable(columns, data),
      };
    });

    return {
      ok: true,
      result: {
        profile,
        rows,
        seed,
        schema: schemaRel,
        tables,
        ...(profile === "negative"
          ? {
              note:
                "Each row breaks one rule, named in _violation. Use that rule's own error message " +
                "as the expected result, and leave the _violation column out of the feature file.",
            }
          : {}),
      },
      artefacts: [schemaRel, ...csvFiles.map((f) => `${rel}/${f}`)],
    };
  }
}

/**
 * A small CSV reader: commas, CRLF or LF, and double-quoted cells with `""` as
 * an escaped quote. Enough for a generator's own output; not a general parser.
 */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) out.push(row);
  return out;
}

/** The rows as a Gherkin Examples table, ready to paste under a Scenario Outline. */
export function examplesTable(columns: string[], rows: string[][]): string {
  const cell = (v: string) =>
    v.slice(0, MAX_CELL_CHARS).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const all = [columns, ...rows.slice(0, MAX_EXAMPLE_ROWS)].map((r) =>
    columns.map((_, i) => cell(r[i] ?? "")),
  );
  const widths = columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return [
    "    Examples:",
    ...all.map((r) => `      | ${r.map((v, i) => v.padEnd(widths[i] ?? 0)).join(" | ")} |`),
  ].join("\n");
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
