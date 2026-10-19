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
  // getByRole / getByLabel / getByText name the control by its accessible
  // name. Compare that name as a person would — ignoring spaces, case and
  // punctuation — because the visible text and the accessible name often
  // differ by exactly that: Juice Shop's button shows "Log in" and is named
  // "Login" (run 20261011T230623Z, where word matching found nothing because
  // "log" and "in" are too short to count).
  const asked = askedFor(failedSelector);
  const scored = candidatesFrom(snapshot).map((c) => {
    const mine = words(`${c.role} ${c.name}`);
    const shared = [...wanted].filter((w) => mine.has(w));
    let score = shared.length * 10 + (c.name ? 1 : 0);
    let why = shared.length
      ? `shares ${shared.map((w) => `"${w}"`).join(", ")} with the selector that failed`
      : "addressable on the page at the moment of failure";
    if (asked?.name && c.name) {
      const a = squash(asked.name);
      const n = squash(c.name);
      const sameRole = !asked.role || asked.role === c.role;
      if (a && a === n) {
        score += sameRole ? 30 : 20;
        why =
          `same ${sameRole ? "control" : "name"} as the selector that failed — "${asked.name}" vs ` +
          `"${c.name}" differ only in spacing, case or punctuation`;
      } else if (a && n && (n.includes(a) || a.includes(n)) && Math.min(a.length, n.length) >= 4) {
        score += sameRole ? 15 : 10;
        why = `name "${c.name}" contains or is contained in "${asked.name}"`;
      }
    }
    return { ...c, score, why };
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
  return new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !NOISE.has(w)));
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
 * The element was found and a value about it did not match: an assertion
 * failure, which no change of locator can fix.
 *
 * Recognised by what Playwright prints for a mismatch — a `Received…:` line,
 * an `Expected pattern|string|…:` line, "unexpected value" in the call log, or
 * `expect(received).toX(expected)` — and never when it also says the element
 * was not there ("element(s) not found", "resolved to 0 elements"): that is
 * the locator failing, whatever the matcher.
 */
export function valueMismatch(message: string): boolean {
  if (
    /element\(s\) not found|resolved to 0 elements|no element matches|strict mode violation/i.test(
      message,
    )
  )
    return false;
  return (
    /^\s*Received(?: string| value| array| object)?:/im.test(message) ||
    /\bExpected (?:pattern|string|substring|value|array|object):/i.test(message) ||
    /\bunexpected value\b/i.test(message) ||
    /\bexpect\(received\)\.\w+\(expected\)/i.test(message)
  );
}

/**
 * Does this failure look like an action that never completed — as opposed to a
 * claim the product failed to satisfy?
 *
 * A message carrying an assertion (an `expect(...)`, a Received/Expected pair)
 * is the product answering; a timeout with no assertion in it is the suite
 * waiting for something that never arrived, which is the healer's business.
 */
export function stuckAction(message: string): boolean {
  // Checked first: Playwright writes "waiting for getBy…" in the call log of
  // EVERY expect(locator) failure, including a plain wrong value. Matching
  // LOCATOR_ERROR before this sent "Received string: \"page-link\"" to the
  // heal agent as "a locator that matched nothing" (20261018T223256Z, F1 in
  // docs/ENGINE_MAP.md).
  if (valueMismatch(message)) return false;
  if (LOCATOR_ERROR.test(message)) return true;
  if (!TEST_TIMEOUT.test(message)) return false;
  return !/\bexpect\s*\(|Expected pattern|Expected substring|Received string/i.test(message);
}

/** try/catch or .catch() around a step — a test that recovers from its own break. */
export const CATCHES = /(\bcatch\s*(\([^)]*\))?\s*\{|\.catch\s*\()/;

/** The role and accessible name a getBy* selector asked for, when it names one. */
export function askedFor(selector: string): { role?: string; name: string } | undefined {
  const byRole = /getByRole\(\s*['"`]([\w-]+)['"`]\s*,\s*\{[^}]*name:\s*(['"`])(.+?)\2/.exec(
    selector,
  );
  if (byRole?.[1] && byRole[3]) return { role: byRole[1], name: byRole[3] };
  const other = /getBy(?:Label|Text|Placeholder|Title|AltText)\(\s*(['"`])(.+?)\1/.exec(selector);
  if (other?.[2]) return { name: other[2] };
  return undefined;
}

/** "Log in" → "login": what is left when spacing, case and punctuation go. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
