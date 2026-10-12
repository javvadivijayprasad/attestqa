/**
 * Work-item ids from either tracker.
 *
 * Azure DevOps numbers its work items (44); Jira keys them by project (SHOP-12).
 * Everything that reads a story id — the @story tag on a scenario, the
 * comment bdd2pw copies into the spec, the story the run is about — goes
 * through here, so a Jira story and an Azure DevOps story are handled by the
 * same code and compared the same way.
 *
 * Numeric ids stay numbers, so every Azure DevOps path behaves exactly as it
 * did before Jira existed. Jira keys are upper-cased: Jira itself treats
 * `shop-12` and `SHOP-12` as the same issue.
 */
export type TrackerId = number | string;

/** Where requirements come from. */
export type Tracker = "ado" | "jira";

export const TRACKERS: readonly Tracker[] = ["ado", "jira"];

/**
 * A bug state that means "known broken and being worked": Azure DevOps "Active",
 * or the Jira workflow names that mean the same. A test for such a bug is
 * expected to fail. Run 20261011T230623Z refused expectFail for a Jira bug in
 * "In Progress" because this check only knew the Azure DevOps word.
 */
export const KNOWN_BROKEN_STATE =
  /^(active|in progress|reopened|in development|in review|code review|blocked)$/i;

export function isKnownBroken(state: string): boolean {
  return KNOWN_BROKEN_STATE.test(state.trim());
}

/** A Jira issue key: a project key of two or more characters, a dash, a number. */
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

/** The id part of a tag, as a regex source. Keys first, so `SHOP-12` is not read as nothing. */
const ID_SOURCE = "([A-Za-z][A-Za-z0-9_]+-\\d+|\\d+)";

/** A tracker id from whatever shape it arrived in, or undefined when it is not one. */
export function normId(raw: unknown): TrackerId | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (JIRA_KEY.test(s)) return s.toUpperCase();
  return undefined;
}

/** True when both are ids and name the same work item. */
export function sameId(a: unknown, b: unknown): boolean {
  const x = normId(a);
  const y = normId(b);
  return x !== undefined && y !== undefined && x === y;
}

export function includesId(list: readonly unknown[], id: unknown): boolean {
  return list.some((x) => sameId(x, id));
}

/** True for a Jira key, false for an Azure DevOps number. */
export function isJiraKey(id: unknown): boolean {
  return typeof normId(id) === "string";
}

/** `@story:44` or `@story:SHOP-12` → the id; anything else → undefined. */
export function storyTagId(tag: string): TrackerId | undefined {
  const m = new RegExp(`^@story:${ID_SOURCE}$`, "i").exec(tag.trim());
  return m ? normId(m[1]) : undefined;
}

/** Every @story id mentioned anywhere in a line. */
export function storyTagIds(line: string): TrackerId[] {
  const out: TrackerId[] = [];
  for (const m of line.matchAll(new RegExp(`@story:${ID_SOURCE}`, "gi"))) {
    const id = normId(m[1]);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** True when the text carries at least one @story tag. */
export function hasStoryTag(text: string): boolean {
  return storyTagIds(text).length > 0;
}
