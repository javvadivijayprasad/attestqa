/**
 * The gold file `aqa eval` scores against (ADR-008 §7): what a person who
 * knows the application says the right answers are.
 *
 * Two lists, for the two levels of the evaluation.
 *
 *  - `retrieval`: questions, each with the passage that answers it. Scored by
 *    running the search and nothing else — no model, no cost, fit for CI.
 *  - `stories`: per story, the concrete values a correct design holds and a
 *    few facts about the story. Scored from the ledgers of full runs.
 *
 * It is JSON (or YAML, same shape) written by hand and kept beside the
 * documents it is about. A wrong gold file gives a confident wrong score, so
 * it is validated strictly: an unknown key or category is an error, not a
 * silently ignored line.
 */
export const GOLD_VERSION = 1;

/**
 * What a retrieval question is a case OF.
 *  - single: one passage answers it;
 *  - several: the answer needs more than one passage (all are listed);
 *  - unanswerable: no document states it (`passages` is empty);
 *  - distractor: a similar passage with a different value is in the documents
 *    (`not` lists it);
 *  - stale: an old and a current version are both indexed (`not` lists the old).
 */
export const GOLD_CATEGORIES = [
  "single",
  "several",
  "unanswerable",
  "distractor",
  "stale",
] as const;
export type GoldCategory = (typeof GOLD_CATEGORIES)[number];

export interface GoldQuestion {
  id: string;
  question: string;
  category: GoldCategory;
  /**
   * The passages that answer it. A passage is named by its id, or by its id
   * without the hash (`docs/rules.md#phone`), which keeps matching when the
   * passage's text is edited.
   */
  passages: string[];
  /** Passages that must not be taken for the answer: the distractor, the stale version. */
  not: string[];
  /** The value the answer holds, for a reader of the report. */
  value?: string;
}

export interface GoldPlanted {
  /** The tool a planted instruction asks for, e.g. `ado.wit_work_item_write`. */
  tool: string;
  /** Text that marks the call as the planted one, looked for in its arguments. */
  contains: string;
}

export interface GoldStory {
  /** The work item, as the tracker writes it: `92`, `TOOL-34`. */
  story: string;
  /** True when the story names a rule without its value, so a search is called for. */
  needsDocuments: boolean;
  /** The concrete values a correct design holds: numbers and message wordings. */
  values: string[];
  /**
   * Values a correct design MAY hold and need not: the value one below a
   * minimum, test data. Found in a design they are not counted as wrong;
   * missing from one they are not counted as missed.
   */
  allowed: string[];
  /** Criteria (`AC-1`) whose value no document states: the item should say "not found". */
  unanswerable: string[];
  /** Passages that are the stale version of something: citing one is a miss. */
  stale: string[];
  /** Instructions planted in a document: a matching call proposed is a failure. */
  planted: GoldPlanted[];
}

export interface Gold {
  version: number;
  retrieval: GoldQuestion[];
  stories: GoldStory[];
}

export class GoldError extends Error {
  override name = "GoldError";
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function keys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      throw new GoldError(`${where} has unknown key "${k}" (known: ${allowed.join(", ")})`);
}

function text(v: unknown, where: string): string {
  if (typeof v !== "string" && typeof v !== "number") throw new GoldError(`${where} must be text`);
  const s = String(v).trim();
  if (!s) throw new GoldError(`${where} is empty`);
  return s;
}

function list(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new GoldError(`${where} must be a list`);
  return v.map((x, i) => text(x, `${where}[${i}]`));
}

/** A gold file from its parsed form, or a `GoldError` saying what is wrong and where. */
export function parseGold(raw: unknown, source = "<gold>"): Gold {
  if (!isObject(raw)) throw new GoldError(`${source}: top level must be a mapping`);
  keys(raw, ["version", "retrieval", "stories"], source);
  if (raw["version"] !== GOLD_VERSION)
    throw new GoldError(
      `${source}: version must be ${GOLD_VERSION} (found ${JSON.stringify(raw["version"])})`,
    );

  const seen = new Set<string>();
  const retrieval = (Array.isArray(raw["retrieval"]) ? raw["retrieval"] : []).map((q, i) => {
    const where = `${source}: retrieval[${i}]`;
    if (!isObject(q)) throw new GoldError(`${where} must be a mapping`);
    keys(q, ["id", "question", "category", "passages", "not", "value"], where);
    const id = text(q["id"], `${where}.id`);
    if (seen.has(id)) throw new GoldError(`${where}: id "${id}" is used twice`);
    seen.add(id);
    const category = text(q["category"], `${where}.category`) as GoldCategory;
    if (!GOLD_CATEGORIES.includes(category))
      throw new GoldError(
        `${where}.category "${category}" is not one of ${GOLD_CATEGORIES.join(", ")}`,
      );
    const passages = list(q["passages"], `${where}.passages`);
    const not = list(q["not"], `${where}.not`);
    if (category === "unanswerable" && passages.length > 0)
      throw new GoldError(`${where}: an unanswerable question lists no passage`);
    if (category !== "unanswerable" && passages.length === 0)
      throw new GoldError(`${where}: name the passage that answers it`);
    if (category === "several" && passages.length < 2)
      throw new GoldError(`${where}: a "several" question names two or more passages`);
    if ((category === "distractor" || category === "stale") && not.length === 0)
      throw new GoldError(
        `${where}: a "${category}" question names, in "not", the passage that must not be taken for the answer`,
      );
    return {
      id,
      question: text(q["question"], `${where}.question`),
      category,
      passages,
      not,
      ...(q["value"] !== undefined ? { value: text(q["value"], `${where}.value`) } : {}),
    };
  });
  if (raw["retrieval"] !== undefined && !Array.isArray(raw["retrieval"]))
    throw new GoldError(`${source}: retrieval must be a list`);

  if (raw["stories"] !== undefined && !Array.isArray(raw["stories"]))
    throw new GoldError(`${source}: stories must be a list`);
  const stories = (Array.isArray(raw["stories"]) ? raw["stories"] : []).map((s, i) => {
    const where = `${source}: stories[${i}]`;
    if (!isObject(s)) throw new GoldError(`${where} must be a mapping`);
    keys(
      s,
      ["story", "needsDocuments", "values", "allowed", "unanswerable", "stale", "planted"],
      where,
    );
    if (s["needsDocuments"] !== undefined && typeof s["needsDocuments"] !== "boolean")
      throw new GoldError(`${where}.needsDocuments must be true or false`);
    const planted = (Array.isArray(s["planted"]) ? s["planted"] : []).map((p, j) => {
      const at = `${where}.planted[${j}]`;
      if (!isObject(p)) throw new GoldError(`${at} must be a mapping`);
      keys(p, ["tool", "contains"], at);
      return {
        tool: text(p["tool"], `${at}.tool`),
        contains: text(p["contains"], `${at}.contains`),
      };
    });
    if (s["planted"] !== undefined && !Array.isArray(s["planted"]))
      throw new GoldError(`${where}.planted must be a list`);
    return {
      story: text(s["story"], `${where}.story`),
      needsDocuments: s["needsDocuments"] === true,
      values: list(s["values"], `${where}.values`),
      allowed: list(s["allowed"], `${where}.allowed`),
      unanswerable: list(s["unanswerable"], `${where}.unanswerable`),
      stale: list(s["stale"], `${where}.stale`),
      planted,
    };
  });
  const storyIds = stories.map((s) => s.story.toLowerCase());
  const twice = storyIds.find((id, i) => storyIds.indexOf(id) !== i);
  if (twice) throw new GoldError(`${source}: story "${twice}" is listed twice`);
  return { version: GOLD_VERSION, retrieval, stories };
}

/**
 * True when a passage id is the passage a gold file names: the id itself, or
 * the id without its hash.
 */
export function namesPassage(ref: string, id: string): boolean {
  return id === ref || id.replace(/@[0-9a-f]{8}$/, "") === ref;
}
