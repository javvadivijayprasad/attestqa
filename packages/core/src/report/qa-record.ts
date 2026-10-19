import { forReviewer } from "../design/test-design.js";
import { createHash } from "node:crypto";
import type { AnyRunEvent } from "../types.js";
import {
  approvedDesign,
  assertionsOf,
  carriedDesign,
  testsByTitle,
} from "../design/test-design.js";
import { caseId } from "../design/cases.js";
import { storyCoverage, type ItemState, type SourceFile } from "./coverage.js";
import type { TrackerId } from "../design/ids.js";

/**
 * The QA record a Jira story gets: one sub-task whose DESCRIPTION is the
 * current test cases and whose COMMENTS are the results of each run.
 *
 * Teams without Xray or Zephyr keep test cases on a QA sub-task by hand; this
 * writes the same thing, counted from the ledger and the files — never from the
 * model's account of its work. It is a document model, not Jira markup, so the
 * adapter can render it as ADF (Cloud) or wiki text (Data Center) and the ledger
 * keeps exactly what was posted.
 */

export type QaBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "code"; text: string; language?: string };

/** Every attestqa QA sub-task starts with this, which is how story context skips it. */
export const QA_SUMMARY_PREFIX = "QA (attestqa): tests for";
/** The label the adapter finds the sub-task by. */
export const QA_LABEL = "attestqa-qa";

const RESULT: Record<ItemState, string> = {
  passing: "Passed",
  "known bug reproduced": "Known bug reproduced (fails as expected)",
  "known bug NOT reproduced": "Known bug NOT reproduced — review",
  failing: "FAILED",
  skipped: "Skipped",
  "not run": "Not run",
  "no test": "No test",
  "no scenario": "No scenario",
};

export interface QaRecord {
  storyKey: string;
  summary: string;
  description: QaBlock[];
  /** Changes only when the approved design does: the description is rewritten then and only then. */
  designHash: string;
  comment: QaBlock[];
}

/**
 * The record for this run, or undefined when there is nothing to record — no
 * approved design, or no full suite run to report.
 */
export function composeQaRecord(
  events: AnyRunEvent[],
  ctx: {
    runId: string;
    storyKey: TrackerId;
    storyTitle?: string;
    files: { features: SourceFile[]; specs: SourceFile[] };
    engineVersion?: string;
    status?: string;
  },
): QaRecord | undefined {
  const design = approvedDesign(events);
  if (!design) return undefined;
  const [story] = storyCoverage([{ runId: ctx.runId, events }], ctx.files, { story: ctx.storyKey });
  if (!story) return undefined;
  const ranSuite = story.items.some((i) => i.result?.runId === ctx.runId);

  const key = String(ctx.storyKey);
  const title = ctx.storyTitle ?? story.title ?? "";
  const scenarioOf = new Map(story.items.map((i) => [i.id, i]));
  const specFiles = [...new Set(story.items.flatMap((i) => (i.test ? [i.test.file] : [])))];

  // ---- description: the current test cases ----------------------------------
  const description: QaBlock[] = [
    {
      kind: "paragraph",
      text:
        `Test cases for ${key}${
          title ? ` — ${title}` : ""
        }, from the approved test design. Written by attestqa from its run record; each case is ` +
        "automated by the Playwright test named beside it" +
        (specFiles.length > 0 ? ` (${specFiles.join(", ")})` : "") +
        ". Results of each run are in the comments. A case's ID is the story and its design " +
        `item (${key}-D1); in the feature file and the spec it is the tag pair @story:${key} @design:D1.`,
    },
    {
      kind: "table",
      header: ["ID", "Covers", "Type / technique", "Scenario"],
      rows: design.items.map((it) => {
        const c = scenarioOf.get(it.id);
        return [
          caseId(key, it.id) + (it.expectFail ? " (known bug)" : ""),
          it.covers,
          `${it.type} / ${it.technique}`,
          c?.scenario?.title ?? "not written yet",
        ];
      }),
    },
    { kind: "heading", text: "Test cases" },
  ];
  // Each case as the Gherkin scenario its test is generated from — the BDD
  // form a tester reads and a team reviews, not a paraphrase of it. A case
  // whose scenario is not written yet (the cases are posted the moment the
  // design is approved) shows what it will check; the description is
  // refreshed once the scenario exists.
  for (const it of design.items) {
    const c = scenarioOf.get(it.id);
    description.push({
      kind: "paragraph",
      text:
        `${caseId(key, it.id)} · covers ${it.covers} · ${it.type} / ${it.technique}` +
        (it.expectFail ? " · known bug: expected to fail until fixed" : "") +
        (c?.test ? ` · automated by "${c.test.title}"` : ""),
    });
    const gherkin = c?.scenario
      ? scenarioGherkin(
          ctx.files.features.find((f) => f.path === c.scenario?.file)?.text ?? "",
          c.scenario.title,
        )
      : undefined;
    description.push(
      gherkin
        ? { kind: "code", language: "gherkin", text: gherkin }
        : {
            kind: "paragraph",
            text: `Scenario not written yet. Given ${it.conditions.join("; ")} — expected: ${
              it.expected
            }`,
          },
    );
  }
  if (design.excluded.length > 0)
    description.push(
      { kind: "heading", text: "Not tested, and why" },
      {
        kind: "table",
        header: ["What", "Reason"],
        rows: design.excluded.map((x) => [x.what, x.reason]),
      },
    );
  const designHash = createHash("sha256")
    // Over what the description says — the design and the tests automating it —
    // so it is rewritten when either changes, and left alone otherwise.
    .update(JSON.stringify(description))
    .digest("hex")
    .slice(0, 12);
  description.push({ kind: "paragraph", text: `attestqa design ${designHash}` });

  // ---- comment: this run's results ------------------------------------------
  const counts = new Map<ItemState, number>();
  for (const i of story.items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  const tally = [...counts].map(([s, n]) => `${n} ${RESULT[s].toLowerCase()}`).join(", ");
  const comment: QaBlock[] = [
    {
      kind: "heading",
      text: `Run ${ctx.runId}${ctx.status ? ` — ${ctx.status}` : ""}`,
    },
    {
      kind: "paragraph",
      text:
        `${story.items.length} test case(s): ${tally}.` +
        (ranSuite
          ? ""
          : " The suite did not run in this run; results are from the last run that did.") +
        (ctx.engineVersion ? ` attestqa ${ctx.engineVersion}.` : ""),
    },
    {
      kind: "table",
      header: ["ID", "Test", "Result", "Run"],
      rows: story.items.map((i) => [
        caseId(key, i.id),
        i.test?.title ?? "—",
        RESULT[i.state],
        i.result?.runId ?? "—",
      ]),
    },
  ];
  // What each test checks, beside what its design item expects — so a test
  // that is weaker than the design is visible to a reader even where no rule
  // can judge it (TOOL-6-D1 in 20261019T200105Z: "every card shows a name,
  // price and image" checked by one product's name and price).
  const checks = story.items.map((i) => {
    const it = design.items.find((d) => d.id === i.id);
    const spec = i.test
      ? ctx.files.specs.find(
          (sp) =>
            sp.path === i.test?.file ||
            sp.path.endsWith(`/${i.test?.file}`) ||
            i.test?.file.endsWith(sp.path),
        )
      : undefined;
    const body = spec && i.test ? testsByTitle(spec.text).get(i.test.title) : undefined;
    // The test's own Then/And steps read as sentences; the assertion code is
    // the fallback when a test has no such steps.
    const steps = body
      ? [...body.matchAll(/test\.step\(\s*"((?:[^"\\]|\\.)*)"/g)]
          .map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1"))
          .filter((t) => /^(?:\[SKIPPED\]\s*)?(?:Then|And|But)\b/.test(t))
      : [];
    const asserted = steps.length > 0 ? steps : body ? assertionsOf(body).map(shortClaim) : [];
    return [
      caseId(key, i.id),
      it?.expected ?? "—",
      asserted.length > 0
        ? asserted.slice(0, 4).join("; ") +
          (asserted.length > 4 ? ` (+${asserted.length - 4} more)` : "")
        : "no assertion found",
    ];
  });
  if (checks.length > 0)
    comment.push({
      kind: "table",
      header: ["ID", "Design expects", "Test checks"],
      rows: checks,
    });
  const review = lastVerifyLimitations(events)
    .filter((l) => l.startsWith("for your review — "))
    .map((l) => forReviewer(l.slice("for your review — ".length)));
  if (review.length > 0)
    comment.push({
      kind: "paragraph",
      text:
        "Needs review — these tests work but check less, or more broadly, than the approved design: " +
        review.join("; ") +
        ".",
    });
  if (story.uncoveredCriteria.length > 0)
    comment.push({
      kind: "paragraph",
      text: `Acceptance criteria with no test: ${story.uncoveredCriteria.join(", ")}.`,
    });
  const bugs = story.bugs.filter((b) => b.state);
  if (bugs.length > 0)
    comment.push({
      kind: "paragraph",
      text: `Known bugs at this run: ${bugs
        .map((b) => `${String(b.id)} (${b.state})`)
        .join(", ")}.`,
    });
  // The story as this run read it (design/fingerprint.ts): a later run with the
  // same fingerprint reuses this design instead of asking for a new one.
  const fingerprint = routeFingerprint(events);
  if (fingerprint) {
    const carried = carriedDesign(events);
    comment.push({
      kind: "paragraph",
      text:
        `Story fingerprint ${fingerprint}.` +
        (carried
          ? ` The story is unchanged since run ${carried.runId}; the design approved there was reused.`
          : ""),
    });
  }
  comment.push({
    kind: "paragraph",
    text: "Counted from the run ledger and the test files, not from the agent's account of its work.",
  });

  return {
    storyKey: key,
    summary: `${QA_SUMMARY_PREFIX} ${key}${title ? ` — ${title}` : ""}`.slice(0, 250),
    description,
    designHash,
    comment,
  };
}

/**
 * One scenario as Gherkin, with the feature's Background (if any) in front so
 * it reads complete on its own: everything from the `Scenario:` line to the
 * next scenario, tag line or rule. Tag lines are left out — they are for the
 * runtime, not for the reader.
 */
export function scenarioGherkin(feature: string, title: string): string | undefined {
  const lines = feature.replace(/\r\n/g, "\n").split("\n");
  const isStart = (l: string) => /^\s*(Scenario( Outline)?|Rule|Feature|Background):/i.test(l);
  const isTag = (l: string) => l.trim().startsWith("@");
  const block = (from: number): string[] => {
    const out = [lines[from]?.trim() ?? ""];
    for (let i = from + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (isStart(l) || isTag(l)) break;
      if (l.trim().startsWith("#")) continue;
      out.push(l.trim() ? `  ${l.trim()}` : "");
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  };
  const at = lines.findIndex((l) => {
    const m = /^\s*Scenario(?: Outline)?:\s*(.*)$/i.exec(l);
    return m?.[1]?.trim() === title.trim();
  });
  if (at < 0) return undefined;
  const bg = lines.findIndex((l) => /^\s*Background:/i.test(l));
  const background = bg >= 0 && bg < at ? block(bg) : [];
  return [...background, ...(background.length > 0 ? [""] : []), ...block(at)].join("\n");
}

/** The story fingerprint the run's route recorded, if any. */
function routeFingerprint(events: AnyRunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== "route") continue;
    const f = (e.payload as { because?: { fingerprint?: unknown } }).because?.fingerprint;
    if (typeof f === "string") return f;
  }
  return undefined;
}

/** One assertion, short enough for a table cell: the subject and the matcher. */
function shortClaim(a: string): string {
  // Page-object prefixes ("productCataloguePage.", "this.") add length, not meaning.
  const flat = a.replace(/\b\w*Page\.(?=\w)|\bthis\./g, "").replace(/\s+/g, " ");
  return flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
}

function lastVerifyLimitations(events: AnyRunEvent[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== "verify") continue;
    const l = (e.payload as unknown as { limitations?: unknown }).limitations;
    return Array.isArray(l) ? l.map(String) : [];
  }
  return [];
}
