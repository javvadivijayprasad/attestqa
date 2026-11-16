import type { AnyRunEvent } from "../types.js";
import { acLabels } from "../triage/settle.js";
import { completedCalls, successful } from "../verify/evidence.js";
import type { TestDesign } from "./test-design.js";

/** A number range an acceptance criterion states in so many words. */
export interface StatedRange {
  /** The criterion's label, "AC-1". */
  criterion: string;
  low: number;
  high: number;
  /** The words it was read from, "18 to 74". */
  phrase: string;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
/** "between 1 and 99" */
const BETWEEN = new RegExp(String.raw`\bbetween\s+${NUM}\s+and\s+${NUM}`, "gi");
/** "18 to 74", "18–74", "18-74" — but not a date, a version or "AC-1". */
const TO = new RegExp(
  String.raw`(?<![\w.\-–—/])${NUM}\s*(?:to|–|—|-)\s*${NUM}(?![\w\-–—/]|\.\d)`,
  "gi",
);
/**
 * A rule on how LONG a text is ("between 11 and 21 characters"). The tool does
 * not read those and refuses them (`LENGTH_CHECK` in mcp/adapters/synthdata.ts),
 * so they are not asked of it.
 */
const LENGTH_AFTER = /^\s*(?:characters?|chars?|letters?|digits?|symbols?|words?)\b/i;
const LENGTH_BEFORE = /\b(?:length|long|characters?)\b[^.;]{0,24}$/i;

/** The story's acceptance criteria as the stage-1 digest printed them, by label. */
export function criteriaWording(events: AnyRunEvent[]): Map<string, string> {
  const digest = successful(completedCalls(events), "aqa.story_context").pop();
  const text = String((digest?.result as { text?: unknown } | undefined)?.text ?? "");
  const out = new Map<string, string>();
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Acceptance criteria:");
  if (start < 0) return out;
  let label: string | undefined;
  for (const line of lines.slice(start + 1)) {
    // The block is indented; the first line that is not ends it.
    if (!/^\s+\S/.test(line)) break;
    const m = /^\s*(?:[•·*\-–—]\s*|\d+[.)]\s*)?(AC[- ]?\d+[a-z]?)\s*[:.)\-–—]\s*(.*)$/i.exec(line);
    if (m) {
      label = acLabels(m[1] as string)[0];
      if (label) out.set(label, m[2] as string);
    } else if (label) out.set(label, `${out.get(label) ?? ""} ${line.trim()}`);
  }
  return out;
}

/** The number ranges in one criterion's wording. Text-length rules are left out. */
export function rangesIn(criterion: string, wording: string): StatedRange[] {
  const found: StatedRange[] = [];
  for (const re of [BETWEEN, TO]) {
    for (const m of wording.matchAll(re)) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      if (!(low < high)) continue;
      const at = m.index ?? 0;
      if (LENGTH_AFTER.test(wording.slice(at + m[0].length))) continue;
      if (LENGTH_BEFORE.test(wording.slice(0, at))) continue;
      if (found.some((f) => f.low === low && f.high === high)) continue;
      found.push({ criterion, low, high, phrase: m[0].trim() });
    }
  }
  return found;
}

const VALUE_TECHNIQUES = new Set(["boundary-value-analysis", "equivalence-partitioning"]);
const base = (label: string) => label.replace(/[a-z]$/i, "");

/** The profiles `synthdata.examples` has been called with for this range, this run. */
function profilesCalled(events: AnyRunEvent[], r: StatedRange): Set<string> {
  const n = (v: number) => String(v).replace(".", String.raw`\.`);
  const rule = new RegExp(String.raw`\bBETWEEN\s+${n(r.low)}\s+AND\s+${n(r.high)}(?![\d.])`, "i");
  const out = new Set<string>();
  // A call that ran and failed counts: a generator that is broken on the day
  // must not hold a design back for ever. A rule the adapter refuses before
  // running anything (a compound comparison) has no BETWEEN and does not count.
  for (const c of completedCalls(events)) {
    if (c.toolName !== "synthdata.examples") continue;
    if (!rule.test(String(c.args["ddl"] ?? ""))) continue;
    out.add(typeof c.args["profile"] === "string" ? c.args["profile"] : "edge");
  }
  return out;
}

/**
 * A design that tests the limits of a number range its criterion states, with
 * the generator offered and not asked.
 *
 * The skill told the agent to take such values from `synthdata.examples`
 * "BEFORE you submit the design", and nothing checked it. In both authoring
 * runs of TOOL-34 (20261113T232806Z, 20261114T141230Z: "A customer aged 18 to
 * 74 can register") the tool was offered, the design had three
 * boundary-value items on that criterion, and the tool was never called — so
 * the feature that 2.3.0 is named for ran only when the model chose to. The
 * values a person approves are then the model's own arithmetic, with no record
 * of where they came from.
 */
export function rangeValuesOwed(d: TestDesign, events: AnyRunEvent[]): string[] {
  const wording = criteriaWording(events);
  const problems: string[] = [];
  for (const [criterion, text] of wording) {
    const items = d.items.filter(
      (it) =>
        VALUE_TECHNIQUES.has(it.technique) &&
        acLabels(it.covers).some((l) => l === criterion || base(l) === criterion),
    );
    if (items.length === 0) continue;
    for (const r of rangesIn(criterion, text)) {
      const called = profilesCalled(events, r);
      const owed = ["edge", "negative"].filter((p) => !called.has(p));
      if (owed.length === 0) continue;
      problems.push(
        `${items.map((it) => it.id).join(", ")}: ${criterion} states a number range ("${r.phrase}"), ` +
          "the synthdata.examples tool is offered, and it has not been called for that range with " +
          `profile ${owed.map((p) => `"${p}"`).join(" and ")}. Call synthdata.examples with the rule ` +
          `written as CHECK (<field> BETWEEN ${r.low} AND ${r.high}) — once with profile "edge" (the ` +
          'valid boundaries) and once with profile "negative" (the invalid values) — then put the ' +
          "values it returns, and any it says are missing, into these items' conditions and submit " +
          "the design again. Where the value typed into the form is worked out from the number (a " +
          "date of birth from an age), state both in the conditions",
      );
    }
  }
  return problems;
}
