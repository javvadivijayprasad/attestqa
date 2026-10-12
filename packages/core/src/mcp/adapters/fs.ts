import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";

/**
 * In-process `fs` adapter: read / list / write strictly inside the job
 * workspace. Any path that resolves outside the workspace is refused here,
 * before the gate even sees it — defence in depth (design §5).
 */
export class FsTools implements ToolClient {
  readonly server = "fs";
  private readonly root: string;

  constructor(workspaceDir: string) {
    this.root = resolve(workspaceDir);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const path = { type: "string", description: "Path relative to the workspace root" };
    return [
      {
        server: this.server,
        name: "read_file",
        description:
          "Read a UTF-8 text file inside the workspace (max 200 KB). A long file comes back " +
          "truncated; when that happens, ask again for the part you need with `fromLine`/`toLine` " +
          "— the result always says how many lines the file has. Reading a RANGE you have not " +
          "read yet is always allowed; asking for the same view twice is not.",
        inputSchema: {
          type: "object",
          properties: {
            path,
            fromLine: {
              type: "integer",
              description: "First line to return, 1-based and inclusive. Omit for the whole file.",
            },
            toLine: {
              type: "integer",
              description: "Last line to return, 1-based and inclusive. Omit to read to the end.",
            },
          },
          required: ["path"],
        },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "list_dir",
        description: "List files and directories inside the workspace.",
        inputSchema: { type: "object", properties: { path: { ...path, default: "." } } },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "write_file",
        description:
          "Write a UTF-8 text file inside the workspace, creating directories as needed.",
        inputSchema: {
          type: "object",
          properties: { path, content: { type: "string" } },
          required: ["path", "content"],
        },
        policyClass: "write_workspace",
      },
      {
        server: this.server,
        name: "replace_in_file",
        description:
          "Change ONE piece of a file in place: replaces `old` with `new`, and only when `old` " +
          "occurs exactly once. Use this for a surgical edit — a locator, a single line — rather " +
          "than rewriting the whole file, which loses whatever was not reproduced. Include enough " +
          "surrounding text in `old` to make it unique; the call is refused if it matches twice or " +
          "not at all, and nothing is written. To change the SAME text everywhere it appears (one " +
          "selector used by several tests), pass `all: true` with `old` as short as the change " +
          'itself — e.g. old `name: "Log in" }` → new `name: "Login" }`.',
        inputSchema: {
          type: "object",
          properties: {
            path,
            old: { type: "string", description: "The exact text to replace. Must occur once." },
            new: { type: "string", description: "What to put in its place." },
            all: {
              type: "boolean",
              description: "Replace every occurrence instead of requiring exactly one.",
            },
          },
          required: ["path", "old", "new"],
        },
        policyClass: "write_workspace",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`not an fs tool: ${server}.${name}`);
    const rel =
      typeof args["path"] === "string" ? args["path"] : name === "list_dir" ? "." : undefined;
    if (rel === undefined) return fail(`"path" is required`);
    const abs = this.inside(rel);
    if (!abs) return fail(`path escapes the workspace: ${rel}`);
    if (name !== "list_dir" && isSecretPath(rel)) return fail(secretRefusal(rel));

    switch (name) {
      case "read_file": {
        if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`no such file: ${rel}`);
        if (statSync(abs).size > 200 * 1024) return fail(`file too large (>200 KB): ${rel}`);
        const all = readFileSync(abs, "utf8");

        // A window on the file, so that "the truncation is blocking me" has an
        // answer other than reading the same 2,000 characters again.
        //
        // 20260928T082428Z: the spec came back truncated, the re-read was
        // refused (correctly — it would have returned the same view), and the
        // agent said "the spec file was truncated, so I haven't seen the test
        // bodies" and then reasoned about the tests from the feature file
        // instead, arriving at the wrong artefact and the wrong conclusion. A
        // refusal that leaves the agent with less evidence manufactures the
        // mistake it was meant to prevent.
        const lines = all.split("\n");
        const from = intArg(args["fromLine"]);
        const to = intArg(args["toLine"]);
        if (from === undefined && to === undefined)
          return {
            ok: true,
            result: { path: rel, lines: lines.length, content: all },
            artefacts: [],
          };
        const start = Math.max(1, from ?? 1);
        const end = Math.min(lines.length, to ?? lines.length);
        if (start > lines.length)
          return fail(`${rel} has ${lines.length} line(s); fromLine ${start} is past the end.`);
        if (end < start) return fail(`toLine (${end}) is before fromLine (${start}).`);
        return {
          ok: true,
          result: {
            path: rel,
            lines: lines.length,
            fromLine: start,
            toLine: end,
            content: lines.slice(start - 1, end).join("\n"),
          },
          artefacts: [],
        };
      }
      case "list_dir": {
        if (!existsSync(abs) || !statSync(abs).isDirectory())
          return fail(`no such directory: ${rel}`);
        const all = readdirSync(abs, { withFileTypes: true });
        const entries = all
          .filter((d) => !isSecretName(d.name))
          .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }))
          .sort((a, b) => a.name.localeCompare(b.name));
        // Named as a count, not as names. The agent needs to know the listing
        // is not the whole directory — otherwise it reasons about a workspace
        // that does not exist — but naming the files it may not read is an
        // invitation to try, and the refusal message would then carry the
        // filename into the ledger repeatedly.
        const hidden = all.length - entries.length;
        return {
          ok: true,
          result:
            hidden > 0
              ? { path: rel, entries, hiddenCredentialFiles: hidden }
              : { path: rel, entries },
          artefacts: [],
        };
      }
      case "write_file": {
        const content = args["content"];
        if (typeof content !== "string") return fail(`"content" must be a string`);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        return {
          ok: true,
          result: { path: rel, bytes: Buffer.byteLength(content, "utf8") },
          artefacts: [rel],
        };
      }
      case "replace_in_file": {
        // One occurrence, or nothing happens.
        //
        // The healer had only whole-file writes, so changing one locator in a
        // 500-line spec meant reproducing 500 lines from a truncated view of
        // them — and its rewrite quietly dropped assertions, which the write
        // rules then refused, four times in a row (20260925T225632Z). The
        // model said so itself: "the truncation is blocking me". A tool that
        // edits in place removes both the drift and the refusal.
        const before = args["old"];
        const after = args["new"];
        if (typeof before !== "string" || typeof after !== "string")
          return fail(`"old" and "new" must both be strings`);
        if (before.length === 0) return fail(`"old" must not be empty`);
        if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`no such file: ${rel}`);
        const text = readFileSync(abs, "utf8");
        const hits = text.split(before).length - 1;
        const every = args["all"] === true;
        if (hits === 0)
          return fail(
            `"old" does not appear in ${rel}. Copy the text exactly as it is — including ` +
              "indentation and quotes, and with no backslashes the file does not have. " +
              nearest(text, before) +
              "A shorter `old` (the changed line alone, or just the changed words with `all: true`) " +
              "is easier to get right than a block.",
          );
        if (hits > 1 && !every)
          return fail(
            `"old" appears ${hits} times in ${rel}, so this edit is ambiguous and nothing was ` +
              "written. Include the surrounding lines to make it unique.",
          );
        const next = every ? text.split(before).join(after) : text.replace(before, after);
        writeFileSync(abs, next, "utf8");
        return {
          ok: true,
          result: {
            path: rel,
            replaced: every ? hits : 1,
            bytes: Buffer.byteLength(next, "utf8"),
            // So a later rule, and a reader, can see what changed without a diff.
            was: head(before, 200),
            now: head(after, 200),
          },
          artefacts: [rel],
        };
      }
      default:
        return fail(`unknown fs tool: ${name}`);
    }
  }

  /** Resolve `rel` under the root; return undefined if it escapes. */
  inside(rel: string): string | undefined {
    const abs = resolve(this.root, rel);
    const r = relative(this.root, abs);
    if (r === "") return abs;
    if (r.startsWith("..") || r.split(sep)[0] === ".." || resolve(abs) !== abs) return undefined;
    return abs;
  }
}

/**
 * Credential files, refused by NAME before anything reads them.
 *
 * ── Why this exists ──
 * Run 20260918T221233Z, event 33: the agent called `fs.read_file` on `.env`
 * and got it. The whole file — model key, Azure DevOps PAT, application
 * password — went into the ledger in plaintext, where it stayed, because a
 * ledger is append-only by design.
 *
 * Nothing malfunctioned. The skill tells the agent to take its test account
 * from `AQA_APP_USER` and `AQA_APP_PASS`, so it went looking for the file that
 * defines them: a correct inference from the instructions it was given.
 * `read_file` is policy class `read`, which the default policy EXECUTES, so no
 * gate saw it and no human was asked.
 *
 * That is the argument for removing the capability rather than governing it.
 * A policy says what is allowed and can be set wrong, in a config file, by
 * someone in a hurry; this list is a path the process does not have. The
 * agent never needs these files — the two variable names it may use are in the
 * skill text, and their VALUES reach the tests through the Playwright config's
 * `process.env`, never through the model's context.
 *
 * Refusal covers writing as well as reading: an agent that cannot read `.env`
 * but can overwrite it can still destroy a working checkout, and "write the
 * credentials somewhere I can read them" is a path this closes on the way.
 */
const SECRET_FILES = new Set([
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SECRET_PATTERNS: readonly RegExp[] = [
  // Every .env variant, including `.env.example`. Allowing the example file
  // would be defensible — it is meant to be committed and to hold no real
  // values — but it is exactly the kind of exception that quietly stops being
  // true the day someone pastes a working token into it "just to test". The
  // agent loses nothing: the variable names it may use are named in the skill.
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
];

function isSecretName(name: string): boolean {
  if (SECRET_FILES.has(name.toLowerCase())) return true;
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/** True when the LAST segment of `rel` names a credential file. */
export function isSecretPath(rel: string): boolean {
  const last = rel.split(/[\\/]/).filter(Boolean).pop();
  return last !== undefined && isSecretName(last);
}

function secretRefusal(rel: string): string {
  return (
    `refused: ${rel} is a credential file, and the fs tool cannot read or write one. ` +
    `Do not look for credentials on disk. A test account reaches the suite through the ` +
    `Playwright config, which reads process.env["AQA_APP_USER"] and ` +
    `process.env["AQA_APP_PASS"] at run time — a spec refers to those names and never ` +
    `to their values, which is why you do not need to know them.`
  );
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}

/** First `n` characters, marked when there was more. */
function head(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** A line number from the model, or nothing. Floats and junk are ignored, not guessed at. */
function intArg(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * Where the first line of a failed `old` most nearly appears, so the next try
 * copies the file instead of the model's memory of it. 20261012T205658Z: seven
 * edits in a row missed — paraphrased step titles, `\\"` where the file has `"`
 * — and the agent re-read the same lines until the run stopped.
 */
export function nearest(text: string, old: string): string {
  const first =
    old
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  if (!first) return "";
  const lines = text.split("\n");
  const unescaped = first.replace(/\\(["'`])/g, "$1");
  const words = new Set(
    unescaped
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  let best = -1;
  let score = 0;
  lines.forEach((l, i) => {
    const mine = l.toLowerCase().split(/\W+/);
    const n = mine.filter((w) => words.has(w)).length;
    if (n > score) {
      score = n;
      best = i;
    }
  });
  if (best < 0 || score < 2) return "";
  const hint = unescaped !== first ? "Your `old` escapes quotes the file does not escape. " : "";
  return `${hint}The closest line is ${best + 1}: ${JSON.stringify(lines[best]?.trim() ?? "")}. `;
}
