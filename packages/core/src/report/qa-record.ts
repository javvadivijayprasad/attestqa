import { createHash } from "node:crypto";
import type { AnyRunEvent } from "../types.js";
import { approvedDesign } from "../design/test-design.js";
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
        ". Results of each run are in the comments.",
    },
    {
      kind: "table",
      header: ["ID", "Covers", "Type / technique", "Scenario"],
      rows: design.items.map((it) => {
        const c = scenarioOf.get(it.id);
        return [
          it.id + (it.expectFail ? " (known bug)" : ""),
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
        `${it.id} · covers ${it.covers} · ${it.type} / ${it.technique}` +
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
            text: `Scenario not written yet. Given ${it.conditions.join("; ")} — expected: ${it.expected}`,
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
        i.id,
        i.test?.title ?? "—",
        RESULT[i.state],
        i.result?.runId ?? "—",
      ]),
    },
  ];
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
