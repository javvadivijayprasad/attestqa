import { scrub } from "../governance/scrub.js";
import type { AnyRunEvent } from "../types.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import type { DesignItem, TestDesign } from "./test-design.js";

/**
 * A design item that takes a value from a project document says which passage
 * and quotes it; this checks both, in code, before a person sees the design
 * (ADR-008 §6 and §13).
 *
 * Until 2.4.0 an item's `source` was held to a pattern: it had to NAME a
 * criterion, a task, a bug or a comment. Nothing checked that the source said
 * what the item said — the October evaluation called the rule "a review aid,
 * not a gate" (W6). For a document that can be checked, because the passage
 * is on record:
 *
 *   1. the passage cited (`doc:<passage id>` in `source`) was returned by a
 *      `docs.search` call in THIS run — so it is in this run's ledger, and the
 *      agent is not citing from memory or from an earlier run;
 *   2. the words in `quote` are in that passage.
 *
 * What it does not show: that the quote supports the expected result. A quote
 * can be real and beside the point. That is the reviewer's judgement, with the
 * quote in front of them, and the evaluation measures how often it holds.
 *
 * The comparison is with the observation as recorded, not with the index on
 * disk, which may have been rebuilt since the search. And with the passage as
 * the model saw it too: the scrubber replaces emails, addresses and tokens
 * before the model reads a result, so a quote copied faithfully can hold
 * `[EMAIL]` where the document has the address.
 */
const CITATION = /\bdoc:(.+?@[0-9a-f]{8})(?![0-9a-f])/g;

/** A quote shorter than this proves nothing: "11" is in most passages. */
export const MIN_QUOTE_CHARS = 10;

/** The passage ids an item's source cites, in order, each once. */
export function citedPassages(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(CITATION)) {
    const id = (m[1] ?? "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Every passage a design cites. */
export function designCitations(design: TestDesign): string[] {
  return [...new Set(design.items.flatMap((it) => citedPassages(it.source)))];
}

export interface ReturnedPassage {
  id: string;
  file: string;
  heading: string;
  lines: string;
  modified: string;
  text: string;
}

/** The passages `docs.search` returned in this run, by id, from the ledger. */
export function returnedPassages(events: AnyRunEvent[]): Map<string, ReturnedPassage> {
  const out = new Map<string, ReturnedPassage>();
  for (const call of successful(completedCalls(events), "docs.search")) {
    for (const raw of asArray(asRecord(call.result)?.["passages"])) {
      const p = asRecord(raw);
      const id = typeof p?.["id"] === "string" ? p["id"] : "";
      if (!p || !id || out.has(id)) continue;
      out.set(id, {
        id,
        file: String(p["file"] ?? ""),
        heading: String(p["heading"] ?? ""),
        lines: String(p["lines"] ?? ""),
        modified: String(p["modified"] ?? ""),
        text: String(p["text"] ?? ""),
      });
    }
  }
  return out;
}

/**
 * Text as a quotation is compared: whitespace run to one space, typographic
 * quotes and dashes to plain ones, and the marks Markdown puts at the start of
 * a line (a block quote's `>`, a list's `-` or `*`) left out — so two lines of
 * a block quote can be quoted as the sentence they are. Case is kept: a
 * message's wording is what a test asserts.
 */
export function quotable(text: string): string {
  return text
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote is in the passage, as written or as the model was shown it. */
export function quoteIn(quote: string, passage: string): boolean {
  const q = quotable(quote);
  if (q === "") return false;
  return quotable(passage).includes(q) || quotable(scrub(passage).text).includes(q);
}

const where = (p: ReturnedPassage): string =>
  `${p.file}${p.heading ? ` › ${p.heading}` : ""}${p.lines ? `, lines ${p.lines}` : ""}`;

/** What is wrong with the citations of one item; empty when it cites nothing or all is in order. */
export function itemCitationProblems(
  it: DesignItem,
  returned: Map<string, ReturnedPassage>,
): string[] {
  const cited = citedPassages(it.source);
  const quote = it.quote?.trim() ?? "";
  const at = it.id || "an item";
  if (cited.length === 0)
    return quote
      ? [
          `${at}: gives a quote but its source cites no passage — add "doc:<passage id>" to the ` +
            "source, with the id as docs.search returned it, or drop the quote",
        ]
      : [];
  const unknown = cited.filter((id) => !returned.has(id));
  if (unknown.length > 0)
    return [
      `${at}: its source cites ${unknown.map((id) => `doc:${id}`).join(", ")}, which no ` +
        "docs.search result in this run returned — a passage is cited by the id a search of " +
        "this run gave for it, exactly; search again and cite what comes back, or take the " +
        "document out of the source",
    ];
  if (!quote)
    return [
      `${at}: cites a document but quotes nothing from it — copy the words of the passage that ` +
        'state the value into the item\'s "quote", exactly as they are written',
    ];
  if (quotable(quote).length < MIN_QUOTE_CHARS)
    return [
      `${at}: the quote "${quote}" is too short to show anything — quote the sentence that ` +
        `states the value (at least ${MIN_QUOTE_CHARS} characters)`,
    ];
  const passages = cited.map((id) => returned.get(id) as ReturnedPassage);
  if (passages.some((p) => quoteIn(quote, p.text))) return [];
  return [
    `${at}: the quote "${quote}" is not in the passage it cites (${passages
      .map(where)
      .join("; ")}) — a quote is the passage's own words, copied; paraphrase belongs in the ` +
      "conditions or the expected result",
  ];
}

/** Every citation problem of a design, against what this run's searches returned. */
export function citationProblems(design: TestDesign, events: AnyRunEvent[]): string[] {
  if (!design.items.some((it) => it.quote || citedPassages(it.source).length > 0)) return [];
  const returned = returnedPassages(events);
  return design.items.flatMap((it) => itemCitationProblems(it, returned));
}

/**
 * The cited passages of a design that are not in the index as it is now —
 * every one of them when there is no index (`undefined`).
 *
 * For a design carried from an earlier run. A passage id ends in a hash of its
 * text, so a passage that is still in the index is the passage that was
 * quoted; one that is gone means the document was changed or removed since,
 * and the design rests on words that may no longer be there.
 */
export function citationsNotIn(
  design: TestDesign,
  index: ReadonlySet<string> | undefined,
): string[] {
  return designCitations(design).filter((id) => !index?.has(id));
}
