import { createHash } from "node:crypto";
import type { TrackerId } from "./ids.js";
import {
  scenarioDesignTags,
  scenarioStoryTags,
  testsByTitle,
  type DesignItem,
  type TestDesign,
} from "./test-design.js";
import { includesId } from "./ids.js";
import type { StoryScenario } from "./coverage-map.js";

/**
 * Stable test-case IDs and the case list a run starts from (item 8 in
 * docs/ENGINE_MAP.md §11).
 *
 * A case is one design item of one story. Design ids are already unique within
 * an epic's file (`design-ids` refuses a clash) and every scenario and test
 * carries `@story:<id> @design:<Dn>`, so `<story>-<Dn>` — `TOOL-6-D3` — names
 * the same case in the tracker record, the feature file and the spec without
 * a new tag anyone has to keep in step. Each run lists every case with its
 * state, so a person sees at once what is already there and what this run
 * will build.
 */
export type CaseState = "exists" | "exists (no script yet)" | "new" | "changed";

export interface CaseLine {
  caseId: string;
  design: string;
  title: string;
  state: CaseState;
}

export function caseId(story: TrackerId | undefined, design: string): string {
  return story === undefined ? design : `${String(story)}-${design}`;
}

/** The cases that exist before any design: this story's scenarios as they are on disk. */
export function existingCases(
  story: TrackerId | undefined,
  scenarios: readonly StoryScenario[],
): CaseLine[] {
  return scenarios.map((s) => ({
    caseId: caseId(story, s.design),
    design: s.design,
    title: s.scenario,
    state: s.scripted ? "exists" : "exists (no script yet)",
  }));
}

/**
 * The cases of a proposed design. An item with a scenario exists (or exists
 * without a script); an item whose expectation or conditions differ from the
 * same id in the design approved before is changed; the rest are new.
 */
export function designCases(
  story: TrackerId | undefined,
  design: TestDesign,
  covered: ReadonlyMap<string, { scenario: string }>,
  scenarios: readonly StoryScenario[],
  previous?: TestDesign,
): CaseLine[] {
  const changed = new Set(changedItems(design, covered, previous).map((c) => c.id));
  return design.items.map((it) => {
    const hit = covered.get(it.id);
    const scripted = hit ? scenarios.find((s) => s.scenario === hit.scenario)?.scripted : false;
    const state: CaseState = !hit
      ? "new"
      : changed.has(it.id)
        ? "changed"
        : scripted === false
          ? "exists (no script yet)"
          : "exists";
    return {
      caseId: caseId(story, it.id),
      design: it.id,
      title: hit?.scenario ?? `${it.covers}: ${it.expected}`,
      state,
    };
  });
}

export interface ChangedItem {
  id: string;
  /** What the design approved before expected of this item. */
  was: string;
  /** What the design in hand expects of it. */
  now: string;
  /** The scenario that tests it today — written for `was`. */
  scenario: string;
}

/**
 * The items of a design that already have a test AND whose expected result,
 * the numbers in its conditions, or expect-fail differ from the same id in the
 * design approved before: the test on disk was written for the earlier one.
 * Still a comparison of words — "displays" against "shows" is a difference —
 * so the reviewer is shown both wordings and the agent is told a test that
 * already checks what its item expects needs no change.
 *
 * Until 2.3.0 this was a label in the approval note and nothing else. Run
 * 20261113T014353Z: the story's criteria had been rewritten to quote the
 * application's messages, the new design said so under the same ids (D5…D9),
 * `aqa.test_design` answered "every item is already tested … do not rewrite
 * the feature file or the spec", the suite failed on the old wording, and the
 * failures went to the locator healer. `changedItems` is now what the design
 * tool's result, the second route and the heal role read.
 */
export function changedItems(
  design: TestDesign,
  covered: ReadonlyMap<string, { scenario: string }>,
  previous?: TestDesign,
): ChangedItem[] {
  if (!previous) return [];
  // A design is written afresh each run, so the same expectation comes back in
  // other words. What is compared is what a test could be wrong about: the
  // expected result with case, punctuation and articles set aside, the numbers
  // in the conditions (a boundary that moved), and expect-fail. The prose of
  // the conditions is not: 20261113T124917Z (AB#91, nothing changed in the
  // story) reported four of four items changed — one for a full stop, and all
  // for conditions the model had described differently.
  const core = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\b(the|a|an)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const numbers = (it: DesignItem) =>
    [...new Set(it.conditions.join(" ").match(/\d+(?:\.\d+)?/g) ?? [])].sort().join(",");
  const sameAs = (a: DesignItem, b: DesignItem) =>
    core(a.expected) === core(b.expected) &&
    numbers(a) === numbers(b) &&
    Boolean(a.expectFail) === Boolean(b.expectFail);
  const out: ChangedItem[] = [];
  for (const it of design.items) {
    const hit = covered.get(it.id);
    const before = previous.items.find((p) => p.id === it.id);
    if (!hit || !before || sameAs(before, it)) continue;
    // Ids are the model's: two designs may use D4 for different things
    // (20261113T130619Z: an accessibility item before, a bug's test now). An
    // item that covers something else, or is of another type, is not the
    // earlier item changed, and its test was not written for that one.
    if (core(before.covers) !== core(it.covers) || before.type !== it.type) continue;
    out.push({ id: it.id, was: before.expected, now: it.expected, scenario: hit.scenario });
  }
  return out;
}

/**
 * Scenarios of changed items that no test in the spec is named after.
 *
 * A changed item's scenario may be rewritten, and so may its test — by hand,
 * since nothing is generated for it. The check that every design item has a
 * test looks for the item's id in the spec, and the id is still there on the
 * OLD test. 20261113T131724Z: D5's scenario was split in two under new titles
 * to add a requirement, the spec was not touched, the old test passed, and the
 * run was accepted with the new requirement checked by nothing.
 *
 * A test belongs to a scenario when one title contains the other, as
 * `coverageOf` reads it (bdd2pw names the test after the scenario).
 */
export function changedScenariosWithoutATest(
  changedIds: readonly string[],
  featureText: string,
  specText: string,
  story?: TrackerId,
): Array<{ id: string; scenario: string }> {
  const ids = new Set(changedIds.map((id) => id.toUpperCase()));
  if (ids.size === 0) return [];
  const mine =
    story === undefined
      ? undefined
      : new Set(
          scenarioStoryTags(featureText)
            .filter((s) => includesId(s.stories, story))
            .map((s) => s.scenario),
        );
  const titles = [...testsByTitle(specText).keys()];
  const out: Array<{ id: string; scenario: string }> = [];
  for (const sc of scenarioDesignTags(featureText)) {
    if (mine && !mine.has(sc.scenario)) continue;
    const id = sc.designs.find((d) => ids.has(d));
    if (!id) continue;
    if (titles.some((t) => t.includes(sc.scenario) || sc.scenario.includes(t))) continue;
    out.push({ id, scenario: sc.scenario });
  }
  return out;
}

/** A changed item as the second route records it, with its scenario and test as they stood. */
export interface ChangedAtSwitch extends ChangedItem {
  /** The scenario's body when the run switched, whitespace-normalised. */
  body: string;
  /** A short hash of its test's body at that moment; "" when it had none. */
  test: string;
}

const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string) => createHash("sha256").update(squeeze(s)).digest("hex").slice(0, 12);

/** The body of the scenario with this title, whitespace-normalised, or undefined. */
function scenarioBody(featureText: string, scenario: string): string | undefined {
  const lines = featureText.split("\n");
  const at = lines.findIndex((l) => {
    const m = /^\s*Scenario(?: Outline)?:\s*(.*)$/i.exec(l);
    return m !== null && (m[1] ?? "").trim() === scenario.trim();
  });
  if (at < 0) return undefined;
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*(@\S|Scenario(?: Outline)?:|Feature:|Rule:|Background:)/i.test(l)) break;
    body.push(l);
  }
  return squeeze(body.join("\n"));
}

/** The hash of the test named after this scenario, or "" when there is none. */
function testHash(specText: string, scenario: string): string {
  for (const [title, body] of testsByTitle(specText))
    if (title.includes(scenario) || scenario.includes(title)) return short(body);
  return "";
}

/** The changed items with their scenario and test as they stand now — taken when the run switches. */
export function changedAtSwitch(
  changed: readonly ChangedItem[],
  featureText: string,
  specText: string,
): ChangedAtSwitch[] {
  return changed.map((c) => ({
    ...c,
    body: scenarioBody(featureText, c.scenario) ?? "",
    test: testHash(specText, c.scenario),
  }));
}

/**
 * Changed items whose scenario AND test are still exactly as they were when
 * the run switched.
 *
 * A test written for the earlier expectation fails when that expectation was
 * a text the page no longer shows — and passes when the item only gained a
 * requirement. 20261113T133431Z: AC-1 had gained "and the confirmation is not
 * shown", the design said so, the old test passed, the agent changed nothing,
 * and the run was accepted with the new requirement checked by nothing.
 *
 * Not a failure in itself: an item the model only reworded is "changed" too,
 * and its test rightly stays. So the agent is told once, with both wordings,
 * and what is still untouched after that goes to the reviewer.
 */
export function untouchedChangedItems(
  changed: readonly ChangedAtSwitch[],
  featureText: string,
  specText: string,
): ChangedAtSwitch[] {
  return changed.filter(
    (c) =>
      c.body !== "" &&
      scenarioBody(featureText, c.scenario) === c.body &&
      testHash(specText, c.scenario) === c.test,
  );
}

/** The line a changed, untouched item is reported with — the same words every time it is checked. */
export function untouchedLine(c: ChangedAtSwitch): string {
  return (
    `${c.id}: the approved design changed what this item expects and neither its scenario nor ` +
    `its test was changed — before: ${squeeze(c.was)} | now: ${squeeze(c.now)}. If the test ` +
    "already checks everything the item expects now, leave it; otherwise bring the scenario and " +
    "the test into line"
  );
}

/** One line per case, aligned, for the terminal and the approval prompt. */
export function renderCases(cases: readonly CaseLine[]): string[] {
  if (cases.length === 0) return ["  (no test cases yet)"];
  const w = Math.max(...cases.map((c) => c.caseId.length));
  const s = Math.max(...cases.map((c) => c.state.length));
  return cases.map((c) => `  ${c.caseId.padEnd(w)}  ${c.state.padEnd(s)}  ${c.title}`);
}

/** "3 exist, 1 new" — the counts by state, in a fixed order. */
export function caseTally(cases: readonly CaseLine[]): string {
  const order: CaseState[] = ["exists", "exists (no script yet)", "changed", "new"];
  return order
    .map((st) => [st, cases.filter((c) => c.state === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${st}`)
    .join(", ");
}
