import { asAdoBug } from "../governance/bug-view.js";
import { includesId, normId, sameId, storyTagId, type TrackerId } from "../design/ids.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyRunEvent } from "../types.js";
import {
  asArray,
  asRecord,
  completedCalls,
  numberField,
  payloadOf,
  successful,
} from "../verify/evidence.js";
import { acLabels, allFailedTitles } from "../triage/settle.js";
import { missingImports } from "../framework/survey.js";
import {
  assertionsOf,
  isPartialRead,
  scenarioDesignTags,
  testsByTitle,
} from "../design/test-design.js";
import { CATCHES, stuckAction } from "../heal/locator.js";
import { routePathOf, testsPreExisted } from "../route/route.js";
import { isFullRun, suiteChangedSinceLastFullRun } from "../runtime/rerun.js";
import { hasAgentTag } from "../verify/story-to-tests.js";
import {
  approvedDesign,
  coverageOf,
  kindTagsFor,
  scenarioTags,
  featurePathFor,
  fileTextFromEvents,
  scenarioStoryTags,
  specPathFor,
  parseDesign,
  storyFacts,
  validateDesign,
  type StoryFacts,
  type TestDesign,
  type TestType,
} from "../design/test-design.js";

/**
 * Refusals the story-to-tests skill makes from what the run has already SEEN.
 *
 * These cannot live in the manifest: the manifest classifies a tool, and each
 * rule here depends on the state of this story — which criteria are covered,
 * what the runtime has already posted. They are checked before the approval
 * prompt, so a reviewer is never asked to approve something the runtime knows
 * is wrong.
 */
export function storyRefusal(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  /**
   * The workspace, when the caller knows it. Without it, a rule that compares a
   * write against the file's previous content has a baseline only for files the
   * run has already read — and a write that lands before any read is judged
   * against nothing. That hole let a quarantined test lose its failing
   * assertion in 20260925T184615Z: the claim was dropped, the test passed, and
   * nothing refused it.
   */
  opts: { workspaceDir?: string } = {},
): string | undefined {
  // A surgical edit is a write of the file it produces, and is judged as one.
  // Every rule below asks "what would this file become?", so `replace_in_file`
  // is normalised into the write it is equivalent to before any of them run —
  // otherwise a healer could drop an assertion through the edit tool that the
  // write tool would have refused.
  call = asWrite(call, events, opts.workspaceDir);
  // Likewise a Jira bug is judged as the Azure DevOps bug it amounts to, so
  // every bug rule below applies to both trackers without being copied.
  call = asAdoBug(call);
  return (
    duplicateTestCase(call, events) ??
    duplicateBug(call, events) ??
    agentRunReport(call) ??
    specBeforeScaffold(call, events) ??
    expectedFailRemoved(call, events, opts.workspaceDir) ??
    weakensAQuarantinedTest(call, events, opts.workspaceDir) ??
    alreadyRead(call, events) ??
    writesMaskedValue(call, events, opts.workspaceDir) ??
    noChangeWrite(call, events, opts.workspaceDir) ??
    writeChurn(call, events) ??
    unlinkedBug(call, events) ??
    unhealedLocator(call, events) ??
    swallowedFailure(call, events) ??
    fallbackInATest(call, events, opts.workspaceDir) ??
    unobservedClaim(call, events) ??
    unscopedAccessibilityBug(call, events) ??
    editorialOnly(call, events, opts.workspaceDir) ??
    writeOnExecutePath(call, events, opts.workspaceDir) ??
    appendOnlyAfterReroute(call, events, opts.workspaceDir) ??
    appendOnlySpec(call, events, opts.workspaceDir) ??
    misattributedKnownBug(call, events, opts.workspaceDir) ??
    staleRerun(call, events) ??
    noFramework(call, events) ??
    frameworkOwned(call) ??
    notInstalled(call, events) ??
    scratchInTheSuite(call, events) ??
    wrongEpicFile(call, events) ??
    featureFirst(call, events) ??
    unboundStepsBeforeScaffold(call, events) ??
    scaffoldWouldOverwrite(call, events, opts.workspaceDir) ??
    rewordsAnotherStory(call, events, opts.workspaceDir) ??
    dropsAnotherStory(call, events) ??
    untaggedScenario(call, events) ??
    missingKindTags(call, events) ??
    untaggedTestCase(call, events) ??
    wrongSuiteTarget(call, events)
  );
}

/**
 * The same rules plus stage 2's, when the project has test types in scope: a
 * design must be approved before any test is written, and a design is checked
 * before anyone is asked to approve it.
 */
export function makeStoryRefusal(
  opts: { testTypes?: readonly TestType[]; workspaceDir?: string } = {},
) {
  const types = opts.testTypes;
  const where = opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {};
  if (!types || types.length === 0)
    return (call: { toolName: string; args: Record<string, unknown> }, events: AnyRunEvent[]) =>
      storyRefusal(call, events, where);
  return (
    call: { toolName: string; args: Record<string, unknown> },
    events: AnyRunEvent[],
  ): string | undefined =>
    invalidDesign(call, events, types, opts.workspaceDir) ??
    designFirst(call, events) ??
    storyRefusal(call, events, where);
}

/** A design the runtime can already see is wrong never reaches the reviewer. */
function invalidDesign(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  types: readonly TestType[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "aqa.test_design") return;
  const facts = storyFacts(events);
  if (!facts)
    return "no story context was read this run, so there is nothing to check a design against";
  const design = parseDesign(call.args);
  const problems = [
    ...validateDesign(design, facts, types),
    ...takenDesignIds(design, facts, events, workspaceDir),
  ];
  if (problems.length === 0) return;
  return `the test design has ${
    problems.length
  } problem(s) — fix them and submit again:\n- ${problems.join("\n- ")}`;
}

/**
 * A design item numbered like another story's scenario in the shared epic file.
 *
 * An epic file numbers design items across all its stories. A new item that
 * reuses another story's number (SCRUM-6's accessibility item as D4, when D4 is
 * SCRUM-8's) passes the design check, is approved, and is then refused when its
 * scenario is written ("D4 would have more than one scenario") — so the agent
 * renumbers it and the reviewer is asked to approve the same design twice
 * (20261016T193254Z). Caught here, before anyone is asked.
 */
function takenDesignIds(
  design: TestDesign,
  facts: StoryFacts,
  events: AnyRunEvent[],
  workspaceDir?: string,
): string[] {
  const path = featurePathFor(facts);
  const mine = facts.story?.id;
  if (!path || mine === undefined) return [];
  const current = (p: string | undefined): string | undefined => {
    if (!p) return undefined;
    const known = lastKnownContent(p, events, workspaceDir);
    if (known !== undefined || !workspaceDir) return known;
    try {
      return readFileSync(join(workspaceDir, p), "utf8");
    } catch {
      return undefined;
    }
  };
  const feature = current(path);
  if (!feature) return [];
  const owners = scenarioStoryTags(feature);
  const designTags = scenarioDesignTags(feature);
  const taken = new Map<string, { story: TrackerId; scenario: string }>();
  let highest = 0;
  designTags.forEach((sc, i) => {
    const stories = owners[i]?.stories ?? [];
    for (const id of sc.designs) {
      highest = Math.max(highest, Number(/^D(\d+)/.exec(id)?.[1] ?? 0));
      if (stories.length > 0 && !stories.some((st) => sameId(st, mine)) && !taken.has(id))
        taken.set(id, { story: stories[0] as TrackerId, scenario: sc.scenario });
    }
  });
  for (const it of design.items)
    highest = Math.max(highest, Number(/^D(\d+)/.exec(it.id)?.[1] ?? 0));

  // An item this story's existing scenario already tests keeps that
  // scenario's number. Told only "use the next free number", the agent
  // renumbered all seven items D20–D26 while the story's own scenarios carried
  // D6–D13; the design was approved, nothing matched, and the verifier
  // blocked the run (20261016T201236Z).
  const specText = current(specPathFor(facts));
  const covered = coverageOf(design, {
    featureText: feature,
    ...(specText !== undefined ? { specText } : {}),
    story: mine,
  });
  const problems: string[] = [];
  const handled = new Set<string>();
  for (const it of design.items) {
    const hit = covered.get(it.id);
    if (!hit) continue;
    const ids = designTags.find((sc) => sc.scenario === hit.scenario)?.designs ?? [];
    if (ids.length === 0 || ids.includes(it.id.toUpperCase())) continue;
    handled.add(it.id);
    problems.push(
      `${it.id}: this story's scenario "${hit.scenario}" already tests it and carries ` +
        `@design:${ids[0]} — give the item the id ${ids[0]}, so the design matches the feature file`,
    );
  }
  // And every scenario this story already has must trace to the design, or
  // the verifier blocks the run at the end ("scenario-not-in-design") after
  // the whole suite was written against a design that left it out.
  const designIds = new Set(design.items.map((it) => it.id.toUpperCase()));
  const coveredScenarios = new Set([...covered.values()].map((v) => v.scenario));
  designTags.forEach((sc, i) => {
    const stories = owners[i]?.stories ?? [];
    if (!stories.some((st) => sameId(st, mine))) return;
    if (sc.designs.length === 0 || coveredScenarios.has(sc.scenario)) return;
    if (sc.designs.some((id) => designIds.has(id))) return;
    problems.push(
      `this story's existing scenario "${sc.scenario}" (@design:${sc.designs[0]}) is not in the design — ` +
        `add an item for it with the id ${sc.designs[0]}; every scenario of the story must trace to the approved design`,
    );
  });
  for (const it of design.items) {
    if (handled.has(it.id)) continue;
    const other = taken.get(it.id.toUpperCase());
    if (!other) continue;
    highest += 1;
    problems.push(
      `${it.id}: that number already belongs to ${other.story}'s scenario "${other.scenario}" in ${path}, ` +
        `which numbers design items across all its stories — use D${highest} (the next free number) instead`,
    );
  }
  return problems;
}

/**
 * Tests are written FROM an approved design, not before one.
 *
 * Otherwise the design is a description of tests already written — the
 * reviewer approves what exists instead of deciding what should.
 */
function designFirst(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  const path = typeof call.args["path"] === "string" ? String(call.args["path"]) : "";
  const writesTests =
    (call.toolName === "fs.write_file" && (/\.feature$/i.test(path) || isSpecPath(path))) ||
    call.toolName === "bdd2pw.scaffold" ||
    (call.toolName === "ado.testplan_test_case_write" && call.args["action"] === "create") ||
    // RUNNING them, too. The first version refused only writes, so a run that
    // found a spec already on disk executed it and skipped the design
    // altogether — until the verifier noticed, by which point the one retry
    // went on writing the design instead of fixing the test
    // (20260923T230115Z). The design comes first whether the tests are new or
    // already there: it is the statement of what this run intends to verify.
    call.toolName === "pw.run_tests";
  if (!writesTests || approvedDesign(events)) return;
  return (
    "no test design has been approved yet. Submit it with aqa.test_design first — one item per " +
    "test, with its type, technique, conditions, expected result and source. Scenarios, specs and " +
    "test cases are written from the approved design, and the suite is run against it. Tests " +
    "already on disk are no exception: say what this run intends to verify before verifying it."
  );
}

/**
 * One test case per acceptance criterion.
 *
 * The skill always said so, and the verifier checked that the agent READ the
 * existing cases — not that it avoided duplicating them. Effort, not state. So
 * cases piled up: 35-38, 59-62, 65-68, then 69-72, four criteria at a time,
 * each run adding a set. The rule is now enforced on the state: a case whose
 * title names a criterion that already has one is refused.
 */
function duplicateTestCase(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.testplan_test_case_write" || call.args["action"] !== "create") return;
  const wanted = acLabels(String(call.args["title"] ?? ""));
  if (wanted.length === 0) return;

  const covered = coveredCriteria(events);
  for (const label of wanted) {
    const existing = covered.get(label);
    if (existing) {
      return (
        `${label} already has test case ${existing.id ? `#${existing.id} ` : ""}("${
          existing.title
        }"). ` +
        "A test case is per acceptance criterion, and a second one for the same criterion is a " +
        "duplicate someone has to find and delete. If the existing case is out of date, say so in " +
        "your final report — changing it is a person's call."
      );
    }
  }
  return;
}

/** Criterion label → the test case already covering it, from everything the run has seen. */
export function coveredCriteria(
  events: AnyRunEvent[],
): Map<string, { id?: number; title: string }> {
  const out = new Map<string, { id?: number; title: string }>();
  const calls = completedCalls(events);

  // Test cases READ this run — the preflight reads the story's existing ones.
  for (const c of successful(calls, "ado.wit_work_item", "get_batch")) {
    const rec = asRecord(c.result);
    const items = asArray(rec ? (rec["value"] ?? rec["workItems"]) : payloadOf(c.result));
    for (const w of items) {
      const f = asRecord(asRecord(w)?.["fields"]) ?? {};
      if (f["System.WorkItemType"] !== "Test Case") continue;
      const title = String(f["System.Title"] ?? "");
      const id = numberField(w, "id") ?? numberField(f, "System.Id");
      for (const l of acLabels(title))
        if (!out.has(l)) out.set(l, { ...(id ? { id } : {}), title });
    }
  }

  // Test cases CREATED this run.
  for (const c of successful(calls, "ado.testplan_test_case_write", "create")) {
    const title = String(c.args["title"] ?? "");
    const id = numberField(c.result, "id", "workItemId", "testCaseId");
    for (const l of acLabels(title)) if (!out.has(l)) out.set(l, { ...(id ? { id } : {}), title });
  }
  return out;
}

/**
 * The run report is the RUNTIME's to post, once, at the end.
 *
 * The agent used to post it as its last step — which was never actually last:
 * in 20260921T192908Z it went up mid-run, the verifier then sent the agent back
 * for another attempt, and the story ended up with a report describing a run
 * that had not finished, promising a bug decision "at run close". The runtime
 * now composes and posts the report after the run and the bug decision are
 * both over.
 */
function agentRunReport(call: {
  toolName: string;
  args: Record<string, unknown>;
}): string | undefined {
  // The Jira QA record (ADR-004) is the runtime's alone: counted from the ledger.
  if (call.toolName === "jira.record_qa")
    return (
      "the QA sub-task is kept by the runtime at the end of the run, counted from the ledger — " +
      "do not post it. Put anything a reader should know in your final message."
    );
  if (call.toolName !== "ado.wit_work_item_comment_write") return;
  const text = String(call.args["text"] ?? "");
  if (!/##\s*agentic-qa run\b/i.test(text)) return;
  return (
    "the runtime posts the run report itself, once, after the run and any bug decision are " +
    "finished — do not post it. Put anything you want a reader to know in your final message; " +
    "it is included in the report."
  );
}

function isSpecPath(p: string): boolean {
  return /\.(spec|test)\.(ts|js|mts|cts|tsx)$/i.test(p);
}

function specWrite(call: { toolName: string; args: Record<string, unknown> }): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const p = call.args["path"];
  return typeof p === "string" && isSpecPath(p) ? p : undefined;
}

/**
 * A spec is generated from the feature file first, then its TODO steps are
 * implemented — never written by hand before bdd2pw has run.
 *
 * The verifier caught this after the fact, and catching it after the fact
 * cost the run its one retry (20260921T203913Z: a spec left over from an
 * earlier run was edited by hand, the verifier sent the run back, the agent
 * scaffolded and redid the work). Refusing the write up front costs one step
 * and says what to do instead.
 */
function specBeforeScaffold(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  const path = specWrite(call);
  if (!path) return;
  if (successful(completedCalls(events), "bdd2pw.scaffold").length > 0) return;
  // Path B has no scaffold by construction: the tests already exist and the
  // generator is not even offered. A spec write there is a REPAIR — a healed
  // locator, a fallback removed — and refusing it left the healer with a
  // diagnosis it could not act on (20260925T170138Z).
  if (testsPreExisted(events)) return;
  // The same holds after a re-route from B to append-only completion: the
  // tests exist, scaffold is refused for overwriting them (scaffoldWouldOverwrite
  // says "write the new tests into the existing spec"), so the new test is
  // written by hand — and appendOnlySpec polices what that write may do.
  // Run 20261012T134457Z refused both, and D5 could be written neither way.
  return (
    `no spec has been generated this run — write the scenarios to the .feature file and run ` +
    `bdd2pw.scaffold first, then implement only the steps it leaves as TODO. A spec already on ` +
    `disk from an earlier run is not a starting point: scaffold regenerates it from the feature.`
  );
}

/** How many expected-to-fail markers a spec carries. */
function expectedFailMarkers(content: string): number {
  return (content.match(/\btest\.fail\s*\(/g) ?? []).length;
}

/**
 * The expected-to-fail marker on a known bug's test is not the agent's to
 * remove.
 *
 * When such a test passes, that is a finding for a person — the bug may be
 * fixed — and the runtime reports it. Removing the marker turned the finding
 * into an ordinary pass (20260921T203913Z: Active bug #48's test passed, the
 * agent deleted its test.fail, and the report said nothing). Closing the bug,
 * and with it the marker, is a person's decision.
 */
function expectedFailRemoved(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  const path = specWrite(call);
  if (!path) return;
  const before = lastKnownContent(path, events, workspaceDir);
  if (before === undefined) return;
  const next = String(call.args["content"] ?? "");
  if (expectedFailMarkers(next) >= expectedFailMarkers(before)) return;
  return (
    "this write removes an expected-to-fail marker (test.fail) from a known bug's test. When " +
    "that test passes, the bug may be fixed — that is a finding the runtime reports to a " +
    "person, who decides whether to close the bug. Keep the marker; say in your final message " +
    "that the test passed."
  );
}

/**
 * The spec's content as this run last saw it — read or written — or
 * undefined when a scaffold has regenerated it since (its content then is
 * whatever bdd2pw wrote, which the run has not seen).
 */
function lastKnownContent(
  path: string,
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  const calls = completedCalls(events);
  // In-place edits since the last full view, newest first. They are replayed
  // onto that view, so "the file as it is now" includes them — judging a write
  // against the file before an edit judges it against something gone
  // (20261013T011552Z).
  const edits: Array<{ old: string; new: string; all: boolean }> = [];
  const replay = (base: string): string =>
    edits.reduceRight(
      (text, e) => (e.all ? text.split(e.old).join(e.new) : text.replace(e.old, e.new)),
      base,
    );
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!c || !c.ok) continue;
    if (c.toolName === "bdd2pw.scaffold") return undefined;
    if (String(c.args["path"] ?? "") !== path) continue;
    if (c.toolName === "fs.replace_in_file") {
      const o = c.args["old"];
      const n = c.args["new"];
      if (typeof o === "string" && typeof n === "string")
        edits.push({ old: o, new: n, all: c.args["all"] === true });
      continue;
    }
    if (c.toolName === "fs.write_file") return replay(String(c.args["content"] ?? ""));
    if (c.toolName === "fs.read_file") {
      // A ranged read is a fragment, never the file. See `fileTextFromEvents`.
      if (isPartialRead(c.args, c.result)) continue;
      const content = asRecord(c.result)?.["content"];
      if (typeof content === "string") return replay(content);
    }
  }
  // Edits with no full view before them: the disk is the truth.
  if (edits.length > 0 && workspaceDir) {
    try {
      return readFileSync(join(workspaceDir, path), "utf8");
    } catch {
      return undefined;
    }
  }
  // Nothing in the ledger: the file as it is on disk is the baseline. A run
  // that writes a spec without reading it first is still writing over
  // something, and that something is what the rules have to compare against.
  if (workspaceDir) {
    try {
      return readFileSync(join(workspaceDir, path), "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** What `governance/scrub.ts` puts in place of a value before the model sees it. */
const MASKS = /\[(?:EMAIL|IP|SSN|CARD|TOKEN|REDACTED|PASSWORD)\]/g;

/**
 * A write that would put a masked value into a file.
 *
 * What the agent reads has e-mail addresses, IPs and tokens replaced by
 * `[EMAIL]`, `[IP]`, `[TOKEN]`… before it sees them; the file on disk still
 * has the real values. So when the agent rewrites a whole file from what it
 * read, it writes the masks back. 20261012T185716Z: every SCRUM-8 scenario's
 * `enter "user@email.com"` came back as `enter "[EMAIL]"`, and the write was
 * (rightly) refused as rewording another story — but the refusal never said
 * why the agent's careful byte-for-byte copy kept differing.
 *
 * Judged on the write the call amounts to: an edit through
 * `fs.replace_in_file` is applied to the real content, so it only trips this
 * when the agent's own new text carries a mask.
 */
export function writesMaskedValue(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  const content = String(call.args["content"] ?? "");
  const masks = content.match(MASKS) ?? [];
  if (masks.length === 0) return;
  const before = lastKnownContent(path, events, workspaceDir) ?? "";
  if (masks.length <= (before.match(MASKS) ?? []).length) return;
  const kinds = [...new Set(masks)].join(", ");
  return (
    `this write would put ${kinds} into ${path}. Those are masks: values that look like an ` +
    "e-mail address, an IP or a token are hidden from you when you read a file, but the file " +
    "itself holds the real values, so a whole-file write from what you read replaces them " +
    "with the mask. Use fs.replace_in_file to change only your own lines — to append, old = " +
    "the file's last line, new = that line followed by your text. For a value of your own, " +
    "write a real one (or read it from an environment variable), never a mask."
  );
}

/**
 * A file the run has already read, unchanged since, is not read again.
 *
 * Observed in 20260922T231736Z: after scaffolding, the agent read
 * tests/login.spec.ts and pages/login.page.ts, thought about them, and read
 * them both again — fourteen times, two calls a cycle, until the step budget
 * was gone. The suite never ran. Nothing in the run had changed between the
 * reads, so nothing could come of them; the content was already in its own
 * history. Telling it so, and refusing the call, costs one step instead of
 * sixty.
 */
function alreadyRead(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.read_file") return;
  const path = String(call.args["path"] ?? "");
  if (!path) return;
  const window = viewOf(call.args);
  const calls = completedCalls(events);
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!c || !c.ok) continue;
    // Anything that could have changed the file ends the search: the next read
    // is a read of something new.
    if (c.toolName === "bdd2pw.scaffold") return;
    if (String(c.args["path"] ?? "") !== path) continue;
    // An in-place edit changes the file as much as a write does. 20261013T011552Z:
    // two edits succeeded, the re-read of the changed lines was refused as
    // "nothing has changed it since", and the agent's next edits — rebuilt from
    // the stale view — missed until the run stopped.
    if (c.toolName === "fs.write_file" || c.toolName === "fs.replace_in_file") return;
    if (c.toolName === "fs.read_file") {
      // A DIFFERENT window on the same file is a different read. Without this,
      // a file too long to survive the context budget could be read once,
      // truncated, and never seen again — which is how 20260928T082428Z ended
      // up reasoning about a spec it had not read from a feature file it had.
      if (viewOf(c.args) !== window) return;
      return (
        `you already read ${path}${window === "whole file" ? "" : ` (${window})`} this run and ` +
        "nothing has changed it since — its content is in your history above, and re-reading it " +
        "returns the same view. If it came back truncated, ask for the part you have not seen: " +
        "fs.read_file takes `fromLine` and `toLine`, and the result says how many lines the file " +
        "has. (Writing or editing the file, or scaffolding over it, makes it readable again.)" +
        generatedElsewhere(path, events)
      );
    }
  }
  return;
}

/** Which slice of a file a read asked for — the identity of the view, for comparison. */
function viewOf(args: Record<string, unknown>): string {
  const from = args["fromLine"];
  const to = args["toLine"];
  if (from === undefined && to === undefined) return "whole file";
  return `lines ${from ?? 1}–${to ?? "end"}`;
}

/**
 * "The scaffold wrote these files, and this is not one of them."
 *
 * 20260925T151945Z: bdd2pw generated `tests/login.spec.ts`, the agent expected
 * the epic spec, and re-read the epic spec three times — each read correctly
 * refused, each refusal silent about where the generated code actually was.
 * The refusal was right and useless. This sentence is the difference.
 */
function generatedElsewhere(path: string, events: AnyRunEvent[]): string {
  const wrote = new Set<string>();
  for (const c of successful(completedCalls(events), "bdd2pw.scaffold"))
    for (const f of asArray(asRecord(c.result)?.["wrote"])) if (typeof f === "string") wrote.add(f);
  wrote.delete(path);
  if (wrote.size === 0) return "";
  return (
    ` The last scaffold wrote ${[...wrote].map((f) => `\`${f}\``).join(", ")} — not ${path}. ` +
    "Read what it wrote, or fix where it writes."
  );
}

/** A write that changes nothing is not progress. */
function noChangeWrite(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  const path = specOrAnyWrite(call);
  if (!path) return;
  const before = lastKnownContent(path, events, workspaceDir);
  if (before === undefined || before !== String(call.args["content"] ?? "")) return;
  return (
    `this write leaves ${path} exactly as it already is. It is written; move on — implement the ` +
    "tests that are still TODO, or run the suite with pw.run_tests to find out whether what you " +
    "have works."
  );
}

/** How many times a path has been written since the last scaffold or test run. */
function writesSinceProgress(path: string, events: AnyRunEvent[]): number {
  const calls = completedCalls(events);
  let n = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!c || !c.ok) continue;
    if (c.toolName === "pw.run_tests" || c.toolName === "bdd2pw.scaffold") break;
    if (c.toolName === "fs.write_file" && String(c.args["path"] ?? "") === path) n += 1;
  }
  return n;
}

/**
 * A file rewritten over and over, with nothing run in between, is a loop.
 *
 * Observed in 20260922T232710Z: pages/login.page.ts written FORTY-FIVE times,
 * 41 of them different, while the spec kept its TODO steps and the suite never
 * ran once. The agent said so itself — "the POM has been written many times" —
 * and wrote it again. Editing a file is cheap and tells it nothing; running
 * the suite is what tells it whether the file is right.
 */
function writeChurn(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  const path = specOrAnyWrite(call);
  if (!path) return;
  const n = writesSinceProgress(path, events);
  if (n < MAX_WRITES_BEFORE_RUNNING) return;
  return (
    `you have written ${path} ${n} times without running anything in between. Editing it again ` +
    "cannot tell you whether it works — running it can. Run the suite with pw.run_tests, then " +
    "fix what the failures actually say. (If another file still has TODO steps, write that file " +
    "instead: this refusal is about this one path.)"
  );
}

/** Three attempts at one file is generous; the fourth is a loop. */
const MAX_WRITES_BEFORE_RUNNING = 3;

function specOrAnyWrite(call: {
  toolName: string;
  args: Record<string, unknown>;
}): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const p = call.args["path"];
  return typeof p === "string" && p ? p : undefined;
}

/**
 * One feature file per EPIC, and the run may not write anywhere else.
 *
 * Without this, each run names the file after whatever it is working on: two
 * stories under one epic both reach for "login.feature", and the second
 * scaffold overwrites the first story\'s scenarios — leaving Azure DevOps test
 * cases pointing at tests that no longer exist.
 */
function wrongEpicFile(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  const path = String(call.args["path"] ?? "") || String(call.args["feature"] ?? "");
  const isFeature = /\.feature$/i.test(path);
  if (call.toolName !== "fs.write_file" && call.toolName !== "bdd2pw.scaffold") return;
  if (!isFeature && !isSpecPath(path)) return;
  const facts = storyFacts(events);
  if (!facts) return;
  const want = isFeature ? featurePathFor(facts) : specPathFor(facts);
  if (!want || path === want) return;
  return (
    `this epic's tests live in one file: ${featurePathFor(facts)} (and the spec ${specPathFor(
      facts,
    )} ` +
    `bdd2pw generates from it). Write ${want}, not "${path}" — tests follow the application, not the ` +
    "backlog item, so every story under the epic adds its scenarios to the same file, tagged " +
    "@story:<id>."
  );
}

/**
 * A file written into the suite that is not part of the suite.
 *
 * 20260925T232423Z wrote `tests/read-spec-probe.ts` — a scratch file, to work
 * around not being able to see a whole file at once. Harmless in itself and
 * then left behind: Playwright's testDir picks up what matches its pattern,
 * a reviewer finds a file nobody wrote on purpose, and the next run reads it as
 * part of the project. A suite is a deliverable, not a desk.
 *
 * What belongs under the suite's directories: specs, page objects, fixtures and
 * features. Anything else is refused by name.
 */
function scratchInTheSuite(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file" && call.toolName !== "fs.replace_in_file") return;
  const path = String(call.args["path"] ?? "").replace(/\\/g, "/");
  if (!path) return;
  const facts = storyFacts(events);
  const specDir = (facts?.framework?.specDir ?? "tests").replace(/\\/g, "/");
  const inSuite = path === specDir || path.startsWith(`${specDir}/`);
  if (!inSuite) return;
  const allowed =
    /\.(spec|test)\.[cm]?[jt]sx?$/i.test(path) ||
    /\.(feature|json|md)$/i.test(path) ||
    /(^|\/)(fixtures?|helpers?|support|pages)\//i.test(path);
  if (allowed) return;
  return (
    `"${path}" is not a test, a fixture or a page object, and ${specDir}/ is the suite — a file ` +
    "left there is collected by Playwright, read by the next run and found by whoever reviews " +
    "this repo. If you need to look at a file, read it; if you need to change one, use " +
    "fs.replace_in_file on the file itself. Nothing in this run needs a scratch file."
  );
}

/** The scenarios in a feature file, by the story each is tagged with. */
function storyOfScenarios(text: string): Map<string, TrackerId[]> {
  return new Map(scenarioStoryTags(text).map((s) => [s.scenario, s.stories]));
}

/**
 * Another story\'s scenarios are not this run\'s to delete.
 *
 * The shared file only works if a run can add to it without being able to take
 * from it. What this run added, it may change; what carries another story\'s
 * tag it may not remove.
 */
function dropsAnotherStory(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.feature$/i.test(path)) return;
  const before = fileTextFromEvents(events, path);
  if (before === undefined) return;
  const mine = normId(storyFacts(events)?.story?.id);
  const next = String(call.args["content"] ?? "");
  const kept = storyOfScenarios(next);
  const lost: string[] = [];
  for (const [scenario, stories] of storyOfScenarios(before)) {
    const others = stories.filter((id) => !sameId(id, mine));
    if (others.length === 0) continue;
    if (!kept.has(scenario)) lost.push(`"${scenario}" (@story:${others.join(",")})`);
  }
  if (lost.length === 0) return;
  return (
    `this write removes ${lost.length} scenario(s) belonging to another story: ${lost.join(
      "; ",
    )}. ` +
    "They are that story's tests, in the epic's shared file. Keep them exactly as they are and add " +
    "yours alongside; if one of them looks wrong, say so in your final message — changing it is a " +
    "person's call."
  );
}

/** Every scenario says which story it belongs to, or the file cannot be shared. */
function untaggedScenario(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.feature$/i.test(path)) return;
  const mine = normId(storyFacts(events)?.story?.id);
  if (mine === undefined) return;
  const untagged = scenarioStoryTags(String(call.args["content"] ?? ""))
    .filter((x) => x.stories.length === 0)
    .map((x) => `"${x.scenario}"`);
  if (untagged.length === 0) return;
  return (
    `${untagged.length} scenario(s) carry no @story tag: ${untagged.join(
      "; ",
    )}. In a shared epic ` +
    `file the tag is what separates one story's tests from another's — tag each scenario you add ` +
    `@story:${mine}, and leave the existing tags alone.`
  );
}

/**
 * A scenario that does not say what kind of test it is.
 *
 * The design names an ISTQB type and a technique for every item; the scenario
 * that implements it should carry both, so a reader — and `--grep` — can tell a
 * security check from an accessibility scan without opening the spec. Only
 * scenarios this run ADDS are checked, and only once a design exists to take
 * the tags from.
 */
function missingKindTags(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.feature$/i.test(path)) return;
  const design = approvedDesign(events);
  if (!design) return;
  const byId = new Map(design.items.map((i) => [i.id.toUpperCase(), i]));
  const before = new Set(scenarioTags(lastKnownContent(path, events) ?? "").map((s) => s.scenario));

  const missing: string[] = [];
  for (const sc of scenarioTags(String(call.args["content"] ?? ""))) {
    if (before.has(sc.scenario)) continue;
    const id = sc.tags
      .map((t) => /^@design:(D\d+(?:-\d+)?)$/i.exec(t)?.[1]?.toUpperCase())
      .find((x): x is string => !!x);
    const item = id ? byId.get(id) : undefined;
    if (!item) continue;
    const want = kindTagsFor(item).filter(
      (t) => !sc.tags.some((h) => h.toLowerCase() === t.toLowerCase()),
    );
    if (want.length === 0) continue;
    // Say what to change, not only what is wanted: a scenario tagged
    // @type:security for a design item that is functional DOES say what kind
    // of test it is — just not the approved kind — and "needs @type:functional"
    // alone left the agent rewriting the same tag line 16 times (AB#1).
    const fixes = want.map((t) => {
      const prefix = t.slice(0, t.indexOf(":") + 1).toLowerCase();
      const wrong = sc.tags.find((h) => h.toLowerCase().startsWith(prefix));
      return wrong ? `replace ${wrong} with ${t}` : `add ${t}`;
    });
    missing.push(`"${sc.scenario}" (@design:${id}) — ${fixes.join(", ")}`);
  }
  if (missing.length === 0) return;
  return (
    `these scenarios' type/technique tags do not match the approved design: ${missing.join("; ")}. ` +
    "Each scenario carries the type and technique of the design item named in its @design tag, " +
    "exactly as approved — if the scenario is really a different kind of test, it belongs to a " +
    "different design item. Change only these tags and write the file again."
  );
}

/**
 * A test case with nothing on it to say where it came from.
 *
 * A case created by a run and a case written by a person look identical in
 * Azure DevOps a week later, and the story link alone does not say which run,
 * which epic, or what kind of test it records. The bug rule has required
 * `agentic-qa` since the day a run read its own bugs back as the product's; a
 * test case deserves the same.
 */
function untaggedTestCase(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  const isCase =
    (call.toolName === "ado.testplan_test_case_write" && call.args["action"] === "create") ||
    (call.toolName === "ado.wit_work_item_write" &&
      call.args["action"] === "create" &&
      String(call.args["workItemType"] ?? "") === "Test Case");
  if (!isCase) return;
  const facts = storyFacts(events);
  const story = facts?.story?.id;
  const epic = facts?.epic?.id;
  const tags = String(call.args["tags"] ?? fieldValue(call, "System.Tags") ?? "").toLowerCase();
  const want: string[] = [];
  if (!hasAgentTag(tags)) want.push("agentic-qa");
  if (story !== undefined && !tags.includes(`story-${story}`)) want.push(`story-${story}`);
  if (epic !== undefined && !tags.includes(`epic-${epic}`)) want.push(`epic-${epic}`);
  if (want.length === 0) return;
  const all = [
    "agentic-qa",
    ...(story !== undefined ? [`story-${story}`] : []),
    ...(epic !== undefined ? [`epic-${epic}`] : []),
  ].join("; ");
  return (
    `this test case carries no ${want.join(", ")} tag. Pass tags: "${all}" — a case nobody can ` +
    "trace to a run, a story and an epic is a case a person has to reverse-engineer six months " +
    "from now."
  );
}

/** The suite this run executes is the epic\'s spec, not whatever is lying around. */
function wrongSuiteTarget(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "pw.run_tests") return;
  const facts = storyFacts(events);
  const want = facts ? specPathFor(facts) : undefined;
  if (!want) return;
  // A filtered run is allowed WHILE WORKING — rerunning the one test you just
  // repaired is the sensible thing to do. It is simply never the run that
  // finishes the job: the report is counted, and bugs are judged, against the
  // last UNFILTERED run (20260923T235843Z settled four bugs against a
  // `grep: "Story-a"` result that had never executed the other twelve tests).
  const asked = String(call.args["spec"] ?? "");
  if (asked === want) return;
  return (
    `run the epic's spec: pass spec: "${want}". ` +
    (asked
      ? `"${asked}" is not it.`
      : "Running everything in the workspace pulls other epics' failures into this run's triage.")
  );
}

/**
 * Before the scaffold, the ONLY file a run writes is the epic\'s feature file.
 *
 * The pipeline is feature → bdd2pw.scaffold → implement the TODO steps, and
 * the scaffold REGENERATES both the spec and the page object. Repairing a page
 * object beforehand is work the scaffold is about to throw away — and in
 * 20260923T001438Z it was worse than wasted: a page object left behind by a
 * killed run had empty locators, and the agent spent its cycles mending that
 * file instead of writing the scenarios that would have regenerated it.
 */
function featureFirst(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!path) return;
  const calls = completedCalls(events);
  if (successful(calls, "bdd2pw.scaffold").length > 0) return;
  // On the execute path the feature file and the spec were both written by an
  // earlier run and the generator is not offered, so "write the feature first"
  // asks for something that must not happen: `featureWriteOnExecutePath`
  // refuses exactly that. A spec write here is a repair, and the only rule that
  // applies to it is the one about what a repair may change.
  // …and after a re-route from B, where scaffolding is refused for the same
  // reason and the new test is written by hand.
  if (testsPreExisted(events)) return;
  const facts = storyFacts(events);
  const feature = facts ? featurePathFor(facts) : undefined;
  if (!feature || path === feature) return;
  return (
    `write ${feature} first. The pipeline is feature → bdd2pw.scaffold → implement the steps it ` +
    `leaves as TODO, and the scaffold regenerates the spec and the page object — so anything you ` +
    `write to "${path}" now is about to be overwritten. Put your scenarios in the feature file, ` +
    "scaffold, and fix what the scaffold could not bind."
  );
}

/** Files that belong to the project, not to a run: its config, its manifest. */
const PROJECT_OWNED =
  /(^|\/)(playwright\.config\.[cm]?[jt]s|package(-lock)?\.json|tsconfig[^/]*\.json|\.env[^/]*)$/i;

/**
 * A run writes tests. It does not configure the project.
 *
 * Creating a second Playwright config, or editing the one that is there, is a
 * decision about the repository — where the suite points, which browsers run,
 * what the timeouts are. A story run has no business making it, and a config
 * it edited to make its own tests pass would be the clearest possible way to
 * make a green suite meaningless.
 */
function frameworkOwned(call: {
  toolName: string;
  args: Record<string, unknown>;
}): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!PROJECT_OWNED.test(path)) return;
  return (
    `${path} belongs to the project, not to this run. A run writes tests; it does not change the ` +
    "framework's configuration, its dependencies or its environment. If the tests need something " +
    "this project does not have, say so in your final message as a limitation and leave the file " +
    "alone."
  );
}

/**
 * No framework, no tests.
 *
 * Choosing a layout, fixtures, scripts and a CI hook is a one-time decision
 * about someone's repository, and it is not a side effect of "write tests for
 * story 1". Where stage 0 found nothing, the run says so and stops.
 */
function noFramework(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file" && call.toolName !== "bdd2pw.scaffold") return;
  const profile = storyFacts(events)?.framework;
  if (!profile || profile.exists !== false) return;
  return (
    "there is no Playwright framework in this workspace — no config and no specs. Its layout, " +
    "its fixtures and its scripts are a decision about this repository, not something to invent " +
    "while writing tests for a story. Stop and report that `aqa init-framework` must be run first."
  );
}

/**
 * A spec may import only what the project has installed.
 *
 * An import of a package that is not in package.json does not fail as a test
 * failure; it fails as a module error, and triage then has to guess at a
 * message about resolution rather than about the product. The honest move is
 * to say the check could not be made.
 */
function notInstalled(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!isSpecPath(path) && !/\.(page|fixture)\.[cm]?[jt]sx?$/i.test(path)) return;
  const profile = storyFacts(events)?.framework;
  if (!profile || profile.deps.length === 0) return;
  const missing = missingImports(String(call.args["content"] ?? ""), profile);
  if (missing.length === 0) return;
  return (
    `this file imports ${missing.map((m) => `"${m}"`).join(", ")}, which ${
      missing.length === 1 ? "is" : "are"
    } not in this project's package.json. A spec that imports what is not installed fails as a ` +
    "module error and says nothing about the product. Write the test without it, or leave that " +
    "check out and report it as a limitation — installing a dependency is a person's decision."
  );
}

/**
 * A bug is linked to its story and tagged, or it is not proposed.
 *
 * Both were checked at the END of the run, where the only thing left to do was
 * drop the bug: 20260923T230833Z did the whole run, found a real contrast
 * violation, wrote it up — and lost it, because `parentId` was missing. Checked
 * when the bug is proposed, the agent is told at once and fixes it.
 */
function unlinkedBug(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.wit_work_item_write" || call.args["action"] !== "create") return;
  if (String(call.args["workItemType"] ?? "") !== "Bug") return;
  const story = storyFacts(events)?.story?.id;
  const problems: string[] = [];
  if (story !== undefined && String(call.args["parentId"] ?? "") !== String(story))
    problems.push(
      `parentId: ${story} — a bug nobody can trace to a story is a bug nobody will act on`,
    );
  if (!hasAgentTag(call.args["tags"] ?? fieldValue(call, "System.Tags")))
    problems.push(
      'System.Tags: "agentic-qa" — how a later run knows this bug came from a runtime and not from a person',
    );
  if (problems.length === 0) return;
  return `this bug is missing ${
    problems.length === 1 ? "one thing" : "two things"
  }: ${problems.join("; ")}. Add ${problems.length === 1 ? "it" : "them"} and propose it again.`;
}

/**
 * The same defect, filed again.
 *
 * Bugs this runtime filed are kept out of the prompt on purpose: a run that
 * reads its own unconfirmed output as context starts treating guesses as
 * requirements. That was right, and it left a hole at the other end — the agent
 * cannot see what it filed yesterday, so it files it again. "Logout does not
 * redirect to the login page" reached Azure DevOps from 20260925T192122Z, again
 * from 20260926T132210Z, and was proposed a fourth time in 20260928T085827Z,
 * each run arguing it from scratch and each time correctly, because the
 * application had not changed.
 *
 * So the check is in code, against a list the model never sees. It is not a
 * dead end: a proposal is refused only while it reads as the SAME defect, and
 * saying what makes this one different is what gets it through. That is worth
 * more than the bug — a title that distinguishes itself is a title a human can
 * triage.
 *
 * A closed bug is left alone. If a fixed defect is failing again, a fresh
 * record is the honest thing, since this runtime has no capability to reopen
 * one.
 */
function duplicateBug(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.wit_work_item_write" || call.args["action"] !== "create") return;
  if (String(call.args["workItemType"] ?? "") !== "Bug") return;
  const title = String(call.args["title"] ?? fieldValue(call, "System.Title") ?? "").trim();
  if (!title) return;
  const filed = storyFacts(events)?.filedBugs ?? [];
  const open = filed.filter((b) => !CLOSED.has(b.state.toLowerCase()));
  const hit = open.find((b) => sameDefect(b.title, title));
  if (!hit) return;
  return (
    `#${hit.id} [${hit.state}] already says this: "${hit.title}". This proposal reads as the same ` +
    `defect, so filing it would give one finding two records and split its history.\n` +
    (hit.agent
      ? "That bug was filed by an earlier run of this runtime, which is why it is not in your " +
        "context — bugs this runtime proposed are withheld so that a run never reads its own " +
        "unconfirmed output as a requirement. It exists all the same.\n"
      : "") +
    "If it IS the same defect: say so in your report — a failing test whose bug is already open " +
    "is a confirmed, unfixed defect, and that is worth reporting. If it is genuinely a DIFFERENT " +
    "defect, the title has to show it: name the behaviour that differs, not the story it came " +
    "from. Two bugs a human cannot tell apart by title will be closed as duplicates whichever " +
    "one is real."
  );
}

/** Bug states that are done with. A defect that returns after a fix deserves its own record. */
const CLOSED = new Set(["closed", "done", "removed", "resolved"]);

/**
 * Do two bug titles describe one defect?
 *
 * Word overlap over the union, on content words. Titles for the same defect
 * across runs looked like "Story-a: Logout redirects to home page instead of
 * login page", "AC Story-a: Logout redirects to home page (/#/) instead of
 * login page (/#/login)" and "Logout does not redirect to the login page — app
 * stays on /#/": no shared phrasing, four shared content words, and the
 * unrelated bugs on the same story ("Session token survives logout", "Logout
 * flow has WCAG violations") share one at most.
 *
 * Deliberately blunt. It cannot tell "logout lands on the wrong page" from
 * "a protected page is reachable after logout", which share nearly every word —
 * so the refusal asks for a title that distinguishes them rather than claiming
 * to know.
 */
export function sameDefect(a: string, b: string): boolean {
  const x = defectWords(a);
  const y = defectWords(b);
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return shared >= 3 && shared / union >= 0.45;
}

function defectWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    const w = raw.replace(/(?:es|s)$/, "");
    if (!BUG_NOISE.has(w)) out.add(w);
  }
  return out;
}

/**
 * Vocabulary every bug title on a story shares, and which therefore separates
 * nothing: the story's own labels, and the words a tester reaches for by habit.
 */
const BUG_NOISE = new Set([
  "story",
  "bug",
  "test",
  "case",
  "when",
  "then",
  "with",
  "that",
  "thi",
  "doe",
  "after",
  "before",
  "should",
  "instead",
  "still",
  "also",
  "user",
  "page", // every UI defect happens on one
  "fail",
  "failure",
  "error",
  "issue",
  "defect",
  "expected",
  "actual",
]);

/**
 * A bug proposed while a locator failure is still unexplained.
 *
 * "A control you cannot find is a test problem" was instruction, and the run
 * that filed four bugs for a visible menu item had read that instruction. So
 * the check is mechanical instead: if the latest run holds a failure whose
 * error is a locator that matched nothing, and `aqa.heal_locator` was never
 * called for it, the page has not been consulted and no bug may be proposed.
 *
 * The gap is closeable in one call, and the tool answers the question the bug
 * would otherwise guess at: was the control there?
 */
function unhealedLocator(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.wit_work_item_write" || call.args["action"] !== "create") return;
  if (String(call.args["workItemType"] ?? "") !== "Bug") return;

  const healed = new Set(
    successful(completedCalls(events), "aqa.heal_locator").map((c) =>
      String(c.args["test"] ?? "").toLowerCase(),
    ),
  );
  const unexplained: string[] = [];
  for (const run of successful(completedCalls(events), "pw.run_tests")) {
    for (const raw of asArray(asRecord(run.result)?.["failures"])) {
      const f = asRecord(raw);
      const title = typeof f?.["title"] === "string" ? f["title"] : "";
      const message = typeof f?.["message"] === "string" ? f["message"] : "";
      if (!title || !stuckAction(message)) continue;
      const seen = [...healed].some(
        (h) => h && (title.toLowerCase().includes(h) || h.includes(title.toLowerCase())),
      );
      if (!seen && !unexplained.includes(title)) unexplained.push(title);
    }
  }
  if (unexplained.length === 0) return;
  return (
    `a locator in this run matched nothing and the page at that failure has not been read: ` +
    `${unexplained
      .map((t) => `"${t}"`)
      .join(", ")}. Call aqa.heal_locator with that test's title first. ` +
    "It says whether the control was on the page. If it was, this is a test defect and there is no bug to " +
    "file; if it was not, the answer it gives is the evidence this bug needs."
  );
}

/**
 * A bug proposed from a test that catches its own failure.
 *
 * The three false logout bugs of 20260925 all came from one spec helper:
 *
 *     const link = page.locator('a[href="#/logout"]');
 *     await link.waitFor(...).catch(async () => { await page.goto("/#/logout"); });
 *
 * The locator was wrong, the click never happened, the fallback loaded a route
 * the application does not have — and the test then reported, with a straight
 * face, that the session token survives logout. Nothing about the product was
 * measured, and the failure that reached triage was an ASSERTION failure, so
 * neither the locator rules nor `aqa.heal_locator` could see the cause.
 *
 * Hence this rule, which looks at the test rather than the error: a failing
 * test whose body recovers from its own step is not evidence, whatever it
 * asserts afterwards. Remove the fallback and the real failure surfaces —
 * usually a locator, which heals.
 *
 * `shapeProblems` refuses to WRITE such a test. This refuses to BELIEVE one
 * that is already on disk, written before that rule existed.
 */
function swallowedFailure(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.wit_work_item_write" || call.args["action"] !== "create") return;
  if (String(call.args["workItemType"] ?? "") !== "Bug") return;

  // Every spec this run read or wrote, not just the epic's expected path: the
  // failing test is judged against the file it actually lives in.
  const specs = specTextsFromEvents(events);
  if (specs.length === 0) return;

  const failing = new Set<string>();
  for (const run of successful(completedCalls(events), "pw.run_tests"))
    for (const raw of asArray(asRecord(run.result)?.["failures"])) {
      const t = asRecord(raw)?.["title"];
      if (typeof t === "string" && t) failing.add(t);
    }

  const swallowing = [...failing].filter((t) =>
    specs.some(({ text }) => {
      const body = testsByTitle(text).get(t);
      if (body === undefined) return false;
      // The fallback may sit in the test or in a helper it calls, so both count.
      return CATCHES.test(body) || CATCHES.test(helperBodies(text));
    }),
  );
  if (swallowing.length === 0) return;
  return (
    `the failing test${swallowing.length > 1 ? "s" : ""} this bug rests on ` +
    `catch${swallowing.length > 1 ? "" : "es"} its own failure and carry on: ` +
    `${swallowing
      .map((t) => `"${t}"`)
      .join(", ")}. A step wrapped in try/catch or .catch() does not fail ` +
    "where it broke — it recovers and lets the test report something about the product that was never " +
    "measured. Remove the fallback in the spec (the locator line may change; the assertions may not), " +
    "run the test again, and repair whatever then fails — a locator error heals with aqa.heal_locator. " +
    "Propose a bug only from a failure that reached its assertion honestly."
  );
}

/**
 * A spec write that wraps a step of a test in a fallback.
 *
 * 20261012T144711Z: D3 read the token before the app had stored it, so the
 * agent added a wait — the right fix — and then put `.catch(() => {})` on it.
 * The suite went green, and the verifier refused the run at the very end with
 * "the test catches its own failure and carries on". The agent had one retry
 * left and spent it elsewhere. The rule was right; it was just in the wrong
 * place. Judged here, the write is refused the moment it is proposed, while the
 * agent still has the file in front of it.
 *
 * Only a fallback the write INTRODUCES is refused. A test that already carried
 * one may be written again — removing it is exactly the repair that is wanted.
 */
export function fallbackInATest(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  const path = specWrite(call);
  if (!path) return;
  const after = testsByTitle(String(call.args["content"] ?? ""));
  const beforeText = lastKnownContent(path, events, workspaceDir);
  const before = beforeText === undefined ? new Map<string, string>() : testsByTitle(beforeText);
  const added = [...after]
    .filter(([title, body]) => CATCHES.test(body) && !CATCHES.test(before.get(title) ?? ""))
    .map(([title]) => title);
  if (added.length === 0) return;
  return (
    `${added.map((t) => `"${t}"`).join(", ")} would catch ${
      added.length > 1 ? "their" : "its"
    } own ` +
    "failure and carry on (try/catch or .catch()). A wait or an assertion that cannot be met must fail " +
    "THERE, saying so: if a wait is needed, keep the wait and drop the .catch — a timeout is the honest " +
    "result. Write the spec again without the fallback."
  );
}

/**
 * A bug that claims what no assertion observed.
 *
 * Story #44's bug read "Logout does not redirect to login page **or clear the
 * session token**". The redirect claim was evidence: that assertion ran and
 * failed. The token claim was not — it sits two lines later in the same test,
 * and a test stops at its first failed assertion, so nothing in the run ever
 * looked at the token. Approving it would have put an unverified sentence into
 * a defect record, and the fix for the redirect would have "fixed" a bug nobody
 * had measured.
 *
 * So: find the assertion that actually failed, and refuse a claim that belongs
 * to one after it. The gap closes in one rerun — with the earlier assertion
 * satisfied, or the claim removed.
 */
function unobservedClaim(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.wit_work_item_write" || call.args["action"] !== "create") return;
  if (String(call.args["workItemType"] ?? "") !== "Bug") return;
  const text = `${bugTitleOf(call)} ${stripTags(
    fieldValue(call, "Microsoft.VSTS.TCM.ReproSteps") ?? "",
  )}`;
  if (!text.trim()) return;

  const specs = specTextsFromEvents(events);
  for (const f of latestFailures(events)) {
    const body = bodyFor(f.title, specs);
    if (!body) continue;
    const asserts = assertionsOf(body);
    const failedAt = failedAssertionIndex(asserts, f.message);
    if (failedAt === -1) continue;
    const later = asserts.slice(failedAt + 1);
    if (later.length === 0) continue;
    // Words the bug is entitled to use anyway: the subject of the test (its
    // title) and anything the failure itself mentions. Without this the rule
    // fired on "logout" in a bug about the logout redirect — the word belongs to
    // the test's name, not to the assertion that never ran.
    const allowedText = `${f.title} ${f.message} ${asserts[failedAt] ?? ""}`.toLowerCase();
    // Squashed too, so "log out" in a test's name covers "logout" in the bug's.
    const allowed = `${allowedText} ${allowedText.replace(/[^a-z]/g, "")}`;
    for (const a of later) {
      const evidence = claimWords(a).filter(
        (w) => text.toLowerCase().includes(w) && !allowed.includes(w),
      );
      if (evidence.length === 0) continue;
      return (
        `this bug claims something the run did not observe. "${f.title}" stopped at its ` +
        `${ordinal(failedAt + 1)} assertion (${asserts[failedAt]}), so the later check ` +
        `expect(${a}) never ran — and the bug talks about ${evidence
          .map((w) => `"${w}"`)
          .join(", ")} anyway. Either take that claim out and file what failed, or make the ` +
        "earlier assertion pass first so the later one runs and you have evidence for both."
      );
    }
  }
  return;
}

/**
 * An accessibility bug from a scan that covered the whole page.
 *
 * An unscoped axe scan finds the storefront's problems as readily as the
 * feature's, and a defect filed from one tells a developer to look in the wrong
 * place — as happened on story #1, where a hidden input elsewhere on the page
 * was reported against the login fields. The spec rules already require a
 * scoped scan when the test is WRITTEN; this refuses the bug when the test on
 * disk does not have one.
 */
function unscopedAccessibilityBug(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "ado.wit_work_item_write" || call.args["action"] !== "create") return;
  if (String(call.args["workItemType"] ?? "") !== "Bug") return;
  const specs = specTextsFromEvents(events);
  for (const f of latestFailures(events)) {
    const body = bodyFor(f.title, specs);
    if (!body || !/\bAxeBuilder\b|\baxe\b/i.test(body)) continue;
    if (/\.include\s*\(/.test(body)) continue;
    if (!/violation|wcag|accessib/i.test(`${bugTitleOf(call)} ${f.title}`)) continue;
    return (
      `"${f.title}" scans the WHOLE page: its AxeBuilder call has no .include(...), so a violation ` +
      "it finds may belong to the site's header, footer or a storefront widget rather than to this " +
      "story. A defect that cannot say which part of the page fails sends someone looking in the " +
      "wrong place. Scope the scan to the element this story is about, re-run it, and propose the " +
      "bug from what the scoped scan reports."
    );
  }
  return;
}

/** The latest recorded failure per test title, across every run this run made. */
function latestFailures(events: AnyRunEvent[]): Array<{ title: string; message: string }> {
  const byTitle = new Map<string, { title: string; message: string }>();
  for (const run of successful(completedCalls(events), "pw.run_tests"))
    for (const raw of asArray(asRecord(run.result)?.["failures"])) {
      const f = asRecord(raw);
      const title = typeof f?.["title"] === "string" ? f["title"] : "";
      if (!f || !title) continue;
      byTitle.set(title, { title, message: typeof f["message"] === "string" ? f["message"] : "" });
    }
  return [...byTitle.values()];
}

/** One test's body, from whichever spec the run has seen. */
function bodyFor(title: string, specs: Array<{ path: string; text: string }>): string | undefined {
  for (const { text } of specs) {
    const body = testsByTitle(text).get(title);
    if (body !== undefined) return body;
  }
  return undefined;
}

/**
 * Which assertion the failure came from: the first whose own message text, or
 * failing that its matcher, appears in what Playwright reported.
 */
function failedAssertionIndex(asserts: string[], message: string): number {
  const m = message.toLowerCase();
  for (let i = 0; i < asserts.length; i++) {
    const quoted = /["'`]([^"'`]{8,})["'`]/.exec(asserts[i] ?? "")?.[1];
    if (quoted && m.includes(quoted.toLowerCase())) return i;
  }
  for (let i = 0; i < asserts.length; i++) {
    const matcher = /\.(to[A-Za-z]+)\b/.exec(asserts[i] ?? "")?.[1];
    if (matcher && m.includes(matcher.toLowerCase())) return i;
  }
  return -1;
}

/**
 * The words of an assertion's own CLAIM — the message a person wrote inside it,
 * not the code around it.
 *
 * Matching on code was wrong twice over. `expect(page.getByRole("button", {
 * name: "Show/hide account menu" })).toBeVisible()` contributed "getbyrole" and
 * "button" to the vocabulary of a check that never ran, so a bug that merely
 * described HOW it clicked Logout was refused as claiming something unobserved
 * (20260925T232423Z). A claim is what the assertion says in words; an assertion
 * with no message says nothing this rule can judge, and is skipped.
 */
function claimWords(assertion: string): string[] {
  const messages = [...assertion.matchAll(/["'`]([^"'`]{8,})["'`]/g)].map((m) => m[1] ?? "");
  if (messages.length === 0) return [];
  const stop = new Set([
    "expect",
    "await",
    "async",
    "page",
    "locator",
    "should",
    "after",
    "before",
    "value",
    "click",
    "visible",
    "contain",
    "match",
    "array",
    "received",
    "expected",
    "false",
    "true",
    "null",
    "precondition",
    "getby",
    "getbyrole",
    "getbytext",
    "button",
    "menuitem",
    "element",
  ]);
  return [
    ...new Set(
      (
        messages
          .join(" ")
          .toLowerCase()
          .match(/[a-z]{5,}/g) ?? []
      ).filter((w) => !stop.has(w)),
    ),
  ];
}

function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`;
}

/** A proposed bug's title, wherever the model put it. */
function bugTitleOf(call: { args: Record<string, unknown> }): string {
  return String(call.args["title"] ?? fieldValue(call, "System.Title") ?? "");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ");
}

/**
 * A scaffold of a feature file whose steps bdd2pw cannot bind.
 *
 * 20260925T151945Z: the agent rewrote the feature in wording bdd2pw has no rule
 * for ("When I find the Email field and enter …"), scaffolded, and got 14 tests
 * with 42 empty steps — then spent the rest of the run trying to implement
 * them. `bdd2pw.analyze` answers this question for free, before anything is
 * generated, and the fix is to reword the feature rather than to hand-write
 * what the generator could not produce.
 */
function unboundStepsBeforeScaffold(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "bdd2pw.scaffold") return;
  const feature = String(call.args["feature"] ?? "");
  if (!feature) return;
  const calls = completedCalls(events);
  // Only when THIS run wrote the feature: a feature file it found on disk was
  // scaffolded before by whoever wrote it.
  const wroteIt = successful(calls, "fs.write_file").some(
    (c) => String(c.args["path"] ?? "") === feature,
  );
  if (!wroteIt) return;

  const analyses = successful(calls, "bdd2pw.analyze").filter(
    (c) => String(c.args["feature"] ?? "") === feature,
  );
  const latest = analyses[analyses.length - 1];
  if (!latest)
    return (
      `you wrote ${feature} this run and have not analyzed it. Call bdd2pw.analyze on it first ` +
      "(same feature, same url): it reports which steps bdd2pw can bind to a real locator and " +
      "which it cannot, and costs nothing. A scaffold of a feature it cannot read produces a spec " +
      "full of empty steps, which is slower to repair than the feature is to reword."
    );
  const unbound = asArray(asRecord(latest.result)?.["unbound"]).filter(
    (x): x is string => typeof x === "string",
  );
  const count = numberField(latest.result, "unboundCount") ?? unbound.length;
  if (count === 0) return;
  return (
    `bdd2pw cannot bind ${count} step(s) in ${feature}, so scaffolding it would produce that many ` +
    `empty TODO steps:\n- ${unbound.slice(0, 6).join("\n- ")}\n` +
    "Reword those steps in the vocabulary bdd2pw knows, or add the missing field to the page " +
    "object, then analyze again. Scaffold when it reports none."
  );
}

/**
 * A scaffold over a spec that already has implemented tests.
 *
 * bdd2pw regenerates a spec from its feature file: every step it cannot bind
 * comes back as a TODO, including the ones a person or an earlier run
 * implemented by hand. On this project that would replace thirteen working
 * tests with empty ones. Generation is for a file that does not exist; a file
 * that does is edited.
 */
function scaffoldWouldOverwrite(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "bdd2pw.scaffold") return;
  const facts = storyFacts(events);
  const specPath = facts ? specPathFor(facts) : undefined;
  const text = specPath ? lastKnownContent(specPath, events, workspaceDir) : undefined;
  if (!text) return;
  const tests = testsByTitle(text);
  const implemented = [...tests].filter(
    ([, body]) => !/TODO/.test(body) && /expect\s*\(/.test(body),
  );
  if (implemented.length === 0) return;
  return (
    `${specPath} already exists and ${implemented.length} of its ${tests.size} test(s) are ` +
    "implemented. bdd2pw.scaffold REGENERATES a spec from its feature file, so this call would " +
    "replace working tests with empty TODO steps. Add the new scenarios to the feature file for " +
    "the record, then write the new tests into the existing spec beside the ones already there — " +
    "and leave those alone. Writing them by hand IS the next step here: no scaffold is coming. " +
    "Add each test with fs.replace_in_file after the spec's last test, tagged like the others."
  );
}

/**
 * A feature write that rewords another story's scenarios.
 *
 * The epic's feature file is shared: story #1's scenarios sit beside story
 * #44's. `dropsAnotherStory` catches deletion, and a run that rewrote all
 * thirteen scenarios passed it because it kept them all — with different words,
 * which is the same loss of someone else's approved work by another route.
 */
function rewordsAnotherStory(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.feature$/i.test(path)) return;
  const before = lastKnownContent(path, events, workspaceDir);
  if (before === undefined) return;
  const story = storyFacts(events)?.story?.id;
  if (story === undefined) return;

  const was = scenarioBodies(before);
  const now = scenarioBodies(String(call.args["content"] ?? ""));
  const changed: string[] = [];
  for (const [scenario, b] of was) {
    // Only other stories' scenarios are protected: this story's are this run's
    // to rewrite.
    if (b.stories.length === 0 || includesId(b.stories, story)) continue;
    const after = now.get(scenario);
    if (after && after.body.replace(/\s+/g, " ") !== b.body.replace(/\s+/g, " "))
      changed.push(scenario);
  }
  if (changed.length === 0) return;
  return (
    `this write rewords ${changed.length} scenario(s) belonging to another story: ${changed
      .slice(0, 4)
      .map((c) => `"${c}"`)
      .join(
        ", ",
      )}. They were approved and scaffolded by the run that wrote them, and their tests ` +
    "are generated from these exact steps. Change only the scenarios tagged @story:" +
    `${story}, and leave the rest of the file byte for byte as you found it. To ADD scenarios, ` +
    "use fs.replace_in_file with old = the file's last line and new = that same line followed " +
    "by your scenarios — then nothing else in the file can change."
  );
}

/** Each scenario's steps and the stories it is tagged for. */
function scenarioBodies(feature: string): Map<string, { stories: TrackerId[]; body: string }> {
  const out = new Map<string, { stories: TrackerId[]; body: string }>();
  let tags: string[] = [];
  let current: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (current !== undefined)
      out.set(current, { stories: out.get(current)?.stories ?? [], body: body.join("\n") });
    body = [];
  };
  for (const raw of feature.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@")) {
      if (current !== undefined) flush();
      current = undefined;
      tags.push(...line.split(/\s+/));
      continue;
    }
    const m = /^Scenario(?: Outline)?:\s*(.*)$/i.exec(line);
    if (m) {
      if (current !== undefined) flush();
      current = (m[1] ?? "").trim();
      out.set(current, {
        stories: tags.map(storyTagId).filter((n): n is TrackerId => n !== undefined),
        body: "",
      });
      tags = [];
      continue;
    }
    // A comment is not a step. 20261012T185716Z: the agent appended SCRUM-6's
    // scenarios after a "# --- SCRUM-6 ---" banner, the banner was counted as
    // a step of SCRUM-8's last scenario, and a pure append was refused as
    // rewording another story — nine times.
    if (current !== undefined && line && !line.startsWith("#")) body.push(line);
  }
  if (current !== undefined) flush();
  return out;
}

/**
 * `fs.replace_in_file` as the `fs.write_file` it amounts to.
 *
 * Returns the call unchanged when it is not an edit, when the file cannot be
 * read, or when `old` does not appear exactly once — the adapter refuses those
 * itself, and a rule must not invent a content it cannot derive.
 */
function asWrite(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): { toolName: string; args: Record<string, unknown> } {
  if (call.toolName !== "fs.replace_in_file") return call;
  const path = String(call.args["path"] ?? "");
  const before = call.args["old"];
  const after = call.args["new"];
  if (!path || typeof before !== "string" || typeof after !== "string") return call;
  const text = lastKnownContent(path, events, workspaceDir);
  if (text === undefined) return call;
  const hits = text.split(before).length - 1;
  // `all: true` changes every occurrence, and is judged as the write it amounts to.
  if (call.args["all"] === true && hits > 0)
    return { toolName: "fs.write_file", args: { path, content: text.split(before).join(after) } };
  if (hits !== 1) return call;
  return { toolName: "fs.write_file", args: { path, content: text.replace(before, after) } };
}

/** Every spec file this run read or wrote, with its latest content. */
function specTextsFromEvents(events: AnyRunEvent[]): Array<{ path: string; text: string }> {
  const out = new Map<string, string>();
  for (const c of completedCalls(events)) {
    if (!c.ok) continue;
    const path = String(c.args["path"] ?? "");
    if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) continue;
    if (c.toolName === "fs.write_file") out.set(path, String(c.args["content"] ?? ""));
    else if (c.toolName === "fs.read_file" && !isPartialRead(c.args, c.result)) {
      const content = asRecord(c.result)?.["content"];
      if (typeof content === "string") out.set(path, content);
    }
  }
  return [...out].map(([path, text]) => ({ path, text }));
}

/**
 * A suite file rewritten on the execute-only path.
 *
 * Path B means the tests for this story already exist and this run is here to
 * run them. Repairing a locator is part of that. Nothing else is.
 *
 * The .feature half of this rule came first (20260925T151945Z rewrote all
 * thirteen scenarios and never ran a test) and it worked — 20260928T082428Z was
 * refused when it tried to change `Then the URL contains "/#/login"` to `"/#/"`
 * to match the application. It then made the same argument against the SPEC,
 * and there was no rule: the route said "writing nothing" and the gate allowed
 * a write. The route's promise has to be the gate's rule, or it is decoration.
 *
 * So on path B a spec write is judged by what it REMOVES. Repair takes away a
 * locator that has moved and a fallback that hid the failure; both are welcome.
 * Everything else a test says is there because someone decided it should be, and
 * taking it away is authoring — which is a different run, or a conversation with
 * the product owner. Adding is never refused here: a test may be strengthened.
 *
 * Judging the change rather than the role matters. The quarantine repairs in
 * `route.test.ts` happen with no locator failure in the ledger at all, so a
 * role check would refuse them; and a heal in progress is no licence to rewrite
 * an assertion.
 */
function writeOnExecutePath(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (routePathOf(events) !== "B") return;

  if (/\.feature$/i.test(path))
    return (
      `this run took the execute path: the scenarios for this story are already written and ` +
      `scaffolded, so ${path} is not this run's to rewrite. Run the tests that exist, and repair a ` +
      "spec if a locator has moved. If a scenario is genuinely missing, say so and stop — a run " +
      "that rewrites approved scenarios is authoring, and authoring is a different run."
    );

  if (!/\.(spec|test|page)\.[cm]?[jt]sx?$/i.test(path)) return;
  const before = lastKnownContent(path, events, workspaceDir);
  const after = String(call.args["content"] ?? "");

  // A file that does not exist yet is not a repair by any reading of the word.
  if (before === undefined && workspaceDir && !existsSync(join(workspaceDir, path)))
    return (
      `this run took the execute path: this story's tests already exist, so ${path} is a new file ` +
      "and writing it is authoring. Run the tests that are there. If a scenario is genuinely " +
      "missing, say so and stop — authoring is a different run."
    );
  if (before === undefined || before === after) return;

  const gone = removedLines(before, after).filter((l) => !isComment(l));
  // An assertion is a claim even when it names a locator. "Contains a locator"
  // used to make any line repairable, so `expect(page.getByText("x"))…` could be
  // deleted on the execute path (20261013T160220Z: the D19 check was rewritten
  // through exactly that gap — faithfully, that time). A removed assertion is
  // allowed only when the same claim, locators set aside, is still there.
  const claimsAfter = new Set(
    after
      .split("\n")
      .filter((l) => /\bexpect\s*\(/.test(l))
      .map(claimOf),
  );
  const unrepairable = gone.filter((l) => {
    if (/\bexpect\s*\(/.test(l)) return !claimsAfter.has(claimOf(l));
    return !LOCATOR_EXPR.test(l) && !CATCHES.test(l);
  });
  if (unrepairable.length === 0) return;
  return (
    `this run took the execute path: ${path} already contains this story's tests, and this run is ` +
    "here to run them. Repairing one is allowed — a locator that has moved, a fallback that hid " +
    `the failure — but this write takes away ${unrepairable.length} line(s) that are neither:\n` +
    unrepairable
      .slice(0, 4)
      .map((l) => `    ${l.trim()}`)
      .join("\n") +
    "\nA test may be strengthened; it may not be softened. If a test asserts the wrong thing, " +
    "that is a conversation with the product owner and not an edit: leave it red and report it. " +
    "If a test is genuinely missing, say so and stop — writing one is authoring, and authoring " +
    "is a different run."
  );
}

/**
 * The suite, run again, against bytes that have not moved.
 *
 * The runtime runs the suite itself when a run would see something new
 * (`Skill.autoRun`). In 20260928T082428Z it did so, the model then asked for the
 * identical unfiltered run with nothing changed in between, and got it: twenty
 * seconds of the application's time and a step, to print the same three numbers.
 * The runtime had the condition and the gate did not.
 *
 * Both now read it from the same place, so the rule is exactly the inverse of
 * the runtime's own decision. A filtered run is never refused — that is the
 * healer proving one test, and proving it twice is cheap and sometimes the
 * point.
 */
function staleRerun(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
): string | undefined {
  if (call.toolName !== "pw.run_tests") return;
  if (!isFullRun(call.args)) return;
  const { lastFullRun, changed } = suiteChangedSinceLastFullRun(events);
  if (lastFullRun === undefined || changed.length > 0) return;
  return (
    "the full suite has already run this run, and nothing in the suite has changed since — no " +
    "spec, no page object, no feature. Running it again executes the same code against the same " +
    "application and prints the same numbers. The result you have is the current one; it is in " +
    "your history above. If you meant to prove one test, run it with grep. If you meant to change " +
    "something first, change it — the runtime will run the suite itself once you have."
  );
}

/** A Playwright locator, as it appears in a line of a spec. */
/** An assertion line with its locators set aside: what it claims, not where it looks. */
function claimOf(line: string): string {
  return line.replace(LOCATOR_CALL, "<locator>").replace(/["'`]/g, '"').replace(/\s+/g, " ").trim();
}

const LOCATOR_EXPR = /getBy[A-Z]\w*\s*\(|\.locator\s*\(|frameLocator\s*\(|\$\$?\s*\(/;

/**
 * A write whose only change is prose, while a test is failing.
 *
 * 20260928T082428Z is the whole argument. The agent decided Story-a's
 * expectation was wrong because the application disagreed with it, was refused
 * at the feature file, and then wrote this to the spec — the assertion
 * untouched, the comment above it replaced with "redirecting to login is not
 * required by the story". Every guard passed: `weakensAQuarantinedTest`
 * compares assertions, and a comment has none.
 *
 * The write was harmless in that run and poisonous in the next one, which would
 * read the comment as context and find it two lines above an assertion saying
 * the opposite. A failing test may be repaired or left standing. It may not be
 * annotated into agreement with the application.
 */
function editorialOnly(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.(spec|test|page)\.[cm]?[jt]sx?$|\.feature$/i.test(path)) return;
  const before = lastKnownContent(path, events, workspaceDir);
  const after = String(call.args["content"] ?? "");
  if (before === undefined || before === after) return;
  const moved = changedLines(before, after);
  if (moved.length === 0) return;
  if (!moved.every((l) => isComment(l))) return;
  const failing = allFailedTitles(events);
  if (failing.length === 0) return;
  return (
    `every line this changes in ${path} is a comment, and ${
      failing.length === 1 ? `"${failing[0]}" is` : `${failing.length} tests are`
    } failing. A comment cannot make a failing test pass and cannot make a wrong ` +
    "expectation right — it only records an opinion for the next run to read as fact. Either " +
    "repair what the test does, or leave the failure standing and report it. Whether the " +
    "expectation itself is correct is the product owner's call, and it is not settled by the " +
    "application disagreeing with it."
  );
}

/** Lines present in `after` but not in `before`, and the reverse — order ignored. */
function changedLines(before: string, after: string): string[] {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split("\n")) {
      const k = l.trim();
      if (k === "") continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  const out: string[] = [];
  for (const [line, n] of b) {
    const was = a.get(line) ?? 0;
    for (let i = 0; i < n - was; i++) out.push(line);
  }
  for (const [line, n] of a) {
    const now = b.get(line) ?? 0;
    for (let i = 0; i < n - now; i++) out.push(line);
  }
  return out;
}

/** Lines `before` had that `after` does not — what the write takes away. */
function removedLines(before: string, after: string): string[] {
  const kept = new Map<string, number>();
  for (const l of after.split("\n")) {
    const k = l.trim();
    if (k === "") continue;
    kept.set(k, (kept.get(k) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const l of before.split("\n")) {
    const k = l.trim();
    if (k === "") continue;
    const n = kept.get(k) ?? 0;
    if (n > 0) kept.set(k, n - 1);
    else out.push(k);
  }
  return out;
}

/** A comment line, in TypeScript or in Gherkin. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Helpers a test calls sit outside its body, and that is exactly where the
 * logout fallback lived. Everything in the file that is not inside a test is
 * shared code, so a failing test is judged against it too.
 */
function helperBodies(spec: string): string {
  const firstTest = spec.search(/\btest(?:\.(?:only|skip|fixme|fail|slow))?\s*\(/);
  return firstTest === -1 ? spec : spec.slice(0, firstTest);
}

function fieldValue(call: { args: Record<string, unknown> }, name: string): string | undefined {
  const f = call.args["fields"];
  if (Array.isArray(f)) {
    for (const e of f) {
      const r = asRecord(e);
      if (r?.["name"] === name) return String(r["value"] ?? "");
    }
  }
  const v = asRecord(f)?.[name];
  return typeof v === "string" ? v : undefined;
}

/** Test names triage has quarantined as defect candidates, latest verdict first. */
function quarantinedTitles(events: AnyRunEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "triage") continue;
    const p = e.payload as unknown as { verdicts?: Array<{ test?: string; category?: string }> };
    for (const v of p.verdicts ?? []) {
      if (v.category !== "real-defect" || !v.test) continue;
      // "file › suite › title" — the title is what the spec calls it.
      out.add(v.test.split("›").pop()?.trim() ?? v.test);
    }
  }
  return out;
}

/**
 * A heal changes the LOCATOR. It does not change what the test claims.
 *
 * This is the rule self-healing needs before self-healing exists. "Fix the
 * test until it passes" and "weaken the test until it passes" look identical
 * from outside, and the second quietly deletes the defect the run just found.
 * So for a test triage has quarantined as a defect candidate, the selectors
 * may be rewritten freely and the assertions may not change at all.
 */
function weakensAQuarantinedTest(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!isSpecPath(path)) return;
  const before = lastKnownContent(path, events, workspaceDir);
  if (before === undefined) return;
  const quarantined = quarantinedTitles(events);
  if (quarantined.size === 0) return;

  const was = testsByTitle(before);
  const now = testsByTitle(String(call.args["content"] ?? ""));
  for (const title of quarantined) {
    const a = was.get(title);
    if (a === undefined) continue;
    const b = now.get(title);
    if (b === undefined)
      return (
        `"${title}" is quarantined as a defect candidate and this write removes it. A failing test ` +
        "that found something is not deleted to make the run green — leave it, and report the defect."
      );
    // Only what is LOST matters. The first version of this compared the two
    // assertion lists for equality, which made every repair illegal: removing
    // a `.catch()` fallback and asserting the precondition that the fallback
    // had been hiding ADDS a claim, and the rule refused it four times in a row
    // while the agent said, correctly, what it was trying to do
    // (20260925T172809Z). A test may be strengthened under quarantine; it may
    // not be weakened.
    const kept = new Set(assertionsOf(b));
    // A locator inside the assertion may be healed: `expect(<locator>).toBeEnabled()`
    // keeps its claim when only <locator> changes to one the heal tool read off
    // the page. 20261012T220131Z: the claim's own refusal said "repair the
    // locator by all means", then refused exactly that repair three times,
    // because the wrong name sat inside expect(…) rather than on its own line.
    const healed = healCandidates(events);
    const lost = assertionsOf(a).filter(
      (x) => !kept.has(x) && !assertionsOf(b).some((y) => sameClaimHealed(x, y, healed)),
    );
    if (lost.length > 0)
      return (
        `"${title}" is quarantined as a defect candidate, and this write drops ${
          lost.length === 1 ? "the claim" : "claims"
        } it made: ${lost
          .map((x) => `expect(${x})`)
          .join("; ")}. Repair the locator by all means — that is ` +
        "what the page snapshot is for — and add any check you need, but the claim the test already " +
        "makes is not yours to soften or reword. If the expectation itself is wrong, say so in your " +
        "final message; changing it is a person's call."
      );
  }
  return;
}

/** A Playwright locator expression, with any `page.` prefix. */
const LOCATOR_CALL = /(?:\bpage\.)?\b(?:getBy[A-Za-z]+|locator)\((?:[^()]|\([^()]*\))*\)/g;

function normLocator(expr: string): string {
  return expr
    .replace(/^page\./, "")
    .replace(/["'`]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Every locator `aqa.heal_locator` offered from a page this run. */
function healCandidates(events: AnyRunEvent[]): Set<string> {
  const out = new Set<string>();
  for (const c of successful(completedCalls(events), "aqa.heal_locator"))
    for (const raw of asArray(asRecord(c.result)?.["candidates"])) {
      const e = asRecord(raw)?.["expression"];
      if (typeof e === "string") out.add(normLocator(e));
    }
  return out;
}

/**
 * The same claim about a healed element: identical once locators are set
 * aside, and every locator that changed is one the heal tool offered.
 */
function sameClaimHealed(before: string, after: string, healed: Set<string>): boolean {
  if (healed.size === 0) return false;
  const was = before.match(LOCATOR_CALL) ?? [];
  const now = after.match(LOCATOR_CALL) ?? [];
  if (was.length === 0 || was.length !== now.length) return false;
  if (before.replace(LOCATOR_CALL, "<locator>") !== after.replace(LOCATOR_CALL, "<locator>"))
    return false;
  return now.every(
    (n, i) => normLocator(n) === normLocator(was[i] ?? "") || healed.has(normLocator(n)),
  );
}

/** The last route event's `because`, when it has one. */
function lastRouteBecause(events: AnyRunEvent[]): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "route")
      return asRecord((e.payload as unknown as Record<string, unknown>)["because"]) ?? undefined;
  }
  return undefined;
}

/**
 * After a re-route from "execute" to "complete", the feature file may only
 * GROW: the scenarios for the new design items are added, every scenario that
 * was there stays byte for byte (whitespace aside). Authoring the missing items
 * is the point; rewriting approved ones is not.
 */
export function appendOnlyAfterReroute(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.feature$/i.test(path)) return;
  const because = lastRouteBecause(events);
  if (routePathOf(events) !== "A2" || because?.["appendOnly"] !== true) return;
  const missing = asArray(because["missing"]).map(String);
  const content = String(call.args["content"] ?? "");
  const now = scenarioBodies(content);

  // 1. Every scenario that existed when the run switched stays as it was.
  const changed: string[] = [];
  for (const raw of asArray(because["locked"])) {
    const l = asRecord(raw);
    const scenario = String(l?.["scenario"] ?? "");
    const body = String(l?.["body"] ?? "");
    const after = now.get(scenario);
    if (!after || norm(after.body) !== body) changed.push(scenario);
  }
  if (changed.length > 0)
    return (
      `this run may only ADD scenarios for the new design items (${missing.join(", ")}); ` +
      `${changed.length} scenario(s) that existed before would change or disappear: ` +
      `${changed
        .map((s) => `"${s}"`)
        .join("; ")}. Keep them exactly as they are and add the new ones after them.`
    );

  // 2. One scenario per new design item — a second is a draft that was not removed.
  const tagged = scenarioDesignTags(content);
  const dupes = missing.filter(
    (id) => tagged.filter((s) => s.designs.includes(id.toUpperCase())).length > 1,
  );
  if (dupes.length > 0)
    return (
      `${dupes.join(
        ", ",
      )} would have more than one scenario. Each new design item gets exactly one: ` +
      "replace the draft you wrote instead of adding another beside it."
    );

  // 3. Once every new item has its scenario, the next step is the generator,
  //    not another edit — unless bdd2pw.analyze has spoken since the last edit.
  const before = lastKnownContent(path, events, workspaceDir) ?? "";
  const had = scenarioDesignTags(before);
  const allWritten = missing.every((id) => had.some((s) => s.designs.includes(id.toUpperCase())));
  if (allWritten && !analyzedSinceLastFeatureWrite(events, path))
    return (
      `the scenario for ${missing.join(
        ", ",
      )} is already written. The next step is bdd2pw.analyze ` +
      "on this feature (it says which steps it can bind), then bdd2pw.scaffold. Change the scenario " +
      "only if analyze reports a step it cannot bind."
    );
  return undefined;
}

/**
 * A known-bug marker on a test that is not that bug's test.
 *
 * `test.fail(true, "Bug #X …")` turns a failure into a pass: it says "this test
 * is expected to fail because bug X is open". On the test written for bug X
 * (tagged @bug:X) that is the honest record of a known defect. On any other
 * failing test it relabels an unexplained failure as a known one and makes it
 * green — run 20261011T232250Z put SCRUM-12's marker on the token-removal test,
 * whose own precondition was failing, and the suite went 4/4.
 */
export function misattributedKnownBug(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) return;
  const before = lastKnownContent(path, events, workspaceDir) ?? "";
  const after = String(call.args["content"] ?? "");
  const wrong: string[] = [];
  for (const m of knownBugMarkers(after)) {
    if (knownBugMarkers(before).some((b) => b.test === m.test && sameId(b.bug, m.bug))) continue;
    if (!m.bugTags.some((t) => sameId(t, m.bug)))
      wrong.push(`"${m.test}" (marked for bug ${m.bug})`);
  }
  if (wrong.length === 0) return;
  return (
    `a known-bug marker (test.fail) was added to a test that is not that bug's test: ` +
    `${wrong.join("; ")}. test.fail makes a failing test pass; on a test that does not carry ` +
    "@bug:<id> it hides an unexplained failure behind a known defect. Mark only the test written " +
    "for the bug (tagged @bug:<id>). A different test that fails stays failing until it is " +
    "repaired or a person rules on it."
  );
}

/** Each test.fail(…"Bug #X"…) with its test title and the @bug tags above the test. */
export function knownBugMarkers(
  spec: string,
): Array<{ test: string; bug: string; bugTags: TrackerId[] }> {
  const out: Array<{ test: string; bug: string; bugTags: TrackerId[] }> = [];
  let tags: string[] = [];
  let current: { test: string; bugTags: TrackerId[] } | undefined;
  for (const line of spec.split("\n")) {
    if (/^\s*\/\//.test(line)) {
      tags.push(line);
      continue;
    }
    const t = /^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(["'`])([\s\S]*?)\1/.exec(line);
    if (t) {
      const bugTags = tags
        .flatMap((l) => [...l.matchAll(/@bug:([A-Za-z][A-Za-z0-9_]+-\d+|\d+)/gi)].map((m) => m[1]))
        .map((x) => normId(x))
        .filter((x): x is TrackerId => x !== undefined);
      current = { test: (t[2] ?? "").trim(), bugTags };
      tags = [];
      continue;
    }
    if (line.trim()) tags = [];
    const f =
      /\btest\.fail\s*\(\s*true\s*,\s*(["'`])[^"'`]*?\bbug\s*#?\s*([A-Za-z][A-Za-z0-9_]+-\d+|\d+)/i.exec(
        line,
      );
    if (f && current && f[2]) out.push({ test: current.test, bug: f[2], bugTags: current.bugTags });
  }
  return out;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The scenarios of a feature file as `{ scenario, body }`, bodies whitespace-normalised. */
export function lockedScenarios(feature: string): Array<{ scenario: string; body: string }> {
  return [...scenarioBodies(feature)].map(([scenario, b]) => ({ scenario, body: norm(b.body) }));
}

/** True when a successful bdd2pw.analyze ran after the last write to this feature. */
function analyzedSinceLastFeatureWrite(events: AnyRunEvent[], path: string): boolean {
  const calls = completedCalls(events);
  let lastWrite = -1;
  let lastAnalyze = -1;
  for (const c of calls) {
    if (!c.ok) continue;
    const p = String(c.args["path"] ?? c.args["feature"] ?? "");
    if ((c.toolName === "fs.write_file" || c.toolName === "fs.replace_in_file") && p === path)
      lastWrite = c.eventId;
    if (c.toolName === "bdd2pw.analyze" && p === path) lastAnalyze = c.eventId;
  }
  return lastAnalyze > lastWrite;
}

/**
 * A spec write during append-only completion: the tests that were there stay,
 * with every assertion they had; each test that is new carries the @design tag
 * of one of the items being completed.
 */
export function appendOnlySpec(
  call: { toolName: string; args: Record<string, unknown> },
  events: AnyRunEvent[],
  workspaceDir?: string,
): string | undefined {
  if (call.toolName !== "fs.write_file") return;
  const path = String(call.args["path"] ?? "");
  if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) return;
  const because = lastRouteBecause(events);
  // Completing a re-routed story, or adding a new story to a spec other
  // stories already fill: either way the tests that are there stay as they are.
  if (routePathOf(events) !== "A2") return;
  const shared = because?.["sharedSpec"] === true;
  if (because?.["appendOnly"] !== true && !shared) return;
  const before = lastKnownContent(path, events, workspaceDir);
  if (before === undefined) return;
  const after = String(call.args["content"] ?? "");
  const was = testsByTitle(before);
  const now = testsByTitle(after);

  const lost: string[] = [];
  const weakened: string[] = [];
  for (const [title, body] of was) {
    const next = now.get(title);
    if (next === undefined) {
      lost.push(title);
      continue;
    }
    const expects = (b: string) =>
      b
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /\bexpect\s*\(/.test(l));
    const kept = new Set(expects(next));
    if (expects(body).some((l) => !kept.has(l))) weakened.push(title);
  }
  if (lost.length > 0 || weakened.length > 0)
    return (
      "while completing the new design items, the tests already in this spec stay as they are: " +
      [
        lost.length
          ? `${lost.length} would disappear (${lost.map((x) => `"${x}"`).join("; ")})`
          : "",
        weakened.length
          ? `${weakened.length} would lose an assertion (${weakened
              .map((x) => `"${x}"`)
              .join("; ")})`
          : "",
      ]
        .filter(Boolean)
        .join("; ") +
      ". Add the new test beside them; repair an existing one only by changing a locator."
    );

  const missing = asArray(because?.["missing"]).map((x) => String(x).toUpperCase());
  const story = String(because?.["story"] ?? "").toUpperCase();
  const untagged = [...now.keys()]
    .filter((title) => !was.has(title))
    .filter((title) => {
      const tags = tagsAbove(after, title);
      // A new story in a shared spec: each new test names this story and a design item.
      if (missing.length === 0)
        return !(tags.includes(`@STORY:${story}`) && tags.some((t) => t.startsWith("@DESIGN:")));
      return !missing.some((id) => tags.includes(`@DESIGN:${id}`));
    });
  if (untagged.length > 0 && missing.length === 0)
    return (
      `new test(s) ${untagged.map((x) => `"${x}"`).join("; ")} need their tags above them as ` +
      `comments, the way bdd2pw writes them: // @story:${story} // @design:D… (and @bug:… for a ` +
      "bug's test) — they are how each test is traced to the design that was approved."
    );
  if (untagged.length > 0)
    return (
      `new test(s) ${untagged
        .map((x) => `"${x}"`)
        .join("; ")} carry no @design tag for the item(s) ` +
      `being completed (${missing.join(
        ", ",
      )}). Put the scenario's tags above the test as comments, ` +
      "the way bdd2pw does: // @story:… // @design:D5 // @bug:… — they are how the test is traced."
    );
  return undefined;
}

/** The `// @tag` comment lines directly above a test, upper-cased tokens. */
function tagsAbove(spec: string, title: string): string[] {
  const lines = spec.split("\n");
  const at = lines.findIndex(
    (l) => /^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(/.test(l) && l.includes(title),
  );
  const out: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const l = lines[i]?.trim() ?? "";
    if (!l.startsWith("//")) break;
    out.push(...(l.match(/@[\w-]+:[\w-]+/g) ?? []).map((x) => x.toUpperCase()));
  }
  return out;
}
