import type { AnyRunEvent } from "../types.js";
import type { ProposedCall } from "../runtime/model.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import { hasAgentTag } from "../verify/story-to-tests.js";
import { stripHtml } from "../runtime/render-approval.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileTextFromEvents, specPathFor, storyFacts, storyTestTitles } from "../design/test-design.js";

/**
 * Which proposed bugs survive to be put to a human, decided AFTER execution
 * finished.
 *
 * ── Why bugs wait for the end ──
 * The workflow this runtime implements says it in so many words: once
 * execution is done, the final report is read, and the user is asked whether
 * to file a bug. The loop did the opposite — it asked the moment a test had
 * failed twice, while the agent was still working on the suite.
 *
 * Observed in 20260921T142549Z: four bugs proposed mid-run, four approved, and
 * the same run then finished 5 passed / 0 failed. Every test that "proved" a
 * defect passed minutes later, because what was broken was the tests — their
 * locators. Each prompt carried the agent's own doubt ("the test locator may be
 * wrong", "a human should confirm") and each was approved anyway: a reviewer
 * asked mid-run is asked about a moving target, and cannot know the answer.
 *
 * Asked at the end, the question has an answer. A bug whose test finished
 * green is dropped without anyone being asked; what is left is put to the
 * reviewer once, next to the final result.
 */

export interface Settlement {
  keep: ProposedCall[];
  drop: Array<{ call: ProposedCall; reason: string }>;
  /** Failing tests in the final report, shown to the reviewer beside the bugs. */
  stillFailing: string[];
  /**
   * Failures in the same spec that belong to ANOTHER story under this epic.
   * The spec is shared — the responsibility is not, so these are reported and
   * never turned into this story\'s bugs.
   */
  otherStoryFailures: string[];
}

/**
 * A test's own name, before its description: "Story-c" from "Story-c — After
 * logout, navigating to the account page redirects to login", "AC-3a" from
 * "AC-3a — Log in button is disabled…".
 */
function leadingName(title: string): string {
  return (title.split(/[—:–-]\s/)[0] ?? title).trim();
}

/** Letters and digits only, lowercased — so "AC Story-a" and "Story-a" compare. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Every test title that failed in ANY run this run made. */
export function allFailedTitles(events: AnyRunEvent[]): string[] {
  const out = new Set<string>();
  for (const c of successful(completedCalls(events), "pw.run_tests"))
    for (const raw of asArray(asRecord(c.result)?.["failures"])) {
      const t = asRecord(raw)?.["title"];
      if (typeof t === "string" && t) out.add(t);
    }
  return [...out];
}

/** An "AC-2" / "AC-3b" label, as the skill names scenarios. */
const AC_LABEL = /\bAC[- ]?(\d+[a-z]?)\b/gi;

export function settleBugs(
  bugs: ProposedCall[],
  events: AnyRunEvent[],
  opts: { workItem?: string; runLevel: string | null; workspaceDir?: string },
): Settlement {
  const drop: Settlement["drop"] = [];
  const keep: ProposedCall[] = [];

  const finalRun = lastFullRun(events);
  const final = asRecord(finalRun?.result) ?? {};
  const green = final["green"] === true;
  const allFailing = failingTitles(final);
  // The epic\'s spec holds every story\'s tests. Which of these failures are
  // THIS run\'s is read from the @story tags bdd2pw carries into the spec.
  const mine = ownTestTitles(events, opts.workItem);
  const stillFailing = mine ? allFailing.filter((t) => mine.has(t)) : allFailing;
  const otherStoryFailures = mine ? allFailing.filter((t) => !mine.has(t)) : [];

  for (const call of bugs) {
    const title = bugTitle(call);

    if (opts.runLevel) {
      drop.push({
        call,
        reason: `the final run was classified "${opts.runLevel}": nothing in it measured the product`,
      });
      continue;
    }
    if (!finalRun) {
      drop.push({ call, reason: "the suite never ran to completion, so there is no final result to support it" });
      continue;
    }
    if (green || (mine && stillFailing.length === 0)) {
      drop.push({
        call,
        reason: green
          ? "the suite finished GREEN — the test this bug rests on passed"
          : "no test of THIS story is failing in the final run (the failures belong to another story in the epic\'s spec)",
      });
      continue;
    }

    // Tie the bug to a test through the acceptance-criterion label both carry.
    // No label means no provable link — the bug is kept, because dropping it
    // would be claiming something the runtime cannot show.
    //
    // From the TITLE only. Reading the repro text as well punished a thorough
    // bug: the accessibility defect of 20260923T001438Z said, under "what was
    // ruled out", that AC-1 through AC-4 had passed — so the runtime decided
    // its test was AC-1 and AC-4, found those green, and dropped a bug whose
    // own test was failing in front of it. A label is a claim about which test
    // this bug is for, and a bug makes that claim in its title.
    const labels = acLabels(title);
    if (labels.length > 0) {
      const failingLabels = new Set(stillFailing.flatMap((t) => acLabels(t)));
      if (!labels.some((l) => failingLabels.has(l))) {
        drop.push({
          call,
          reason: `its test (${labels.join(", ")}) is not failing in the final run`,
        });
        continue;
      }
    }

    // The two requirements the verifier used to check after the fact, checked
    // before a human is asked: an unlinked or unmarked bug is refused, not
    // offered.
    if (opts.workItem !== undefined && String(call.args["parentId"] ?? "") !== opts.workItem) {
      drop.push({ call, reason: `it is not linked to story ${opts.workItem} (parentId missing)` });
      continue;
    }
    if (!hasAgentTag(call.args["tags"] ?? fieldValue(call, "System.Tags"))) {
      drop.push({ call, reason: 'it does not carry the "agentic-qa" tag' });
      continue;
    }

    // What the bug says about ITS OWN TEST is checkable, and in
    // 20260923T225303Z it was wrong: the bug said the scan was "scoped to
    // /#/login" and asserted on "violations.map(v => v.id)", while the file
    // did neither — it was a spec from an earlier run, reused. A reviewer
    // reading that reasoning is being told something untrue about the
    // evidence, which is worse than a weak bug.
    const false_ = falseClaims(call, events, opts.workspaceDir);
    if (false_.length > 0) {
      drop.push({
        call,
        reason:
          `its account of its own test is wrong: it claims ${false_.join("; ")}, and the spec does not. ` +
          "Fix the test or the reasoning, then propose it again",
      });
      continue;
    }

    // A bug whose own reasoning doubts the test is not evidence about the
    // product. 20260923T235843Z filed four bugs for one failing test, and the
    // first said in as many words that "the locator may not match the actual
    // element" and carried "Confidence: Low-to-medium".
    const doubt = selfDoubt(call);
    if (doubt) {
      drop.push({
        call,
        reason:
          `its own reasoning doubts the test ("${doubt}"). A failure that might be the test's fault is ` +
          "not a product defect: confirm the test against the running page first, or report it as " +
          "something you could not verify",
      });
      continue;
    }

    keep.push(call);
  }

  // One failing test, one bug. Four proposals for the same failing test reached
  // a reviewer in 20260923T235843Z, three of them saying the same thing in
  // different words, and all four were filed.
  const byTest = new Map<string, ProposedCall>();
  // Matched against every failure the run saw, not only the ones still failing:
  // a bug about a test that was fixed mid-run must map to THAT test (and is
  // then dropped for having ended green), not to whichever test is still red.
  const candidates = [...new Set([...stillFailing, ...allFailedTitles(events)])];
  for (const call of [...keep]) {
    const key = testKey(call, candidates);
    const first = byTest.get(key);
    if (first) {
      keep.splice(keep.indexOf(call), 1);
      drop.push({
        call,
        reason: `"${bugTitle(first)}" is already proposed for the same failing test — one bug per failing test`,
      });
    } else byTest.set(key, call);
  }

  return { keep, drop, stillFailing, otherStoryFailures };
}

/**
 * The titles of this story\'s tests, from the epic spec this run wrote or read.
 *
 * Undefined when the spec carries no @story tags at all — an older suite, or a
 * project not using the shared file. Everything then behaves as it did before.
 */
/**
 * The last run that executed the WHOLE suite.
 *
 * A filtered run — `grep`, a shard, one project — is a working step, not a
 * result: it says nothing about the tests it did not execute. The report is
 * counted, and every bug judged, against the last unfiltered run
 * (20260923T235843Z settled four bugs against a one-test run).
 */
export function lastFullRun(events: AnyRunEvent[]) {
  const runs = successful(completedCalls(events), "pw.run_tests");
  const full = runs.filter((c) => !FILTERS.some((k) => c.args[k] !== undefined && c.args[k] !== ""));
  return full.pop() ?? undefined;
}

const FILTERS = ["grep", "grepInvert", "grep-invert", "shard", "project", "lastFailed", "last-failed"];

export function ownTestTitles(events: AnyRunEvent[], workItem?: string): Set<string> | undefined {
  const id = Number(workItem);
  if (!Number.isFinite(id)) return undefined;
  const facts = storyFacts(events);
  const path = facts ? specPathFor(facts) : undefined;
  const text = path ? fileTextFromEvents(events, path) : undefined;
  if (!text || !/@story:\d+/i.test(text)) return undefined;
  return storyTestTitles(text, id);
}

/**
 * Claims a bug makes about its own test that the spec contradicts.
 *
 * Only claims that can be checked by reading the file: a scoped scan, an
 * assertion on rule ids, an expected-to-fail marker, a named matcher. Prose
 * about the product is not checkable here and is left alone.
 */
export function falseClaims(call: ProposedCall, events: AnyRunEvent[], workspaceDir?: string): string[] {
  const text = stripHtml(fieldValue(call, "Microsoft.VSTS.TCM.ReproSteps") ?? "");
  if (!text) return [];
  const facts = storyFacts(events);
  const path = facts ? specPathFor(facts) : undefined;
  let spec = path ? fileTextFromEvents(events, path) : undefined;
  if (spec === undefined && path && workspaceDir) {
    try {
      spec = readFileSync(join(workspaceDir, path), "utf8");
    } catch {
      spec = undefined;
    }
  }
  if (!spec) return [];

  const out: string[] = [];
  const claims: Array<[RegExp, RegExp, string]> = [
    [/\bscoped\b|\.include\s*\(/i, /\.include\s*\(/, "the scan is scoped (.include)"],
    [/violations\s*\.\s*map|map\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*\.\s*id/i, /\.map\s*\(/, "the assertion is on rule ids (violations.map)"],
    [/\btest\.fail\b|expected[- ]to[- ]fail/i, /\btest\.fail\s*\(/, "the test is marked expected-to-fail (test.fail)"],
    [/\bwithTags\b|pinned to (the )?(rule )?tags/i, /withTags\s*\(/, "the rule tags are pinned (withTags)"],
  ];
  for (const [claimed, inSpec, said] of claims) {
    if (claimed.test(text) && !inSpec.test(spec)) out.push(said);
  }
  return out;
}

/** Phrases in which a bug admits its test might be wrong. */
const DOUBT: Array<[RegExp, string]> = [
  [/confidence:\s*(low[- ]to[- ]medium|low|medium[- ]low)/i, "confidence: low"],
  [/\b(may|might|could)\s+not\s+(match|bind|reach|be correct)/i, "the locator may not match"],
  [/\bnot\s+(independently\s+)?(confirmed|verified)\b/i, "not confirmed"],
  [/\bcould be (a |an )?(locator|test|fixture|timing)\b/i, "could be a test problem"],
];

function selfDoubt(call: ProposedCall): string | undefined {
  const text = stripHtml(fieldValue(call, "Microsoft.VSTS.TCM.ReproSteps") ?? "");
  for (const [re, said] of DOUBT) if (re.test(text)) return said;
  return undefined;
}

/**
 * The failing test a bug is about: its criterion label when it has one, else
 * the failing test whose title shares the most words with the bug's own.
 */
function testKey(call: ProposedCall, candidates: string[]): string {
  const title = bugTitle(call);
  const labels = acLabels(title);
  if (labels.length > 0) return labels.sort().join(",");

  // The name the bug puts in front of its colon — "Story-c: …",
  // "AC Story-a: …", "Accessibility: …" — is the test it is about, said
  // plainly. Compared as IDENTIFIERS rather than as whole strings: a bug titled
  // "AC Story-a: …" is about the test "Story-a — Signed-in user can log
  // out…", and requiring the title to start with the whole prefix missed it,
  // dropping a real defect as a duplicate (20260926T132210Z).
  const named = /^\s*([^:]{2,40}):/.exec(title)?.[1];
  if (named) {
    const key = squash(named);
    const hit = candidates.filter((t) => key.includes(squash(leadingName(t))));
    if (hit.length === 1) return hit[0] as string;
  }

  // Otherwise the failing test whose title shares the most words — and only
  // when one candidate wins outright by a clear margin. Story #44's three bugs
  // were all matched to one test by "most words in common" and two real defects
  // were dropped as duplicates (20260925T192122Z); a tie or a near-tie is not
  // an identification.
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const mine = words(title);
  const scored = candidates
    .map((t) => ({ test: t, score: [...words(t)].filter((w) => mine.has(w)).length }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (best && best.score >= 2 && (!second || best.score > second.score)) return best.test;
  return title;
}

export function bugTitle(call: ProposedCall): string {
  return fieldValue(call, "System.Title") ?? String(call.args["title"] ?? "(untitled)");
}

/** Normalised labels: "AC-3b", "ac 3B", "AC3b" all become "AC-3B". */
export function acLabels(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(AC_LABEL)) out.add(`AC-${(m[1] ?? "").toUpperCase()}`);
  return [...out];
}

function failingTitles(final: Record<string, unknown>): string[] {
  const tests = final["tests"];
  if (Array.isArray(tests)) {
    return tests
      .map((t) => asRecord(t) ?? {})
      .filter((t) => t["status"] === "failed")
      .map((t) => String(t["title"] ?? ""));
  }
  const failures = final["failures"];
  return Array.isArray(failures) ? failures.map((f) => String(asRecord(f)?.["title"] ?? "")) : [];
}

function fieldValue(call: ProposedCall, name: string): string | undefined {
  const f = call.args["fields"];
  if (Array.isArray(f)) {
    for (const e of f) {
      const r = asRecord(e);
      if (r?.["name"] === name && typeof r["value"] === "string") return r["value"];
    }
    return undefined;
  }
  const v = asRecord(f)?.[name];
  return typeof v === "string" ? v : undefined;
}
