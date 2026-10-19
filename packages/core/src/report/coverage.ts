import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnyRunEvent } from "../types.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import {
  approvedDesign,
  scenarioDesignTags,
  scenarioStoryTags,
  storyFacts,
  testsByTitle,
  type DesignItem,
} from "../design/test-design.js";
import { includesId, normId, sameId, storyTagIds, type TrackerId } from "../design/ids.js";

/**
 * What each story's approved design asked for, and what exists and passes.
 *
 * ── Why this reads the ledger and the files, and nothing else ──
 * Coverage that comes from asking the agent is a claim; coverage that comes
 * from re-reading what a person approved (the ledger) and what is on disk (the
 * feature and spec files) is evidence. So this runs offline — no model, no
 * tracker, no browser — and every cell can be traced to a run id or a file.
 *
 * A row is matched only by tags the files carry: `@story:<id>` and
 * `@design:<Dn>`. Nothing is matched by similar wording. An item whose test
 * cannot be found that way is reported as having no test, which is the safe
 * direction — a person looks, rather than trusting a guess.
 */

export interface Ledger {
  runId: string;
  events: AnyRunEvent[];
}

export interface SourceFile {
  path: string;
  text: string;
}

export type ItemState =
  | "passing"
  | "known bug reproduced"
  | "known bug NOT reproduced"
  | "failing"
  | "skipped"
  | "not run"
  | "no test"
  | "no scenario";

export interface ItemCoverage {
  id: string;
  covers: string;
  type: string;
  technique: string;
  expectFail: boolean;
  scenario?: { title: string; file: string };
  test?: { title: string; file: string };
  result?: { status: string; runId: string };
  state: ItemState;
}

export interface StoryCoverage {
  story: TrackerId;
  title?: string;
  acceptanceCriteria: string[];
  /** The run whose approved design is in force (the latest one). */
  designRun?: string;
  items: ItemCoverage[];
  /** AC labels no item with a test covers. */
  uncoveredCriteria: string[];
  /** This story's scenarios that carry no @design id from the approved design. */
  outsideDesign: string[];
  /** Bugs the story context listed, with their state at the last run. */
  bugs: Array<{ id: TrackerId; state: string; title: string }>;
}

/** "AC-1: Choosing Account…" → "AC-1"; anything without a label is kept whole. */
function acLabel(text: string): string {
  return /^\s*(AC-\d+[a-z]?)\b/i.exec(text)?.[1]?.toUpperCase() ?? text.trim();
}

function upper(s: string): string {
  return s.toUpperCase();
}

/** Tags in the `//` comment lines directly above a test, upper-cased. */
function tagsAbove(lines: string[], at: number): string[] {
  const out: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const l = lines[i]?.trim() ?? "";
    if (!l.startsWith("//")) break;
    out.push(...(l.match(/@[\w-]+:[\w-]+/g) ?? []).map(upper));
  }
  return out;
}

/** Every test in a spec with the tags above it. */
export function specTests(
  spec: string,
): Array<{ title: string; stories: TrackerId[]; designs: string[] }> {
  const lines = spec.split("\n");
  const out: Array<{ title: string; stories: TrackerId[]; designs: string[] }> = [];
  for (const title of testsByTitle(spec).keys()) {
    const at = lines.findIndex(
      (l) => /^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(/.test(l) && l.includes(title),
    );
    if (at < 0) continue;
    const tags = tagsAbove(lines, at);
    out.push({
      title,
      stories: storyTagIds(tags.join(" ")),
      designs: tags
        .map((t) => /^@DESIGN:(D\d+(?:-\d+)?)$/.exec(t)?.[1])
        .filter((x): x is string => !!x),
    });
  }
  return out;
}

/** The latest status of every test title across all runs, with the run it came from. */
function latestResults(ledgers: Ledger[]): Map<string, { status: string; runId: string }> {
  const out = new Map<string, { status: string; runId: string }>();
  for (const { runId, events } of ledgers)
    for (const run of successful(completedCalls(events), "pw.run_tests").filter(
      // A filtered run is a working step, not a result: the QA record and the
      // terminal report read the same full runs (20261019T163019Z reported AC-1
      // "passed" from a one-test re-run while the report said failed).
      (c) =>
        ![
          "grep",
          "grepInvert",
          "grep-invert",
          "shard",
          "project",
          "lastFailed",
          "last-failed",
        ].some((k) => c.args[k] !== undefined && c.args[k] !== ""),
    ))
      for (const raw of asArray(asRecord(run.result)?.["tests"])) {
        const t = asRecord(raw);
        const title = t?.["title"];
        if (typeof title === "string" && title)
          out.set(title, { status: String(t?.["status"] ?? ""), runId });
      }
  return out;
}

function stateOf(
  item: DesignItem,
  scenario: boolean,
  test: boolean,
  result?: { status: string },
): ItemState {
  if (!test) return scenario ? "no test" : "no scenario";
  if (!result) return "not run";
  switch (result.status) {
    case "passed":
      // Before the runtime said "expected-failure", a test.fail test that
      // failed as expected was recorded as "passed".
      return item.expectFail ? "known bug reproduced" : "passing";
    case "expected-failure":
      return "known bug reproduced";
    case "unexpected-pass":
      return "known bug NOT reproduced";
    case "skipped":
      return "skipped";
    default:
      return "failing";
  }
}

export function storyCoverage(
  ledgers: Ledger[],
  files: { features: SourceFile[]; specs: SourceFile[] },
  opts: { story?: TrackerId } = {},
): StoryCoverage[] {
  const sorted = [...ledgers].sort((a, b) => a.runId.localeCompare(b.runId));
  const results = latestResults(sorted);

  // Per story: the latest facts, and the latest approved design.
  const byStory = new Map<
    string,
    { id: TrackerId; facts?: ReturnType<typeof storyFacts>; run?: Ledger }
  >();
  for (const l of sorted) {
    const facts = storyFacts(l.events);
    const id = facts?.story?.id;
    if (id === undefined || Number.isNaN(id)) continue;
    const key = String(id).toUpperCase();
    const prev = byStory.get(key) ?? { id };
    prev.facts = facts;
    if (approvedDesign(l.events)) prev.run = l;
    byStory.set(key, prev);
  }
  // Stories tagged on disk that no run has designed still appear.
  for (const f of files.features)
    for (const s of scenarioStoryTags(f.text))
      for (const id of s.stories) {
        const key = String(id).toUpperCase();
        if (!byStory.has(key)) byStory.set(key, { id });
      }

  const out: StoryCoverage[] = [];
  for (const { id, facts, run } of byStory.values()) {
    if (opts.story !== undefined && !sameId(id, opts.story)) continue;
    const design = run ? approvedDesign(run.events) : undefined;

    const scenarios = files.features.flatMap((f) => {
      const designs = scenarioDesignTags(f.text);
      return scenarioStoryTags(f.text)
        .filter((s) => includesId(s.stories, id))
        .map((s) => ({
          title: s.scenario,
          file: f.path,
          designs: designs.find((d) => d.scenario === s.scenario)?.designs ?? [],
        }));
    });
    const tests = files.specs.flatMap((f) =>
      specTests(f.text)
        .filter((t) => includesId(t.stories, id))
        .map((t) => ({ ...t, file: f.path })),
    );

    const items: ItemCoverage[] = (design?.items ?? []).map((it) => {
      const sc = scenarios.find((s) => s.designs.includes(it.id.toUpperCase()));
      const t = tests.find((x) => x.designs.includes(it.id.toUpperCase()));
      const result = t ? results.get(t.title) : undefined;
      return {
        id: it.id,
        covers: it.covers,
        type: it.type,
        technique: it.technique,
        expectFail: it.expectFail === true,
        ...(sc ? { scenario: { title: sc.title, file: sc.file } } : {}),
        ...(t ? { test: { title: t.title, file: t.file } } : {}),
        ...(result ? { result } : {}),
        state: stateOf(it, !!sc, !!t, result),
      };
    });

    const designIds = new Set(items.map((i) => i.id.toUpperCase()));
    const criteria = facts?.acceptanceCriteria ?? [];
    const tested = new Set(items.filter((i) => i.test).map((i) => acLabel(i.covers)));
    out.push({
      story: id,
      ...(facts?.story?.title ? { title: facts.story.title } : {}),
      acceptanceCriteria: criteria,
      ...(run ? { designRun: run.runId } : {}),
      items,
      uncoveredCriteria: criteria.map(acLabel).filter((l) => !tested.has(l)),
      outsideDesign: scenarios
        .filter((s) => !s.designs.some((d) => designIds.has(d)))
        .map((s) => s.title),
      bugs: facts?.bugs ?? [],
    });
  }
  return out.sort((a, b) =>
    String(a.story).localeCompare(String(b.story), undefined, { numeric: true }),
  );
}

const MARK: Record<ItemState, string> = {
  passing: "passing",
  "known bug reproduced": "known bug reproduced",
  "known bug NOT reproduced": "**known bug NOT reproduced — review**",
  failing: "**failing**",
  skipped: "skipped",
  "not run": "not run yet",
  "no test": "**no test**",
  "no scenario": "**no scenario**",
};

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Markdown a person reads: one section per story, one row per design item. */
export function renderCoverage(stories: StoryCoverage[]): string {
  const lines: string[] = ["# Test coverage", ""];
  if (stories.length === 0) {
    lines.push("No story has a recorded run or a tagged scenario in this workspace.");
    return lines.join("\n") + "\n";
  }
  lines.push(
    "| Story | Design items | Passing | Known bugs reproduced | Gaps |",
    "|---|---|---|---|---|",
  );
  for (const s of stories) {
    const n = (st: ItemState) => s.items.filter((i) => i.state === st).length;
    const gaps =
      s.items.length - n("passing") - n("known bug reproduced") + s.uncoveredCriteria.length;
    lines.push(
      `| ${cell(String(s.story))}${s.title ? ` ${cell(s.title)}` : ""} | ${s.items.length} | ${n(
        "passing",
      )} | ${n("known bug reproduced")} | ${gaps} |`,
    );
  }
  for (const s of stories) {
    lines.push("", `## ${s.story}${s.title ? ` — ${s.title}` : ""}`, "");
    if (!s.designRun) {
      lines.push(
        "No approved test design is recorded for this story — its scenarios exist on disk, " +
          'but no run has designed them. Run `aqa run "Write tests for ' +
          `${s.story}"\` to design and verify them.`,
      );
      if (s.outsideDesign.length)
        lines.push("", ...s.outsideDesign.map((t) => `- scenario on disk: ${t}`));
      continue;
    }
    lines.push(`Design approved in run \`${s.designRun}\`.`, "");
    lines.push("| Item | Covers | Type | Test | Last result |", "|---|---|---|---|---|");
    for (const i of s.items)
      lines.push(
        `| ${i.id}${i.expectFail ? " (known bug)" : ""} | ${cell(i.covers)} | ${i.type} / ${
          i.technique
        } | ` +
          `${i.test ? cell(i.test.title) : "—"} | ${MARK[i.state]}${
            i.result ? ` (\`${i.result.runId}\`)` : ""
          } |`,
      );
    if (s.uncoveredCriteria.length)
      lines.push("", `**Acceptance criteria with no test:** ${s.uncoveredCriteria.join(", ")}`);
    if (s.outsideDesign.length)
      lines.push(
        "",
        "**Scenarios outside the approved design:**",
        ...s.outsideDesign.map((t) => `- ${cell(t)}`),
      );
    const open = s.bugs.filter((b) => b.state);
    if (open.length)
      lines.push(
        "",
        "**Known bugs at the last run:** " +
          open.map((b) => `${b.id} (${b.state}) ${cell(b.title)}`).join("; "),
      );
  }
  return lines.join("\n") + "\n";
}

/** For callers that already hold a story id as text. */
export function storyIdOf(text: string | undefined): TrackerId | undefined {
  return text ? normId(text) : undefined;
}

/** Feature and spec files under a workspace, skipping what is never source. */
export function readSourceFiles(root: string): { features: SourceFile[]; specs: SourceFile[] } {
  const features: SourceFile[] = [];
  const specs: SourceFile[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    ".aqa",
    ".aqa-report",
    "test-results",
    "playwright-report",
    ".bdd2pw",
    "dist",
  ]);
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith(".feature"))
        features.push({ path: relativeTo(root, full), text: readFileSync(full, "utf8") });
      else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(name))
        specs.push({ path: relativeTo(root, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(root, 0);
  return { features, specs };
}

function relativeTo(root: string, full: string): string {
  return full
    .slice(root.length + 1)
    .split("\\")
    .join("/");
}
