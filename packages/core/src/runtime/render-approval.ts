import { asAdoBug, isBugCreate } from "../governance/bug-view.js";
import { isJiraKey } from "../design/ids.js";
import { parseDesign, renderDesign } from "../design/test-design.js";
import type { ProposedCall } from "./model.js";

/**
 * How a pending call is shown to the person deciding on it.
 *
 * ── Why this file exists ──
 * The terminal approver printed `JSON.stringify(args)` per call. For a test
 * case that is a single unbroken line carrying nine numbered steps separated by
 * "|" and "\n"; for a bug it is the same line with a paragraph of HTML inside
 * it. Observed, in a real approval (apr-0001, run 20260918T231318Z): five calls,
 * several thousand characters, `<p><strong>` and `&lt;mat-menu&gt;` inline, and
 * the reader's verdict — "it giving it very hard to read".
 *
 * That is not a cosmetic complaint. The approval gate is the place where a
 * human takes responsibility for what the agent is about to do, and a prompt
 * nobody can read gets approved on trust. An unreadable gate is a gate that has
 * been removed, slowly, without anyone deciding to remove it.
 *
 * So the rendering is part of the governance, not decoration around it. What it
 * owes the reader: the SHAPE of what is proposed (four test cases and one bug is
 * a different question from five test cases), and for each item the few facts a
 * decision actually turns on. Everything else stays out of the way — the full
 * arguments are in the ledger, where someone can go and read them afterwards
 * without being made to read them now.
 */

/** Terminal width to wrap to. Narrow enough for a split window. */
const WIDTH = 78;

export interface RenderOptions {
  /** Show every argument verbatim as well. Off by default. */
  verbose?: boolean;
  /**
   * For a test design: which items already have tests, from `coverageOf`. The
   * marks belong beside the items rather than only in the note above them — a
   * reviewer reads down the list, and "which of these is new" is the question
   * they are answering.
   */
  covered?: Map<string, { scenario: string; how: string }>;
}

export function renderApproval(calls: ProposedCall[], opts: RenderOptions = {}): string {
  const lines: string[] = [];
  const groups = groupByKind(calls);

  lines.push("", `  ${shapeLine(groups)}`, "");

  let n = 0;
  for (const c of calls) {
    n += 1;
    lines.push(...renderCall(n, c, opts).map((l) => (l ? `  ${l}` : "")));
    lines.push("");
  }

  if (opts.verbose) {
    lines.push("  ── raw arguments ─────────────────────────────────────────", "");
    for (const c of calls) lines.push(`  ${c.toolName} ${JSON.stringify(c.args)}`, "");
  }

  return lines.join("\n");
}

/**
 * One line saying what is being asked, by kind.
 *
 * A reviewer's first question is never "what are the arguments", it is "what
 * KIND of thing am I agreeing to" — and four test cases plus one bug is a
 * materially different question from five test cases, because the two carry
 * different stakes and deserve different answers.
 */
function shapeLine(groups: Map<string, ProposedCall[]>): string {
  const parts = [...groups].map(
    ([kind, cs]) => `${cs.length} ${kind}${cs.length === 1 ? "" : "s"}`,
  );
  return `Approve: ${parts.join(" + ")}`;
}

function groupByKind(calls: ProposedCall[]): Map<string, ProposedCall[]> {
  const m = new Map<string, ProposedCall[]>();
  for (const c of calls) {
    const k = kindOf(c);
    const list = m.get(k);
    if (list) list.push(c);
    else m.set(k, [c]);
  }
  return m;
}

function kindOf(c: ProposedCall): string {
  if (c.toolName === "aqa.test_design") return "test design";
  if (c.toolName === "ado.testplan_test_case_write") return "test case";
  if (isBugCreate(c)) return "BUG";
  if (c.toolName === "ado.wit_work_item_comment_write") return "comment";
  if (c.toolName.startsWith("ado.testplan_test_suite_write")) return "suite change";
  if (c.toolName.startsWith("ado.testplan_test_plan_write")) return "test plan";
  return c.toolName;
}

function renderCall(n: number, c: ProposedCall, opts: RenderOptions = {}): string[] {
  switch (kindOf(c)) {
    case "test case":
      return renderTestCase(n, c);
    case "BUG":
      return renderBug(n, asAdoBug(c));
    case "test design":
      // Stage 2: the design as a tester reads it — one line per test, its type
      // and technique, and what it expects, with where that expectation came from.
      return renderDesignCall(n, c, opts.covered);
    default:
      return [`${n}. ${c.toolName}`, ...indent(compactArgs(c.args), 3)];
  }
}

function renderDesignCall(
  n: number,
  c: ProposedCall,
  covered?: Map<string, { scenario: string; how: string }>,
): string[] {
  // A design whose every item cites the story rather than a criterion is a
  // design for a story that has none: say so above it.
  const design = parseDesign(c.args);
  const noCriteria =
    design.items.length > 0 &&
    design.items.every((i) => !/\bAC[- ]?\d/i.test(`${i.covers} ${i.source}`));
  const [head, ...rest] = renderDesign(design, { noCriteria, ...(covered ? { covered } : {}) });
  const out = [`${n}. ${head ?? "TEST DESIGN"}`];
  for (const l of rest) {
    if (!l) {
      out.push("");
      continue;
    }
    const lead = /^ */.exec(l)?.[0].length ?? 0;
    out.push(...wrap(l, 3 + lead, 3 + lead + 4));
  }
  return out;
}

/**
 * A test case as the scenario it is.
 *
 * Azure DevOps stores steps as "action|expected" pairs separated by newlines,
 * which is a storage format and not something to put in front of a person. Read
 * back as a numbered list with the expectation under each step, the same case
 * is something a tester can check against the acceptance criteria in a few
 * seconds — which is the entire question being asked.
 */
function renderTestCase(n: number, c: ProposedCall): string[] {
  const a = c.args;
  const out: string[] = wrap(`${n}. TEST CASE  ${str(a["title"]) ?? "(untitled)"}`, 0, 3);
  const linked = a["testsWorkItemId"];
  if (linked !== undefined) out.push(`   tests story AB#${String(linked)}${inProject(a)}`);

  for (const [i, step] of parseSteps(str(a["steps"]) ?? "").entries()) {
    out.push(...wrap(`${i + 1}. ${step.action}`, 6, 9));
    if (step.expected) out.push(...wrap(`→ ${step.expected}`, 9, 11));
  }
  return out;
}

export interface Step {
  action: string;
  expected: string;
}

/** Split Azure DevOps' "action|expected" step format into readable pairs. */
export function parseSteps(steps: string): Step[] {
  return steps
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // Strip the leading "1." the agent writes: the renderer numbers them, and
      // two numbering schemes on one line is worse than none.
      const body = line.replace(/^\s*\d+[.)]\s*/, "");
      const bar = body.indexOf("|");
      if (bar === -1) return { action: body, expected: "" };
      return { action: body.slice(0, bar).trim(), expected: body.slice(bar + 1).trim() };
    });
}

/**
 * A bug, reduced to the three things the decision turns on.
 *
 * Not the repro steps: those matter to whoever fixes it, and they are in the
 * ledger. The reviewer is answering one question — is this a defect in the
 * product, or a defect in the test — and what decides it is the confidence, and
 * above all what the agent says it RULED OUT. The last real bug this runtime
 * proposed was a test defect, and the sentence that gave it away was in the
 * ruled-out paragraph, buried in HTML three thousand characters into the line.
 */
function renderBug(n: number, c: ProposedCall): string[] {
  const f = fields(c.args);
  const out: string[] = wrap(
    `${n}. BUG  ${f["System.Title"] ?? str(c.args["title"]) ?? "(untitled)"}`,
    0,
    3,
  );

  const parent = c.args["parentId"];
  out.push(
    parent === undefined
      ? "   ⚠ NOT linked to any story"
      : `   linked to story ${isJiraKey(parent) ? String(parent) : `AB#${String(parent)}`}${inProject(c.args)}`,
  );

  const tags = f["System.Tags"] ?? str(c.args["tags"]) ?? "";
  if (!tags.split(";").some((t) => t.trim().toLowerCase() === "agentic-qa")) {
    out.push('   ⚠ missing the "agentic-qa" tag — a later run will read this back as fact');
  }

  const repro = stripHtml(f["Microsoft.VSTS.TCM.ReproSteps"] ?? "");
  const confidence = firstMatch(repro, /Confidence:\s*([^.]+)\./i);
  if (confidence) out.push(`   confidence: ${confidence.trim()}`);

  const ruledOut = section(repro, /What was ruled out:?/i);
  out.push("", "   WHAT IT RULED OUT — this is what decides it:");
  out.push(
    ...(ruledOut
      ? ruledOut.split("\n").flatMap((l) => wrap(l.trim(), 6, l.trim().startsWith("•") ? 8 : 6))
      : ["      (nothing stated — treat the claim as unverified)"]),
  );
  return out;
}

// ---------------------------------------------------------------- text utils

function fields(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const f = args["fields"];
  // The tool accepts fields either as [{name, value}] or as a plain object.
  if (Array.isArray(f)) {
    for (const e of f) {
      const name = str(asRecord(e)?.["name"]);
      const value = asRecord(e)?.["value"];
      if (name) out[name] = typeof value === "string" ? value : JSON.stringify(value);
    }
  } else {
    const rec = asRecord(f);
    if (rec)
      for (const [k, v] of Object.entries(rec)) out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/** HTML to something readable, keeping list items as separate lines. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text under a heading, up to the next blank-line-separated heading. */
function section(text: string, heading: RegExp): string | undefined {
  const m = heading.exec(text);
  if (!m) return undefined;
  const after = text.slice(m.index + m[0].length).trim();
  const end = after.search(/\n\s*\n/);
  const body = (end === -1 ? after : after.slice(0, end)).trim();
  return body.length > 0 ? body : undefined;
}

function firstMatch(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}

function compactArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function indent(text: string, by: number): string[] {
  return text.split("\n").flatMap((l) => wrap(l, by, by));
}

/** Wrap to WIDTH, first line at `first` spaces, the rest at `rest`. */
function wrap(text: string, first: number, rest: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let pad = " ".repeat(out.length === 0 ? first : rest);
    let line = pad;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.trim().length > 0 && line.length + 1 + word.length > WIDTH) {
        out.push(line);
        pad = " ".repeat(rest);
        line = pad + word;
      } else {
        line = line.trim().length === 0 ? line + word : `${line} ${word}`;
      }
    }
    out.push(line);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Where the write will land. A reviewer approving a bug is also approving the
 * project it is filed in, and for four bugs in one run that project was a name
 * the model made up — invisible in the prompt, so impossible to catch.
 */
function inProject(args: Record<string, unknown>): string {
  const p = args["project"];
  return typeof p === "string" && p.length > 0 ? `, in project "${p}"` : "";
}
