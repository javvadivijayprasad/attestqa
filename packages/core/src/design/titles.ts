/**
 * A test's title as the spec WRITES it and as Playwright REPORTS it are not
 * always the same text, and a file as the run last saw it is not always
 * byte-for-byte what an edit was written against. Both are compared here, in
 * one place.
 *
 * Toolshop TOOL-34, 20261115T004103Z: the tests of a Scenario Outline are
 * written once, in a loop, with the row's value in the title —
 *
 *   for (const example of ageLimitExamples) {
 *     // @story:TOOL-34
 *     test(`AC-1 Registration enforces the customer age limits age ${example.age}`, …
 *
 * — and reported as "… age 75". Every rule that asks "is this failing test the
 * story's own?" compared the two as strings: the story's own failing test was
 * reported as another story's, and was not the run's to repair or to file.
 */

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A title written as a template literal, as a pattern for the titles it prints. */
function titlePattern(written: string): RegExp | undefined {
  if (!written.includes("${")) return undefined;
  let source = "";
  let literal = 0;
  let i = 0;
  while (i < written.length) {
    if (written.startsWith("${", i)) {
      let depth = 1;
      let j = i + 2;
      for (; j < written.length && depth > 0; j++) {
        if (written[j] === "{") depth++;
        else if (written[j] === "}") depth--;
      }
      if (depth > 0) return undefined;
      source += ".*?";
      i = j;
      continue;
    }
    const ch = written[i] as string;
    source += /\s/.test(ch) ? "\\s+" : escapeRegExp(ch);
    if (/\S/.test(ch)) literal++;
    i++;
  }
  // A title that is nothing but a placeholder would answer for every test.
  if (literal < 3) return undefined;
  return new RegExp(`^${source}$`, "s");
}

/** Is the test Playwright reported under `reported` the one the spec writes as `written`? */
export function sameTest(written: string, reported: string): boolean {
  const w = written.trim();
  const r = reported.trim();
  return w === r || titlePattern(w)?.test(r) === true;
}

/**
 * Test titles as a spec writes them, answering for the titles a run reports.
 *
 * `scenarios`: the members are scenario names (the route's list, a feature
 * file), not spec titles. A Scenario Outline's tests are named after the
 * scenario with the row's value after it, so a reported title that continues
 * a member is that scenario's test.
 */
export class TitleSet extends Set<string> {
  constructor(
    titles?: Iterable<string>,
    private readonly scenarios = false,
  ) {
    super(titles);
  }

  override has(reported: string): boolean {
    if (super.has(reported)) return true;
    const r = reported.trim();
    for (const written of this) {
      if (sameTest(written, r)) return true;
      if (this.scenarios && written.trim() !== "" && r.startsWith(`${written.trim()} `))
        return true;
    }
    return false;
  }
}

/** A written title for a reader: `${example.age}` reads as `<age>`. */
export function shownTitle(written: string): string {
  return written.replace(/\$\{[^{}]*?(\w+)(?:\(\))?\s*\}/g, "<$1>");
}
