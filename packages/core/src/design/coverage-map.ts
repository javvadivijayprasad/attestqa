import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  featurePathFor,
  scenarioTags,
  specPathFor,
  testsByTitle,
  type StoryFacts,
} from "./test-design.js";
import { sameId } from "./ids.js";

/**
 * What already covers this story, shown before the design (item 6 in
 * docs/ENGINE_MAP.md §11).
 *
 * The design used to start from the story alone, so every run proposed a whole
 * design again — numbers that clashed with the file, expectations reworded,
 * items invented — and the reviewer approved the same tests run after run. A
 * QA team starts from what exists: which criteria, bugs and test types already
 * have a scenario (and a script), and which have none. The agent then proposes
 * only the gaps, and "no new test cases are required" is an answer it can give.
 */

export interface CoverageLine {
  what: string;
  covered: Array<{ design: string; scenario: string; scripted: boolean }>;
}

/** One of this story's scenarios in the epic feature file, and whether the spec scripts it. */
export interface StoryScenario {
  design: string;
  scenario: string;
  tags: string[];
  scripted: boolean;
}

/** This story's scenarios, read from the epic's feature file and spec. */
export function storyScenarios(
  facts: StoryFacts,
  workspaceDir: string,
): {
  feature?: string;
  scenarios: StoryScenario[];
} {
  const featurePath = featurePathFor(facts);
  const specPath = specPathFor(facts);
  const read = (p?: string) => {
    if (!p) return undefined;
    const full = join(workspaceDir, p);
    try {
      return existsSync(full) ? readFileSync(full, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  const feature = read(featurePath);
  const spec = read(specPath) ?? "";
  const tests = [...testsByTitle(spec).keys()];
  const story = facts.story?.id;
  const scenarios = (feature ? scenarioTags(feature) : [])
    .filter(
      (s) =>
        story === undefined || s.tags.some((t) => /^@story:/i.test(t) && sameId(t.slice(7), story)),
    )
    .map((s) => ({
      design: tagValue(s.tags, "design")[0] ?? "?",
      scenario: s.scenario,
      tags: s.tags,
      scripted: tests.some((t) => t.includes(s.scenario) || s.scenario.includes(t)),
    }));
  return { ...(featurePath ? { feature: featurePath } : {}), scenarios };
}

function tagValue(tags: string[], name: string): string[] {
  return tags
    .filter((t) => t.toLowerCase().startsWith(`@${name}:`))
    .map((t) => t.slice(name.length + 2));
}

export function coverageOfStory(
  facts: StoryFacts,
  workspaceDir: string,
  testTypes: readonly string[] = [],
): { feature?: string; lines: CoverageLine[] } {
  const { feature: featurePath, scenarios: mine } = storyScenarios(facts, workspaceDir);
  const entry = (s: StoryScenario) => ({
    design: s.design,
    scenario: s.scenario,
    scripted: s.scripted,
  });

  const lines: CoverageLine[] = [];
  facts.acceptanceCriteria.forEach((label, i) => {
    const n = String(/AC-?(\d+)/i.exec(label)?.[1] ?? i + 1);
    lines.push({
      what: `AC-${n}`,
      covered: mine.filter((s) => tagValue(s.tags, "ac").includes(n)).map(entry),
    });
  });
  for (const b of facts.bugs)
    lines.push({
      what: `bug #${String(b.id)} [${b.state}]`,
      covered: mine.filter((s) => tagValue(s.tags, "bug").some((v) => sameId(v, b.id))).map(entry),
    });
  for (const t of testTypes)
    if (t !== "functional" && t !== "confirmation")
      lines.push({
        what: `type ${t}`,
        covered: mine.filter((s) => tagValue(s.tags, "type").includes(t)).map(entry),
      });
  return { ...(featurePath ? { feature: featurePath } : {}), lines };
}

/** The section of the story context the agent reads before designing. */
export function renderCoverage(c: { feature?: string; lines: CoverageLine[] }): string[] {
  const anyCovered = c.lines.some((l) => l.covered.length > 0);
  if (!anyCovered)
    return [
      "",
      "EXISTING COVERAGE: none — no scenario in the epic's feature file is tagged with this story yet. " +
        "Every design item is new.",
    ];
  const out = [
    "",
    `EXISTING COVERAGE for this story (from ${c.feature ?? "the epic's feature file"}):`,
  ];
  for (const l of c.lines)
    out.push(
      l.covered.length === 0
        ? `  ${l.what}: none`
        : `  ${l.what}: ${l.covered
            .map(
              (x) =>
                `${x.design} "${x.scenario}"${x.scripted ? "" : " (scenario only — no script yet)"}`,
            )
            .join("; ")}`,
    );
  const gaps = c.lines.filter((l) => l.covered.length === 0).map((l) => l.what);
  out.push(
    "Design from this, not from scratch:",
    "  - For everything already covered, put the existing item in the design with its EXISTING id " +
      "and the same expectation. It is recorded as already tested and is not written again.",
    gaps.length > 0
      ? `  - Propose new items only for what shows "none": ${gaps.join(", ")}.`
      : '  - Nothing shows "none": no new test cases are required. The design is the existing items ' +
          "only, and the run executes them.",
    "  - A scenario with no script yet is implemented as written — do not invent a replacement.",
  );
  return out;
}
