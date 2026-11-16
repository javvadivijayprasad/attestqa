import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { isSecretPath } from "../mcp/adapters/fs.js";
import { isRunReport } from "../skills/story-context.js";
import { buildKeywordIndex, type KeywordIndex } from "./bm25.js";
import { CHUNKER_VERSION, passagesOf, type Passage } from "./passages.js";
import { knowledgePathProblem } from "./paths.js";

/**
 * The index of a project's own documents (ADR-008 §4): built by `aqa index`,
 * read by the search tool, written by nothing else.
 *
 * Three rules shape this file.
 *
 * 1. It is derived. Everything here can be deleted and built again from the
 *    documents; the model writes none of it.
 * 2. Agent output is never indexed. The provenance filters exist because the
 *    agent twice read its own output back as fact (`isRunReport`,
 *    `isAgentBug`); an index that held a run report or a failure snapshot
 *    would be the same mistake with a search box on it.
 * 3. It is never rebuilt silently. `staleness` says the documents have moved
 *    on; rebuilding is a command a person runs, so what a run was told always
 *    has a record.
 */
export const KNOWLEDGE_DIR = "knowledge";
export const PASSAGES_FILE = "passages.jsonl";
export const KEYWORDS_FILE = "keywords.json";
export const KNOWLEDGE_MANIFEST = "manifest.json";

/** Markdown and plain text in 2.4.0; PDF and Word need a parser and come later. */
export const DOC_EXTENSIONS: readonly string[] = [".md", ".markdown", ".txt"];
export const MAX_DOC_BYTES = 2_000_000;

/**
 * Folders never walked: dependencies, version control, and everything this
 * runtime or the test runner writes — ledgers, reports, the defect profile,
 * Playwright's failure snapshots (`test-results/…/error-context.md` is
 * Markdown, and is tool output).
 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".aqa",
  ".aqa-report",
  ".aqa-profile",
  "test-results",
  "playwright-report",
]);

/** Files a generator writes about the agent's own features. */
const GENERATED_FILES = new Set(["bdd_review.md"]);

export interface KnowledgeManifest {
  tool: "attestqa";
  /** The attestqa that built it. */
  version: string;
  chunker: number;
  /** ISO 8601. */
  built: string;
  /** `agent.knowledge.paths` as configured. */
  paths: string[];
  files: Array<{ file: string; hash: string; modified: string; passages: number }>;
  passages: number;
  skipped: Array<{ file: string; why: string }>;
  /** sha256 of the two files beside this one, so a half-written index is seen. */
  hashes: { passages: string; keywords: string };
}

export interface Document {
  file: string;
  text: string;
  hash: string;
  modified: string;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const posix = (p: string): string => p.split(sep).join("/");

/**
 * The documents under the configured paths, in file order, and what was left
 * out and why. `problems` are the ones that stop a build: a path that is not
 * there, or a file named outright that cannot be indexed.
 */
export function collectDocuments(
  workspace: string,
  paths: readonly string[],
  ledgerRoot?: string,
): { documents: Document[]; skipped: Array<{ file: string; why: string }>; problems: string[] } {
  const root = resolve(workspace);
  const ledger = ledgerRoot ? resolve(ledgerRoot) : undefined;
  const documents = new Map<string, Document>();
  const skipped = new Map<string, string>();
  const problems: string[] = [];

  const take = (abs: string, named: boolean): void => {
    const file = posix(relative(root, abs));
    if (documents.has(file) || skipped.has(file)) return;
    const why = (reason: string): void => {
      if (named) problems.push(`${file}: ${reason}`);
      else skipped.set(file, reason);
    };
    if (!DOC_EXTENSIONS.includes(extname(abs).toLowerCase())) {
      // Under a folder, other kinds of file are simply not documents.
      if (named)
        problems.push(`${file}: not Markdown or plain text (${DOC_EXTENSIONS.join(", ")})`);
      return;
    }
    if (isSecretPath(file)) return why("a credential file by name");
    if (GENERATED_FILES.has((file.split("/").pop() ?? "").toLowerCase()))
      return why("written by the test generator, not a project document");
    const stat = lstatSync(abs);
    if (stat.size > MAX_DOC_BYTES) return why(`larger than ${MAX_DOC_BYTES} bytes`);
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) return why("not text");
    const text = bytes.toString("utf8");
    if (isRunReport(text)) return why("a run report written by attestqa");
    documents.set(file, {
      file,
      text,
      hash: sha256(bytes),
      modified: stat.mtime.toISOString(),
    });
  };

  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const abs = join(dir, e.name);
      // A link can point outside the workspace; it is not followed.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIPPED_DIRS.has(e.name.toLowerCase())) continue;
        if (ledger && resolve(abs) === ledger) continue;
        walk(abs);
      } else if (e.isFile()) take(abs, false);
    }
  };

  for (const p of paths) {
    const bad = knowledgePathProblem(p);
    if (bad) {
      problems.push(`"${p}" ${bad}`);
      continue;
    }
    const abs = resolve(root, p);
    // Named outright, a folder this runtime or the test runner writes is a
    // mistake to be told about, not a folder to skip quietly.
    const own = p.split(/[\\/]/).find((seg) => SKIPPED_DIRS.has(seg.toLowerCase()));
    if (own !== undefined || (ledger && (abs === ledger || abs.startsWith(ledger + sep)))) {
      problems.push(
        `"${p}" is ${own !== undefined ? `inside ${own}` : "the ledger"}, which is never indexed`,
      );
      continue;
    }
    if (!existsSync(abs)) {
      problems.push(`"${p}" is not in the workspace`);
      continue;
    }
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) problems.push(`"${p}" is a link, which is not followed`);
    else if (stat.isDirectory()) walk(abs);
    else take(abs, true);
  }
  return {
    documents: [...documents.values()].sort((a, b) => (a.file < b.file ? -1 : 1)),
    skipped: [...skipped.entries()]
      .map(([file, why]) => ({ file, why }))
      .sort((a, b) => (a.file < b.file ? -1 : 1)),
    problems,
  };
}

export type BuildResult =
  { ok: true; dir: string; manifest: KnowledgeManifest } | { ok: false; message: string };

export interface BuildOptions {
  workspace: string;
  ledgerRoot: string;
  paths: readonly string[];
  /** The attestqa version, for the manifest. */
  version: string;
  now?: Date;
}

/** Build the index and write it under `<ledger root>/knowledge/`. */
export function buildIndex(opts: BuildOptions): BuildResult {
  if (opts.paths.length === 0)
    return {
      ok: false,
      message:
        "no document folder is configured — add agent.knowledge.paths to the config " +
        '(for example paths: ["docs/requirements"])',
    };
  const { documents, skipped, problems } = collectDocuments(
    opts.workspace,
    opts.paths,
    opts.ledgerRoot,
  );
  if (problems.length > 0)
    return { ok: false, message: `agent.knowledge.paths: ${problems.join("; ")}` };

  const passages: Passage[] = [];
  const files: KnowledgeManifest["files"] = [];
  for (const d of documents) {
    const own = passagesOf(d.file, d.text, d.modified, extname(d.file).toLowerCase() !== ".txt");
    passages.push(...own);
    files.push({ file: d.file, hash: d.hash, modified: d.modified, passages: own.length });
  }
  if (passages.length === 0)
    return {
      ok: false,
      message:
        `nothing to index under ${opts.paths.join(", ")} — ` +
        `no ${DOC_EXTENSIONS.join(" / ")} file with text in it` +
        (skipped.length > 0 ? ` (${skipped.length} left out)` : ""),
    };

  const passagesText = passages.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const keywordsText = JSON.stringify(buildKeywordIndex(passages)) + "\n";
  const manifest: KnowledgeManifest = {
    tool: "attestqa",
    version: opts.version,
    chunker: CHUNKER_VERSION,
    built: (opts.now ?? new Date()).toISOString(),
    paths: [...opts.paths],
    files,
    passages: passages.length,
    skipped,
    hashes: { passages: sha256(passagesText), keywords: sha256(keywordsText) },
  };

  const dir = join(resolve(opts.ledgerRoot), KNOWLEDGE_DIR);
  mkdirSync(dir, { recursive: true });
  // The manifest is written last and removed first: an index without one is
  // not an index, so a build that stops half-way leaves nothing to trust.
  rmSync(join(dir, KNOWLEDGE_MANIFEST), { force: true });
  writeFileSync(join(dir, PASSAGES_FILE), passagesText, "utf8");
  writeFileSync(join(dir, KEYWORDS_FILE), keywordsText, "utf8");
  writeFileSync(join(dir, KNOWLEDGE_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { ok: true, dir, manifest };
}

export type ReadResult =
  | { ok: true; manifest: KnowledgeManifest; passages: Passage[]; keywords: KeywordIndex }
  | { ok: false; message: string };

/** Read an index back, refusing one that is missing, half-written or from another chunker. */
export function readIndex(ledgerRoot: string): ReadResult {
  const dir = join(resolve(ledgerRoot), KNOWLEDGE_DIR);
  const at = (name: string): string => join(dir, name);
  if (!existsSync(at(KNOWLEDGE_MANIFEST)))
    return { ok: false, message: `no document index at ${dir} — run "aqa index" first` };
  const again = 'run "aqa index" again';
  try {
    const manifest = JSON.parse(readFileSync(at(KNOWLEDGE_MANIFEST), "utf8")) as KnowledgeManifest;
    if (manifest.chunker !== CHUNKER_VERSION)
      return {
        ok: false,
        message: `the document index was built by attestqa ${manifest.version}, which cut passages differently — ${again}`,
      };
    const passagesText = readFileSync(at(PASSAGES_FILE), "utf8");
    const keywordsText = readFileSync(at(KEYWORDS_FILE), "utf8");
    if (
      sha256(passagesText) !== manifest.hashes.passages ||
      sha256(keywordsText) !== manifest.hashes.keywords
    )
      return {
        ok: false,
        message: `the document index at ${dir} does not match its manifest — ${again}`,
      };
    const passages = passagesText
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Passage);
    return { ok: true, manifest, passages, keywords: JSON.parse(keywordsText) as KeywordIndex };
  } catch (e) {
    return {
      ok: false,
      message: `the document index at ${dir} cannot be read (${(e as Error).message}) — ${again}`,
    };
  }
}

export interface Staleness {
  changed: string[];
  removed: string[];
  added: string[];
}

/**
 * How the documents differ from what the index was built from. Compared by
 * content hash, so a file saved again unchanged is not a difference.
 */
export function staleness(
  manifest: KnowledgeManifest,
  workspace: string,
  ledgerRoot?: string,
): Staleness {
  const { documents } = collectDocuments(workspace, manifest.paths, ledgerRoot);
  const now = new Map(documents.map((d) => [d.file, d.hash]));
  const then = new Map(manifest.files.map((f) => [f.file, f.hash]));
  return {
    changed: [...then.keys()].filter((f) => now.has(f) && now.get(f) !== then.get(f)),
    removed: [...then.keys()].filter((f) => !now.has(f)),
    added: [...now.keys()].filter((f) => !then.has(f)),
  };
}

export function isStale(s: Staleness): boolean {
  return s.changed.length + s.removed.length + s.added.length > 0;
}

/** What `aqa index` prints. */
export function renderIndex(result: Extract<BuildResult, { ok: true }>): string {
  const m = result.manifest;
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
  const out = [
    `Indexed ${plural(m.passages, "passage")} from ${plural(m.files.length, "file")} into ${result.dir}`,
    ...m.files.map((f) => `  ${f.file}  (${plural(f.passages, "passage")})`),
  ];
  if (m.skipped.length > 0) {
    out.push(`Left out ${plural(m.skipped.length, "file")}:`);
    out.push(...m.skipped.map((s) => `  ${s.file}  — ${s.why}`));
  }
  const empty = m.files.filter((f) => f.passages === 0);
  if (empty.length > 0)
    out.push(`${plural(empty.length, "file")} had no text to index (headings only, or empty).`);
  out.push("The index is not rebuilt by itself: run aqa index again after the documents change.");
  return out.join("\n") + "\n";
}
