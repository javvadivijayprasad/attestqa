import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex, readIndex } from "../src/knowledge/build.js";
import { parseGold } from "../src/report/eval-gold.js";
import { evalRetrieval, type RetrievalResult } from "../src/report/eval-retrieval.js";

/**
 * The release check of ADR-008 §7: the retrieval level of the gold sets, run
 * on the documents kept beside them. It builds the index the way `aqa index`
 * does and puts every gold question to the search. No model, no network, the
 * same numbers every time — so it runs with the other tests, in preflight and
 * in CI, and a change to the chunker or the search that loses an answer fails
 * here before any paid run.
 */
const EVAL = join(__dirname, "..", "examples", "eval");
const APPS = ["booker", "saucedemo", "toolshop"] as const;
/** The agreed bar (12 Nov 2026): the answer is in the first five for at least 85%. */
const HIT_AT_5 = 0.85;

const ledgers: string[] = [];
afterAll(() => ledgers.forEach((d) => rmSync(d, { recursive: true, force: true })));

function score(app: string): { result: RetrievalResult; files: string[]; goldText: string } {
  const goldText = readFileSync(join(EVAL, `${app}.gold.json`), "utf8");
  const gold = parseGold(JSON.parse(goldText), `${app}.gold.json`);
  const ledger = mkdtempSync(join(tmpdir(), `aqa-gold-${app}-`));
  ledgers.push(ledger);
  const built = buildIndex({
    workspace: join(EVAL, "documents", app),
    ledgerRoot: ledger,
    paths: ["docs"],
    version: "test",
  });
  if (!built.ok) throw new Error(built.message);
  const index = readIndex(ledger);
  if (!index.ok) throw new Error(index.message);
  return {
    result: evalRetrieval(gold.retrieval, index.keywords),
    files: built.manifest.files.map((f) => f.file),
    goldText,
  };
}

describe.each(APPS)("the gold set of %s", (app) => {
  const { result, files, goldText } = score(app);

  it("names only passages its documents hold", () => {
    expect(result.goldOutOfStep).toEqual([]);
  });

  it("finds the answer in the first five for at least 85% of the answerable questions", () => {
    const misses = result.results.filter((r) => r.category !== "unanswerable" && !r.hit);
    expect(
      result.hitAt5.rate,
      `missed: ${misses.map((m) => m.id).join(", ")}`,
    ).toBeGreaterThanOrEqual(HIT_AT_5);
  });

  it("has a question of each kind its documents can ask", () => {
    const kinds = new Set(result.results.map((r) => r.category));
    for (const k of ["single", "several", "distractor", "unanswerable"]) expect(kinds).toContain(k);
    // A stale question needs an archived version beside the current one.
    expect(kinds.has("stale")).toBe(files.some((f) => f.startsWith("docs/archive/")));
  });

  it("names a file for every story-level stale passage", () => {
    const stale = [...goldText.matchAll(/"(docs\/archive\/[^"#]+)#/g)].map((m) => m[1]);
    for (const f of stale) expect(files).toContain(f);
  });
});

describe("the three gold sets together", () => {
  it("hold the 60 to 100 retrieval questions the evaluation was sized for", () => {
    const n = APPS.map((a) => score(a).result.questions).reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(100);
  });
});
