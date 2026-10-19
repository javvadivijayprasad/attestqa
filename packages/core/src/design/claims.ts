import type { AnyRunEvent } from "../types.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import { assertionsOf } from "./test-design.js";

/**
 * What a test claims, and when a rewrite keeps it. Shared by the write rule
 * that guards a quarantined test (skills/story-rules) and the verifier check
 * that reports one after the fact (triage/step), so the two cannot disagree
 * about what a repair is.
 */

/** A Playwright locator expression, with any `page.` prefix. */
export const LOCATOR_CALL = /(?:\bpage\.)?\b(?:getBy[A-Za-z]+|locator)\((?:[^()]|\([^()]*\))*\)/g;

export function normLocator(expr: string): string {
  return expr
    .replace(/^page\./, "")
    .replace(/["'`]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Every locator `aqa.heal_locator` offered from a page this run. */
export function healCandidates(events: AnyRunEvent[]): Set<string> {
  const out = new Set<string>();
  for (const c of successful(completedCalls(events), "aqa.heal_locator"))
    for (const raw of asArray(asRecord(c.result)?.["candidates"])) {
      const e = asRecord(raw)?.["expression"];
      if (typeof e === "string") out.add(normLocator(e));
    }
  return out;
}

/**
 * The same claim about a healed element: identical once locators are set
 * aside, and every locator that changed is one the heal tool offered.
 */
export function sameClaimHealed(before: string, after: string, healed: Set<string>): boolean {
  if (sameClaimOnARelative(before, after)) return true;
  if (healed.size === 0) return false;
  const was = before.match(LOCATOR_CALL) ?? [];
  const now = after.match(LOCATOR_CALL) ?? [];
  if (was.length === 0 || was.length !== now.length) return false;
  if (before.replace(LOCATOR_CALL, "<locator>") !== after.replace(LOCATOR_CALL, "<locator>"))
    return false;
  return now.every(
    (n, i) => normLocator(n) === normLocator(was[i] ?? "") || healed.has(normLocator(n)),
  );
}

/**
 * The same matcher and expectation, asserted on an element built FROM the old
 * one — its parent (`old.locator("..")`), a filtered ancestor
 * (`page.locator("li").filter({ has: old })`), a child of it. The claim is
 * unchanged; only where the state is read has moved. 20261018T125846Z:
 * Toolshop marks the current page with `active` on the list item around the
 * page button, and moving `toHaveClass(/active/)` from the button to that list
 * item was refused eight times as "dropping the claim".
 */
function sameClaimOnARelative(before: string, after: string): boolean {
  const split = (x: string) => {
    const m = /\.(?:not\s*\.\s*)?to[A-Z]\w*/.exec(x);
    return m ? [x.slice(0, m.index), x.slice(m.index)] : undefined;
  };
  const a = split(before);
  const b = split(after);
  if (!a || !b) return false;
  const squash = (x: string) => normLocator(x).replace(/\s+/g, "");
  if (squash(a[1] as string) !== squash(b[1] as string)) return false;
  const oldLocators = (a[0] as string).match(LOCATOR_CALL) ?? [];
  if (oldLocators.length === 0) return false;
  const newTarget = squash(b[0] as string);
  if (newTarget === squash(a[0] as string)) return false;
  return oldLocators.every((l) => newTarget.includes(squash(l)));
}

/**
 * The assertions of `before` that `after` no longer makes — allowing a healed
 * locator (one aqa.heal_locator offered) and the same claim read from a parent
 * or child of the old element.
 */
export function droppedClaims(before: string, after: string, events: AnyRunEvent[]): string[] {
  const now = assertionsOf(after);
  const kept = new Set(now);
  const healed = healCandidates(events);
  return assertionsOf(before).filter(
    (x) => !kept.has(x) && !now.some((y) => sameClaimHealed(x, y, healed)),
  );
}
