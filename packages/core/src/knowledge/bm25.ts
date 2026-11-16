import type { Passage } from "./passages.js";

/**
 * Keyword ranking over passages: Okapi BM25, written here (ADR-008 §4).
 *
 * In the core and not a library so that the formula, the two parameters and the
 * tokeniser are on this page and the package gains no dependency. No model, no
 * key, no network: the same index and the same query give the same order on
 * every machine.
 *
 *   score(q, d) = Σ over the distinct terms t of q
 *                 idf(t) · tf(t, d) · (k1 + 1) / (tf(t, d) + k1 · (1 − b + b · |d| / avgdl))
 *   idf(t)      = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
 *
 * `|d|` is the passage's length in tokens, its headings included; `avgdl` the
 * mean of that over the index; `N` the number of passages; `df(t)` how many
 * hold the term. The idf is the form that is never negative.
 *
 * The documents are indexed whole. A QUERY loses its function words
 * (`QUERY_STOP_WORDS`): a project has tens of passages, not millions, and in
 * so small a set "the" is rare enough to outweigh the one word that matters —
 * "allowed length of the phone number" ranked a passage with two "the"s above
 * the phone rule. A query made only of such words is searched as written.
 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Goes up with any change to `tokens` or the stop words, which changes every score. */
export const TOKENISER_VERSION = 1;

/** Dropped from a query, never from a document. English; fixed. */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be by can do does for from has have how if in is it its of on or " +
    "that the their there this to was what when where which who will with"
  ).split(" "),
);

/** The words a query is searched by, each once, in a fixed order. */
export function queryTerms(query: string): string[] {
  const all = [...new Set(tokens(query))].sort();
  const kept = all.filter((t) => !QUERY_STOP_WORDS.has(t));
  return kept.length > 0 ? kept : all;
}

/**
 * The words of a text: runs of letters and digits, lower-cased, compatibility
 * forms folded (NFKC). No stemming and no stop words — "characters" does not
 * match "character", and that is stated so nobody has to find it out.
 */
export function tokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export interface KeywordIndex {
  version: 1;
  k1: number;
  b: number;
  tokeniser: number;
  /** Passage ids, in the order of `passages.jsonl`. */
  ids: string[];
  /** Tokens per passage, same order. */
  lengths: number[];
  avgdl: number;
  /** Per term, sorted by term: the passages holding it and how often. */
  postings: Array<[term: string, hits: Array<[passage: number, tf: number]>]>;
}

/** A passage is searched by its headings as well as its text. */
function searched(p: Pick<Passage, "heading" | "text">): string[] {
  return tokens(`${p.heading.join(" ")} ${p.text}`);
}

export function buildKeywordIndex(passages: readonly Passage[]): KeywordIndex {
  const postings = new Map<string, Array<[number, number]>>();
  const lengths: number[] = [];
  passages.forEach((p, i) => {
    const words = searched(p);
    lengths.push(words.length);
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const [w, n] of tf) {
      const list = postings.get(w);
      if (list) list.push([i, n]);
      else postings.set(w, [[i, n]]);
    }
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  return {
    version: 1,
    k1: BM25_K1,
    b: BM25_B,
    tokeniser: TOKENISER_VERSION,
    ids: passages.map((p) => p.id),
    lengths,
    avgdl: lengths.length > 0 ? total / lengths.length : 0,
    postings: [...postings.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

export interface Hit {
  id: string;
  /** 1 for the best. */
  rank: number;
  score: number;
}

/**
 * The best `limit` passages for a query, best first. Equal scores are ordered
 * by passage id, so the order never depends on how the index was built. A query
 * with no word in the index returns nothing.
 */
export function searchKeywords(index: KeywordIndex, query: string, limit = 5): Hit[] {
  const n = index.ids.length;
  if (n === 0 || index.avgdl === 0) return [];
  const terms = queryTerms(query);
  const byTerm = new Map(index.postings);
  const scores = new Map<number, number>();
  for (const t of terms) {
    const hits = byTerm.get(t);
    if (!hits) continue;
    const idf = Math.log(1 + (n - hits.length + 0.5) / (hits.length + 0.5));
    for (const [doc, tf] of hits) {
      const len = index.lengths[doc] ?? 0;
      const part =
        (idf * tf * (index.k1 + 1)) /
        (tf + index.k1 * (1 - index.b + (index.b * len) / index.avgdl));
      scores.set(doc, (scores.get(doc) ?? 0) + part);
    }
  }
  return [...scores.entries()]
    .map(([doc, score]) => ({ id: index.ids[doc] ?? "", score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((h, i) => ({ id: h.id, rank: i + 1, score: h.score }));
}
