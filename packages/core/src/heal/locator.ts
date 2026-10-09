/**
 * Locator repair, derived from the page — not guessed.
 *
 * ── Why this is code and not an instruction ──
 * A locator that matches nothing is the commonest failure in UI testing, and
 * the agent's instinct is to try another selector, then another. In one run it
 * tried four and filed four bugs about a menu item that was on screen the
 * whole time (20260923T235843Z). Telling it to "look at the page" was not
 * enough either: the snapshot reached it and it wrote the same selector again
 * (20260925T114717Z).
 *
 * So the derivation is mechanical. Playwright writes an accessibility snapshot
 * beside every failure; this reads it, lists what is actually on the page, and
 * returns real Playwright expressions. The agent chooses among candidates it
 * did not invent, and the choice is recorded.
 *
 * What this is NOT: a way to make a test pass. A heal changes the locator and
 * nothing else — `weakensAQuarantinedTest` in the story rules refuses a write
 * that changes what a quarantined test asserts. Repair is allowed; retreat is
 * not.
 */

export interface LocatorCandidate {
  /** The accessible role as the snapshot names it: menuitem, button, link, textbox… */
  role: string;
  /** Its accessible name, when it has one. */
  name: string;
  /** A Playwright expression, ready to paste. */
  expression: string;
  /** Why this one is offered: what it shares with the selector that failed. */
  why: string;
  /** Higher is a better match for the failed selector. */
  score: number;
}

/** One line of a Playwright accessibility snapshot: `- menuitem "Logout" [ref=e3]:` */
const NODE = /^\s*-\s+([a-z][a-z-]*)\s*(?:"([^"]*)")?/i;

/**
 * Everything addressable in the snapshot, as Playwright expressions.
 *
 * Roles that cannot be clicked or typed into are left out: a page full of
 * `generic` and `img` nodes drowns the three candidates that matter.
 */
export function candidatesFrom(snapshot: string): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const seen = new Set<string>();
  for (const line of snapshot.split("\n")) {
    const m = NODE.exec(line);
    if (!m) continue;
    const role = (m[1] ?? "").toLowerCase();
    const name = (m[2] ?? "").trim();
    if (!INTERACTIVE.has(role)) continue;
    const expression = name
      ? `page.getByRole("${role}", { name: ${JSON.stringify(name)} })`
      : `page.getByRole("${role}")`;
    if (seen.has(expression)) continue;
    seen.add(expression);
    out.push({ role, name, expression, why: "", score: 0 });
  }
  return out;
}

const INTERACTIVE = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "option",
  "tab",
  "switch",
  "searchbox",
  "slider",
  "spinbutton",
]);

/**
 * The candidates that best match the selector that failed, best first.
 *
 * The match is on the WORDS in the failed selector — `a[href="#/logout"]`
 * carries "logout", and so does the menu item it should have found. Words are
 * what survive a change of markup; the tag and the attribute are exactly what
 * did not.
 */
export function rankCandidates(
  snapshot: string,
  failedSelector: string,
  limit = 5,
): LocatorCandidate[] {
  const wanted = words(failedSelector);
  const scored = candidatesFrom(snapshot).map((c) => {
    const mine = words(`${c.role} ${c.name}`);
    const shared = [...wanted].filter((w) => mine.has(w));
    const score = shared.length * 10 + (c.name ? 1 : 0);
    return {
      ...c,
      score,
      why: shared.length
        ? `shares ${shared.map((w) => `"${w}"`).join(", ")} with the selector that failed`
        : "addressable on the page at the moment of failure",
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * The selector Playwright says it could not find, taken from its own message.
 *
 * Playwright names the locator in every timeout: `waiting for
 * locator('a[href="#/logout"]')`, or `getByRole('button', { name: 'Log in' })`.
 * Reading it here means the agent does not have to tell the runtime which
 * selector failed — and cannot tell it a different one.
 */
export function selectorFromMessage(message: string): string | undefined {
  const pats = [
    /waiting for\s+(.+?)(?:\n|$)/i,
    /locator\((['"`])([^'"`]+)\1\)/i,
    /(getBy[A-Za-z]+\([^\n)]*\))/,
  ];
  for (const p of pats) {
    const m = p.exec(message);
    if (!m) continue;
    const hit = (m[2] ?? m[1] ?? "").trim();
    if (hit && hit.length > 1 && !/^['"`]$/.test(hit)) return hit;
  }
  return undefined;
}

/** Words worth matching on: four letters or more, lowercased, de-duplicated. */
function words(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !NOISE.has(w)),
  );
}

/** Markup vocabulary, which every selector shares and which means nothing. */
const NOISE = new Set([
  "href",
  "class",
  "data",
  "test",
  "role",
  "page",
  "locator",
  "button",
  "input",
  "span",
  "text",
  "type",
  "name",
  "aria",
  "label",
  "getby",
  "visible",
  "timeout",
]);

/**
 * Playwright's shape for "I waited for an element that never appeared".
 *
 * Shared with the story rules: what counts as a locator failure has to be one
 * definition, or the rule that refuses a bug and the tool that repairs the
 * locator can disagree about the same error string.
 */
export const LOCATOR_ERROR =
  /(waiting for (?:locator|getBy)|locator resolved to 0 elements|element\(s\) not found|toBeVisible.*\bTimeout|strict mode violation)/i;

/**
 * A test that ran out of time without reaching an assertion.
 *
 * Playwright reports a step that never completes as the TEST's timeout, not as
 * the locator's: "Test timeout of 30000ms exceeded." and nothing about what it
 * was waiting for. 20260925T232423Z broke a locator deliberately and every
 * failure came back in this shape, so the heal role never engaged and the bug
 * rules saw no locator problem — while the cause was a selector that matched
 * nothing.
 *
 * On its own a bare timeout means little, so `stuckAction` also requires that
 * the failure never reached an assertion.
 */
export const TEST_TIMEOUT = /test timeout of \d+ *ms exceeded/i;

/**
 * Does this failure look like an action that never completed — as opposed to a
 * claim the product failed to satisfy?
 *
 * A message carrying an assertion (an `expect(...)`, a Received/Expected pair)
 * is the product answering; a timeout with no assertion in it is the suite
 * waiting for something that never arrived, which is the healer's business.
 */
export function stuckAction(message: string): boolean {
  if (LOCATOR_ERROR.test(message)) return true;
  if (!TEST_TIMEOUT.test(message)) return false;
  return !/\bexpect\s*\(|Expected pattern|Expected substring|Received string/i.test(message);
}

/** try/catch or .catch() around a step — a test that recovers from its own break. */
export const CATCHES = /(\bcatch\s*(\([^)]*\))?\s*\{|\.catch\s*\()/;
