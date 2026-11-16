import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentConfigFromObject, ConfigError } from "../src/config.js";
import { main } from "../src/cli.js";
import { buildKeywordIndex, queryTerms, searchKeywords, tokens } from "../src/knowledge/bm25.js";
import {
  buildIndex,
  collectDocuments,
  isStale,
  KEYWORDS_FILE,
  KNOWLEDGE_DIR,
  KNOWLEDGE_MANIFEST,
  PASSAGES_FILE,
  readIndex,
  staleness,
} from "../src/knowledge/build.js";
import {
  CHUNKER_VERSION,
  headingSlug,
  PASSAGE_CHARS,
  passagesOf,
} from "../src/knowledge/passages.js";

/**
 * `aqa index`: the project's own documents, cut into passages and ranked by
 * keyword (ADR-008 §4). The first slice of 2.4.0 — nothing reads the index in
 * a run yet.
 *
 * The document below is the one the design was written about: Booker's story
 * says a phone number "shorter than the allowed length" is refused and never
 * gives the length. The length is in the project's validation rules.
 */
const RULES = [
  "# Contact form",
  "",
  "Rules for the form on the home page.",
  "",
  "## Phone",
  "",
  "Phone must be between 11 and 21 characters.",
  "",
  "## Email",
  "",
  "Email must be a well-formed address.",
  "",
  "```",
  "# not a heading: this is inside a code block",
  "",
  "name@example.test",
  "```",
  "",
  "## Subject ##",
  "",
  "Subject must be between 5 and 100 characters.",
  "",
  "## Reserved",
  "",
].join("\n");

const WHEN = "2026-11-16T10:00:00.000Z";

describe("a document cut into passages", () => {
  const passages = passagesOf("docs/rules.md", RULES, WHEN);

  it("is cut at its headings, each passage knowing where it came from", () => {
    expect(passages.map((p) => p.heading.join(" > "))).toEqual([
      "Contact form",
      "Contact form > Phone",
      "Contact form > Email",
      "Contact form > Subject",
    ]);
    const phone = passages[1]!;
    expect(phone.text).toBe("Phone must be between 11 and 21 characters.");
    expect(phone.lines).toEqual([7, 7]);
    expect(phone.modified).toBe(WHEN);
    expect(phone.file).toBe("docs/rules.md");
  });

  it("keeps a code block whole, and a # inside it is not a heading", () => {
    const email = passages[2]!;
    expect(email.text).toContain("# not a heading");
    expect(email.text).toContain("name@example.test");
    expect(email.lines).toEqual([11, 17]);
  });

  it("gives no passage for a heading with nothing under it", () => {
    expect(passages.some((p) => p.heading.includes("Reserved"))).toBe(false);
  });

  it("names a passage by file, heading and content, so a changed text is a new id", () => {
    const phone = passages[1]!;
    expect(phone.id).toBe(`docs/rules.md#phone@${phone.hash.slice(0, 8)}`);
    expect(phone.id).toMatch(/^docs\/rules\.md#phone@[0-9a-f]{8}$/);
    const edited = passagesOf("docs/rules.md", RULES.replace("11 and 21", "10 and 20"), WHEN);
    expect(edited[1]!.id).not.toBe(phone.id);
    // Everything that did not change keeps its id: a citation survives a rebuild.
    expect(edited[0]!.id).toBe(passages[0]!.id);
    expect(edited[3]!.id).toBe(passages[3]!.id);
    // Line endings and a byte-order mark are not content.
    const windows = passagesOf("docs/rules.md", "\uFEFF" + RULES.replace(/\n/g, "\r\n"), WHEN);
    expect(windows.map((p) => p.id)).toEqual(passages.map((p) => p.id));
  });

  it("slugs a heading, and calls the text before the first one 'top'", () => {
    expect(headingSlug("3.2 Phone & e-mail (EU)")).toBe("3-2-phone-e-mail-eu");
    expect(passagesOf("a.md", "Just words.", WHEN)[0]!.id).toMatch(/^a\.md#top@/);
    expect(passagesOf("a.md", "# C# notes\n\nWords.", WHEN)[0]!.heading).toEqual(["C# notes"]);
  });

  it("treats plain text as one section: a # there is a line, not a heading", () => {
    const txt = passagesOf("notes.txt", "# 1 of 3\n\nThe limit is 21.", WHEN, false);
    expect(txt).toHaveLength(1);
    expect(txt[0]!.heading).toEqual([]);
    expect(txt[0]!.text).toBe("# 1 of 3\n\nThe limit is 21.");
  });

  it("cuts a long section between paragraphs, a long paragraph between lines, a long line at a space", () => {
    const para = (n: number) => `Paragraph ${n}. ` + "word ".repeat(120).trim();
    const long = ["# Long", "", para(1), "", para(2), "", para(3)].join("\n");
    const cut = passagesOf("long.md", long, WHEN);
    expect(cut.length).toBe(3);
    for (const p of cut) expect(p.text.length).toBeLessThanOrEqual(PASSAGE_CHARS);
    expect(cut.map((p) => p.lines)).toEqual([
      [3, 3],
      [5, 5],
      [7, 7],
    ]);

    const table = [
      "# T",
      "",
      ...Array.from({ length: 60 }, (_, i) => `| row ${i} | ${"x".repeat(40)} |`),
    ];
    const rows = passagesOf("t.md", table.join("\n"), WHEN);
    expect(rows.length).toBeGreaterThan(1);
    for (const p of rows) expect(p.text.length).toBeLessThanOrEqual(PASSAGE_CHARS);
    expect(rows[0]!.lines[0]).toBe(3);
    expect(rows[rows.length - 1]!.lines[1]).toBe(62);
    // Nothing is lost at a cut.
    expect(rows.map((p) => p.text).join("\n")).toBe(table.slice(2).join("\n"));

    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const line = passagesOf("l.md", words, WHEN);
    expect(line.length).toBeGreaterThan(2);
    for (const p of line) expect(p.text.length).toBeLessThanOrEqual(PASSAGE_CHARS);
    expect(line.map((p) => p.text).join(" ")).toBe(words);
    expect(line.every((p) => p.lines[0] === 1 && p.lines[1] === 1)).toBe(true);
  });
});

describe("keyword ranking", () => {
  const passages = passagesOf("docs/rules.md", RULES, WHEN);
  const index = buildKeywordIndex(passages);

  it("splits text into lower-case words and numbers, nothing cleverer", () => {
    expect(tokens("Phone: 11–21 characters (E.164)!")).toEqual([
      "phone",
      "11",
      "21",
      "characters",
      "e",
      "164",
    ]);
    expect(tokens("")).toEqual([]);
  });

  it("finds the passage that states the value the story left out", () => {
    const hits = searchKeywords(index, "allowed length of the phone number");
    expect(hits[0]?.id).toBe(passages[1]!.id);
    expect(hits[0]?.rank).toBe(1);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("searches a passage by its headings too", () => {
    // "contact" is in no passage's text below the top one, only in the heading path.
    const hits = searchKeywords(index, "contact subject");
    expect(hits[0]?.id).toBe(passages[3]!.id);
    expect(hits.length).toBe(4);
  });

  it("drops function words from a query, unless it has nothing else", () => {
    expect(queryTerms("What is the allowed length of the phone number?")).toEqual([
      "allowed",
      "length",
      "number",
      "phone",
    ]);
    expect(queryTerms("to be or not to be")).toEqual(["not"]);
    expect(queryTerms("what is it")).toEqual(["is", "it", "what"]);
    // The documents keep every word: a quote is found as it was written.
    expect(searchKeywords(index, "the").length).toBeGreaterThan(0);
  });

  it("returns nothing for words no document has, and respects the limit", () => {
    expect(searchKeywords(index, "refund policy")).toEqual([]);
    expect(searchKeywords(index, "")).toEqual([]);
    expect(searchKeywords(index, "must be between", 1)).toHaveLength(1);
    expect(searchKeywords(buildKeywordIndex([]), "phone")).toEqual([]);
  });

  it("scores by the formula on the page", () => {
    // Two passages, one word each way: checked by hand.
    const two = buildKeywordIndex([
      { ...passages[1]!, id: "a", heading: [], text: "alpha beta" },
      { ...passages[1]!, id: "b", heading: [], text: "alpha alpha gamma delta" },
    ]);
    const [first, second] = searchKeywords(two, "alpha");
    const idf = Math.log(1 + (2 - 2 + 0.5) / (2 + 0.5));
    const score = (tf: number, len: number) =>
      (idf * tf * 2.2) / (tf + 1.2 * (1 - 0.75 + (0.75 * len) / 3));
    expect(first).toEqual({ id: "b", rank: 1, score: score(2, 4) });
    expect(second).toEqual({ id: "a", rank: 2, score: score(1, 2) });
  });

  it("orders equal scores by passage id, whatever order they were indexed in", () => {
    const twin = (id: string) => ({ ...passages[1]!, id, heading: [], text: "same words here" });
    const forward = searchKeywords(buildKeywordIndex([twin("b"), twin("a"), twin("c")]), "words");
    const backward = searchKeywords(buildKeywordIndex([twin("c"), twin("a"), twin("b")]), "words");
    expect(forward.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(backward).toEqual(forward);
  });

  it("is not confused by a word that is also a property of every object", () => {
    const odd = buildKeywordIndex([
      { ...passages[1]!, id: "x", heading: [], text: "constructor toString __proto__" },
    ]);
    expect(searchKeywords(odd, "constructor").map((h) => h.id)).toEqual(["x"]);
    expect(searchKeywords(odd, "hasOwnProperty")).toEqual([]);
  });
});

describe("the index on disk", () => {
  let ws: string;
  let ledger: string;
  const put = (rel: string, text: string | Buffer): void => {
    const abs = join(ws, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  };
  const build = (paths: string[]) =>
    buildIndex({ workspace: ws, ledgerRoot: ledger, paths, version: "2.4.0-test" });

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "aqa-index-"));
    ledger = join(ws, ".aqa");
    put("docs/rules.md", RULES);
    put("docs/notes.txt", "Bookings are held for 15 minutes.");
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("is three files, and reads back as it was written", () => {
    const built = build(["docs"]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const dir = join(ledger, KNOWLEDGE_DIR);
    expect(built.dir).toBe(dir);
    for (const f of [PASSAGES_FILE, KEYWORDS_FILE, KNOWLEDGE_MANIFEST])
      expect(existsSync(join(dir, f)), f).toBe(true);
    expect(built.manifest).toMatchObject({
      tool: "attestqa",
      version: "2.4.0-test",
      chunker: CHUNKER_VERSION,
      paths: ["docs"],
      passages: 5,
      skipped: [],
    });
    expect(built.manifest.files.map((f) => [f.file, f.passages])).toEqual([
      ["docs/notes.txt", 1],
      ["docs/rules.md", 4],
    ]);

    const read = readIndex(ledger);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.passages).toHaveLength(5);
    expect(searchKeywords(read.keywords, "how long is a booking held")[0]?.id).toMatch(
      /^docs\/notes\.txt#top@/,
    );
    // One passage per line, each a whole JSON object.
    const lines = readFileSync(join(dir, PASSAGES_FILE), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0]!)).toHaveProperty("id");
  });

  it("gives the same passages and the same index for the same documents", () => {
    build(["docs"]);
    const dir = join(ledger, KNOWLEDGE_DIR);
    const first = [PASSAGES_FILE, KEYWORDS_FILE].map((f) => readFileSync(join(dir, f), "utf8"));
    build(["docs", "docs/rules.md"]);
    const again = [PASSAGES_FILE, KEYWORDS_FILE].map((f) => readFileSync(join(dir, f), "utf8"));
    expect(again).toEqual(first);
  });

  it("never indexes what the agent or the test runner wrote", () => {
    put("docs/run.md", "## agentic-qa run 20261115T142723Z\n\nPhone must be 1 character.");
    put("docs/test-results/a/error-context.md", "# Page snapshot\n\nPhone must be 2 characters.");
    put("docs/.aqa-report/qa.md", "# QA record\n\nPhone must be 3 characters.");
    put("docs/node_modules/x/README.md", "# x\n\nPhone must be 4 characters.");
    put("docs/BDD_REVIEW.md", "# Review\n\nPhone must be 5 characters.");
    put(".aqa/runs/r/notes.md", "# notes\n\nPhone must be 6 characters.");
    put("docs/tool.ts", "// Phone must be 7 characters.");
    put("docs/blob.md", Buffer.from([35, 32, 0, 1, 2]));
    for (const own of [".aqa", "docs/test-results", "docs/node_modules/x"]) {
      const named = build([own]);
      expect(!named.ok && named.message, own).toContain("which is never indexed");
    }
    const built = build(["docs"]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.manifest.files.map((f) => f.file)).toEqual(["docs/notes.txt", "docs/rules.md"]);
    expect(built.manifest.skipped).toEqual([
      { file: "docs/BDD_REVIEW.md", why: "written by the test generator, not a project document" },
      { file: "docs/blob.md", why: "not text" },
      { file: "docs/run.md", why: "a run report written by attestqa" },
    ]);
    const read = readIndex(ledger);
    expect(read.ok && read.passages.every((p) => !/Phone must be \d character/.test(p.text))).toBe(
      true,
    );
  });

  it("stops, and writes nothing, when a path is wrong", () => {
    const missing = build(["docs", "specs"]);
    expect(missing).toEqual({
      ok: false,
      message: 'agent.knowledge.paths: "specs" is not in the workspace',
    });
    put("docs/schema.sql", "CREATE TABLE t (id INTEGER);");
    const wrongKind = build(["docs/schema.sql"]);
    expect(!wrongKind.ok && wrongKind.message).toContain(
      "docs/schema.sql: not Markdown or plain text",
    );
    const outside = build(["../elsewhere"]);
    expect(!outside.ok && outside.message).toContain("must stay inside the workspace");
    put("empty/readme.md", "# Only a heading\n");
    const nothing = build(["empty"]);
    expect(!nothing.ok && nothing.message).toContain("nothing to index under empty");
    const none = build([]);
    expect(!none.ok && none.message).toContain("add agent.knowledge.paths");
    expect(existsSync(join(ledger, KNOWLEDGE_DIR))).toBe(false);
  });

  it("says when the documents have moved on, and is not fooled by a file saved unchanged", () => {
    const built = build(["docs"]);
    if (!built.ok) throw new Error(built.message);
    expect(isStale(staleness(built.manifest, ws, ledger))).toBe(false);
    put("docs/rules.md", RULES);
    expect(isStale(staleness(built.manifest, ws, ledger))).toBe(false);

    put("docs/rules.md", RULES.replace("11 and 21", "10 and 20"));
    put("docs/new.md", "# New\n\nA new rule.");
    rmSync(join(ws, "docs/notes.txt"));
    expect(staleness(built.manifest, ws, ledger)).toEqual({
      changed: ["docs/rules.md"],
      removed: ["docs/notes.txt"],
      added: ["docs/new.md"],
    });
  });

  it("refuses an index that is missing, half-written or cut by another chunker", () => {
    expect(readIndex(ledger)).toMatchObject({ ok: false });
    expect((readIndex(ledger) as { message: string }).message).toContain('run "aqa index" first');
    build(["docs"]);
    const dir = join(ledger, KNOWLEDGE_DIR);
    const manifest = readFileSync(join(dir, KNOWLEDGE_MANIFEST), "utf8");

    writeFileSync(join(dir, PASSAGES_FILE), "{}\n");
    expect((readIndex(ledger) as { message: string }).message).toContain(
      "does not match its manifest",
    );

    build(["docs"]);
    writeFileSync(
      join(dir, KNOWLEDGE_MANIFEST),
      manifest.replace(`"chunker": ${CHUNKER_VERSION}`, '"chunker": 0'),
    );
    expect((readIndex(ledger) as { message: string }).message).toContain(
      "cut passages differently",
    );
  });

  it("collects each document once, in file order", () => {
    const { documents, problems } = collectDocuments(ws, ["docs/rules.md", "docs"], ledger);
    expect(problems).toEqual([]);
    expect(documents.map((d) => d.file)).toEqual(["docs/notes.txt", "docs/rules.md"]);
  });

  describe("aqa index", () => {
    const run = async (args: string[]) => {
      let out = "";
      let err = "";
      const code = await main(args, { out: (s) => (out += s), err: (s) => (err += s) });
      return { code, out, err };
    };
    const config = (knowledge: unknown): string => {
      const file = join(ws, "ai-quality.config.json");
      // A provider no plug-in is installed for: the command reads one key and
      // must not need the rest of the config to be loadable.
      writeFileSync(
        file,
        JSON.stringify({
          agent: {
            model: { provider: "bedrock", name: "x" },
            scope: { work_items: ["1"] },
            ...(knowledge === undefined ? {} : { knowledge }),
          },
        }),
      );
      return file;
    };

    it("builds the index and says what it made", async () => {
      const r = await run([
        "index",
        "--config",
        config({ paths: ["docs"] }),
        "--workspace",
        ws,
        "--ledger",
        ledger,
      ]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain("Indexed 5 passages from 2 files into");
      expect(r.out).toContain("docs/rules.md  (4 passages)");
      expect(r.out).toContain("run aqa index again after the documents change");
      expect(readIndex(ledger).ok).toBe(true);
    });

    it("exits 1 with the reason when nothing is configured, or the config is wrong", async () => {
      const flags = ["--workspace", ws, "--ledger", ledger];
      const none = await run(["index", "--config", config(undefined), ...flags]);
      expect(none.code).toBe(1);
      expect(none.err).toContain("no document folder is configured");

      const unknown = await run([
        "index",
        "--config",
        config({ paths: ["docs"], embedder: "x" }),
        ...flags,
      ]);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain('agent.knowledge has unknown key "embedder"');

      expect((await run(["index", ...flags])).err).toContain("--config");
      const absent = await run(["index", "--config", join(ws, "nope.yaml"), ...flags]);
      expect(absent.code).toBe(1);
      expect(absent.err).toContain("config file not found");
      expect(existsSync(join(ledger, KNOWLEDGE_DIR))).toBe(false);
    });
  });
});

describe("agent.knowledge in the config", () => {
  const base = { model: "claude-sonnet-4-6", scope: { work_items: ["1"] } };
  const load = (knowledge?: unknown) =>
    agentConfigFromObject({
      agent: { ...base, ...(knowledge === undefined ? {} : { knowledge }) },
    });

  it("is absent unless set, so a config without it is the config it always was", () => {
    const without = load();
    expect("knowledge" in without).toBe(false);
    expect(JSON.stringify(without)).not.toContain("knowledge");
    expect(load({ paths: ["docs", " specs/rules.md "] }).knowledge).toEqual({
      paths: ["docs", "specs/rules.md"],
    });
  });

  it("refuses a path outside the workspace, an empty list and an unknown key", () => {
    for (const bad of [
      { paths: ["../shared"] },
      { paths: ["C:\\docs"] },
      { paths: ["/etc/docs"] },
      { paths: [] },
      { paths: [""] },
      { paths: "docs" },
      { path: ["docs"] },
      ["docs"],
    ])
      expect(() => load(bad), JSON.stringify(bad)).toThrow(ConfigError);
  });
});
