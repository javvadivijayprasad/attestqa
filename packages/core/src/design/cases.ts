import type { TrackerId } from "./ids.js";
import type { DesignItem, TestDesign } from "./test-design.js";
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
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const sameAs = (a: DesignItem, b: DesignItem) =>
    norm(a.expected) === norm(b.expected) &&
    a.conditions.map(norm).join("|") === b.conditions.map(norm).join("|") &&
    Boolean(a.expectFail) === Boolean(b.expectFail);
  return design.items.map((it) => {
    const hit = covered.get(it.id);
    const before = previous?.items.find((p) => p.id === it.id);
    const scripted = hit ? scenarios.find((s) => s.scenario === hit.scenario)?.scripted : false;
    const state: CaseState = !hit
      ? "new"
      : before && !sameAs(before, it)
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
