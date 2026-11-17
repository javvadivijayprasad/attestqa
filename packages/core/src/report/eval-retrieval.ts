import { searchKeywords, type KeywordIndex } from "../knowledge/bm25.js";
import {
  GOLD_CATEGORIES,
  namesPassage,
  type GoldCategory,
  type GoldQuestion,
} from "./eval-gold.js";
import { mean, rate, type Rate } from "./eval-stats.js";

/**
 * The retrieval level of the evaluation (ADR-008 §7): each gold question is
 * put to the search, exactly as `docs.search` would run it, and scored by
 * where the passage that answers it came. No model is called, so this costs
 * nothing and gives the same numbers every time — it can run in CI.
 *
 * Definitions, pinned here because frameworks disagree on them:
 *  - hit at 5: a passage that answers the question is among the first five;
 *  - reciprocal rank: 1 / the rank of the first such passage, 0 when the
 *    search did not return one within `DEPTH`;
 *  - complete at 5 (a "several" question): every passage it needs is among
 *    the first five;
 *  - wrong one first (a "distractor" or "stale" question): a passage the gold
 *    file marks `not` is ranked above every passage that answers.
 * An unanswerable question has no hit to score. What is reported for it is how
 * often the search returned something anyway, and with what top score —
 * keyword search has no way to say "nothing", so this is the number that
 * shows what the agent is handed when the documents do not have the answer.
 */
export const TOP = 5;
/** How far down the ranking the first answer is looked for. */
const DEPTH = 50;

export interface QuestionResult {
  id: string;
  category: GoldCategory;
  question: string;
  /** The first `TOP` passage ids, best first. */
  top: string[];
  topScore: number | null;
  /** Rank of the first answering passage, or null. */
  rank: number | null;
  hit: boolean;
  /** Gold passages that are not in the index at all: a gold file out of step with the documents. */
  missing: string[];
  /** "several" only. */
  complete?: boolean;
  /** "distractor" and "stale" only. */
  wrongFirst?: boolean;
}

export interface RetrievalResult {
  questions: number;
  /** Over the answerable questions. */
  hitAt5: Rate;
  meanReciprocalRank: number | null;
  /** "several" questions with every passage in the first five. */
  completeAt5: Rate;
  /** "distractor" and "stale" questions where the wrong passage came first. */
  wrongFirst: Rate;
  /** Unanswerable questions for which the search returned passages all the same. */
  unanswerableReturned: Rate;
  unanswerableMeanTopScore: number | null;
  byCategory: Array<{ category: GoldCategory; questions: number; hitAt5: Rate }>;
  /** Questions naming a passage the index does not hold. */
  goldOutOfStep: Array<{ id: string; missing: string[] }>;
  results: QuestionResult[];
}

export function evalRetrieval(
  questions: readonly GoldQuestion[],
  index: KeywordIndex,
): RetrievalResult {
  const results: QuestionResult[] = questions.map((q) => {
    const hits = searchKeywords(index, q.question, DEPTH);
    const answers = (id: string): boolean => q.passages.some((ref) => namesPassage(ref, id));
    const first = hits.find((h) => answers(h.id));
    const top = hits.slice(0, TOP).map((h) => h.id);
    const missing = [...q.passages, ...q.not].filter(
      (ref) => !index.ids.some((id) => namesPassage(ref, id)),
    );
    const wrong = hits.find((h) => q.not.some((ref) => namesPassage(ref, h.id)));
    return {
      id: q.id,
      category: q.category,
      question: q.question,
      top,
      topScore: hits[0]?.score ?? null,
      rank: first?.rank ?? null,
      hit: first !== undefined && first.rank <= TOP,
      missing,
      ...(q.category === "several"
        ? { complete: q.passages.every((ref) => top.some((id) => namesPassage(ref, id))) }
        : {}),
      ...(q.category === "distractor" || q.category === "stale"
        ? { wrongFirst: wrong !== undefined && (first === undefined || wrong.rank < first.rank) }
        : {}),
    };
  });

  const answerable = results.filter((r) => r.category !== "unanswerable");
  const unanswerable = results.filter((r) => r.category === "unanswerable");
  const several = results.filter((r) => r.category === "several");
  const paired = results.filter((r) => r.wrongFirst !== undefined);
  return {
    questions: results.length,
    hitAt5: rate(answerable.filter((r) => r.hit).length, answerable.length),
    meanReciprocalRank: mean(answerable.map((r) => (r.rank ? 1 / r.rank : 0))),
    completeAt5: rate(several.filter((r) => r.complete).length, several.length),
    wrongFirst: rate(paired.filter((r) => r.wrongFirst).length, paired.length),
    unanswerableReturned: rate(
      unanswerable.filter((r) => r.top.length > 0).length,
      unanswerable.length,
    ),
    unanswerableMeanTopScore: mean(unanswerable.map((r) => r.topScore)),
    byCategory: GOLD_CATEGORIES.filter((c) => c !== "unanswerable")
      .map((category) => {
        const of = results.filter((r) => r.category === category);
        return {
          category,
          questions: of.length,
          hitAt5: rate(of.filter((r) => r.hit).length, of.length),
        };
      })
      .filter((c) => c.questions > 0),
    goldOutOfStep: results
      .filter((r) => r.missing.length > 0)
      .map((r) => ({ id: r.id, missing: r.missing })),
    results,
  };
}
