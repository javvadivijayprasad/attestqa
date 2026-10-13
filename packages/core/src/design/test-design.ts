import {
  includesId,
  isKnownBroken,
  normId,
  sameId,
  storyTagId,
  storyTagIds,
  type TrackerId,
} from "./ids.js";
import type { AnyRunEvent } from "../types.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import { acLabels } from "../triage/settle.js";
import type { FrameworkProfile } from "../framework/survey.js";

/**
 * Stage 2 of the workflow: the TEST DESIGN, declared before a single test is
 * written, checked by code, and approved by a person.
 *
 * ── Why it is a separate, approved step ──
 * Until now the agent went straight from the story to a feature file. What it
 * chose to test, and how, was visible only by reading the tests afterwards —
 * and the choices were not all good ones. It asserted things nobody had
 * specified (logout "lands on /#/login"), and it dropped the expected-to-fail
 * marker on a known bug's test so that the bug's non-reproduction reached no
 * one. Both are test DESIGN decisions. Made explicit, each becomes one line a
 * tester can check in seconds: "AC-3 → functional, boundary values: empty,
 * one character, valid". Caught there, a bad choice costs nothing; caught in a
 * failing test, it costs a run.
 *
 * ── The vocabulary is ISTQB's, not invented ──
 * Test TYPES (CTFL v4.0 §2.2.2): functional, and the non-functional quality
 * characteristics this project tests — security, accessibility — plus
 * confirmation testing (§2.2.3) for a known defect. Test TECHNIQUES (§4): the
 * four black-box techniques, and the experience-based error guessing and
 * checklist-based testing. A design written in a shared vocabulary can be
 * reviewed by anyone who knows it, and compared across stories.
 */

export const TEST_TYPES = ["functional", "security", "accessibility", "confirmation"] as const;
export type TestType = (typeof TEST_TYPES)[number];

export const TYPE_MEANINGS: Record<TestType, string> = {
  functional: "does the story do what its acceptance criteria say",
  security:
    "what the story implies about protecting the account and its data — e.g. no account enumeration, a session that really ends — observed through the browser only",
  accessibility:
    "can the page be used without sight or a mouse: labels, contrast, keyboard focus — an automated axe-core scan (@axe-core/playwright)",
  confirmation:
    "a KNOWN defect: an Active bug's test is expected to fail (test.fail); a Resolved bug's test confirms the fix and stays as a regression test",
};

export const DESIGN_TECHNIQUES = [
  "equivalence-partitioning",
  "boundary-value-analysis",
  "decision-table",
  "state-transition",
  "error-guessing",
  "checklist-based",
] as const;
export type DesignTechnique = (typeof DESIGN_TECHNIQUES)[number];

export const DESIGN_TECHNIQUE_MEANINGS: Record<DesignTechnique, string> = {
  "equivalence-partitioning":
    "one value from each class the rule treats alike, including the invalid classes",
  "boundary-value-analysis": "the edges of a rule: empty, minimum, maximum, one either side",
  "decision-table":
    "each combination of conditions that changes the outcome, not each condition alone",
  "state-transition":
    "what the view or session looks like AFTER an action, from each state that matters",
  "error-guessing": "where this kind of system usually breaks, from experience",
  "checklist-based": "a recognised checklist — for accessibility, the WCAG rules axe-core checks",
};

export interface DesignItem {
  /** "D1", "D2", … — the tag every scenario carries as @design:D1. */
  id: string;
  /** "AC-1" (or a sub-label "AC-3a"), "bug #48", "task #46" — or "story" for accessibility. */
  covers: string;
  type: TestType;
  technique: DesignTechnique;
  /** The test conditions: the values or situations that will be exercised. */
  conditions: string[];
  /** What must be observed. */
  expected: string;
  /** Where the expectation comes from: "AC-2", "task #46", "bug #50", "comment" — or, for accessibility, the config ("agent.test_types", "WCAG A/AA"). */
  source: string;
  /** True for an Active bug's test: it is EXPECTED to fail (test.fail). */
  expectFail?: boolean;
}

export interface Exclusion {
  /** "bug #49", or a test type such as "accessibility". */
  what: string;
  reason: string;
}

export interface TestDesign {
  items: DesignItem[];
  excluded: Exclusion[];
}

/** What stage 1 established about the story — the ground a design is checked against. */
export interface StoryFacts {
  acceptanceCriteria: string[];
  bugs: Array<{ id: TrackerId; state: string; title: string }>;
  /**
   * EVERY bug already on this story, including the ones this runtime filed —
   * which `bugs` above deliberately excludes, because a run must not read its
   * own unconfirmed output as a requirement.
   *
   * Withholding them from the prompt was right and left a hole: the agent
   * cannot see a bug it filed yesterday, so it files it again. 20260926 and
   * 20260928 each filed "logout does not redirect to the login page" for the
   * third and fourth time. This list exists so `duplicateBug` can refuse that
   * in code. It is never rendered into the prompt.
   */
  filedBugs?: Array<{ id: TrackerId; state: string; title: string; agent: boolean }>;
  tasks: TrackerId[];
  /** The story itself: tests this run adds are tagged with its id. */
  story?: { id: TrackerId; title: string };
  /** The epic the story sits under — which is what the spec file is named for. */
  epic?: { id: TrackerId; title: string };
  /** Stage 0: the framework already in the repository, whose layout the run conforms to. */
  framework?: FrameworkProfile;
}

/**
 * Tests follow the application, not the backlog.
 *
 * Login, logout and "the error clears after you correct the password" are all
 * observed on the same page, and a tester opening that spec should find them
 * whichever story paid for them. So the feature file is named for the EPIC and
 * every scenario carries @story:<id>; a run adds its story\'s scenarios to the
 * shared file and leaves the others alone. Per-story files would scatter one
 * page\'s behaviour across three of them and duplicate the sign-in helper in
 * each.
 */
export function epicStem(facts: StoryFacts): string | undefined {
  const e = facts.epic;
  const id = e ? normId(e.id) : undefined;
  if (!e || id === undefined) return undefined;
  const slug = e.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
  return `epic-${typeof id === "string" ? id.toLowerCase() : id}${slug ? `-${slug}` : ""}`;
}

/** The one feature file this epic\'s scenarios live in. */
export function featurePathFor(facts: StoryFacts): string | undefined {
  const stem = epicStem(facts);
  if (!stem) return undefined;
  // The repository's own directory, when it has one. Ours is a fallback for a
  // project with no BDD layer yet, not a convention to impose.
  const dir = facts.framework?.featureDir ?? "features";
  return `${dir}/${stem}.feature`;
}

/** The spec bdd2pw generates from that feature file. */
export function specPathFor(facts: StoryFacts): string | undefined {
  const stem = epicStem(facts);
  if (!stem) return undefined;
  const dir = facts.framework?.specDir ?? "tests";
  const suffix = facts.framework?.specSuffix ?? ".spec.ts";
  return `${dir}/${stem}${suffix}`;
}

/** The design as proposed, tolerating the shapes a model actually sends. */
export function parseDesign(args: Record<string, unknown>): TestDesign {
  const items = asArray(args["items"]).map((x) => {
    const r = asRecord(x) ?? {};
    return {
      id: String(r["id"] ?? "").trim(),
      covers: String(r["covers"] ?? "").trim(),
      type: String(r["type"] ?? "")
        .trim()
        .toLowerCase() as TestType,
      technique: String(r["technique"] ?? "")
        .trim()
        .toLowerCase() as DesignTechnique,
      conditions: asArray(r["conditions"])
        .map((c) => String(c).trim())
        .filter(Boolean),
      expected: String(r["expected"] ?? "").trim(),
      source: String(r["source"] ?? "").trim(),
      ...(r["expectFail"] === true ? { expectFail: true } : {}),
    };
  });
  const excluded = asArray(args["excluded"]).map((x) => {
    const r = asRecord(x) ?? {};
    return { what: String(r["what"] ?? "").trim(), reason: String(r["reason"] ?? "").trim() };
  });
  return { items, excluded };
}

/**
 * The bug a string refers to: "bug #48", "#48", "48", and — because a model
 * writes for a reader — "bug #49 [New] — Leading and trailing whitespace in
 * the password". The first version accepted only the bare forms, and a design
 * that DID exclude bug #49, with a good reason, was sent back six times over
 * for not excluding it (20260922T230624Z). A rule that is right about the
 * substance and wrong about the punctuation is a rule that blocks the work.
 */
// "bug #48", "bug 48", "#48" — or, from Jira, "bug SHOP-12" and "SHOP-12".
function bugRef(s: string): TrackerId | undefined {
  const m =
    /\bbug\s*#?\s*([A-Za-z][A-Za-z0-9_]+-\d+|\d+)\b/i.exec(s) ??
    /^\s*#?\s*([A-Za-z][A-Za-z0-9_]+-\d+|\d+)\s*$/.exec(s);
  return m ? normId(m[1]) : undefined;
}

function taskRef(s: string): TrackerId | undefined {
  const m = /^\s*task\s*#?\s*([A-Za-z][A-Za-z0-9_]+-\d+|\d+)\s*$/i.exec(s);
  return m ? normId(m[1]) : undefined;
}

/** "AC-3a" → "AC-3": the criterion a sub-scenario belongs to. */
function baseLabel(label: string): string {
  return label.replace(/[A-Z]$/, "");
}

// Task and bug references in either tracker: "task #46" / "bug 48" (Azure
// DevOps) or "task SCRUM-9" / "bug SCRUM-12" (Jira). Run 20261011T210750Z
// refused "task SCRUM-9" as having no source — a Jira key the rule never knew.
const SOURCE =
  /\b(AC[- ]?\d+[a-z]?|task\s*#?(?:[A-Za-z][A-Za-z0-9_]+-)?\d+|bug\s*#?(?:[A-Za-z][A-Za-z0-9_]+-)?\d+|comment|epic)\b/i;

/**
 * A story with NO acceptance criteria recorded.
 *
 * It happens, and it is itself a finding worth reporting — but the run should
 * not be unable to move. Story #44 had none: the agent read the description,
 * wrote "AC-1" for what it found there, and every rule refused it, because
 * AC-1 was not one of the story's criteria. There was no legal move and the
 * design looped (20260923T234233Z).
 *
 * Where there are none, an item may cover "story" and cite the description —
 * and every such item is marked derived, so nobody later mistakes a reading of
 * a description for a stated requirement.
 */
const DERIVED_SOURCE = /\b(story|description|AB#\d+|[A-Z][A-Z0-9_]+-\d+|acceptance criteria)\b/i;

/**
 * The shapes a hedged expectation takes. Deliberately narrow: "or" inside a
 * parenthesis or between two claims, and the words that announce a choice.
 * "empty or whitespace-only input" is a set of CONDITIONS, not two outcomes, so
 * a bare "or" between short noun phrases is left alone.
 */
function alternativeInExpectation(expected: string): string | undefined {
  const text = expected.replace(/\s+/g, " ");
  if (/\(\s*or\b/i.test(text)) return '"(or …"';
  if (/\beither\b.*\bor\b/i.test(text)) return '"either … or"';
  if (/\bor\s+(the|a|it|they|he|she|we|you)\b/i.test(text)) return '"or …"';
  if (/\bor\s+\w+\s+(is|are|has|have|shows?|ends?|becomes?|remains?)\b/i.test(text))
    return '"or … is/has/shows"';
  if (/\bfallback\b|\bat least one of\b|\bany of\b/i.test(text)) return "an alternative";
  return undefined;
}

/**
 * Everything wrong with a design, as sentences the agent can act on. Empty
 * means the design may be put to the reviewer.
 *
 * Every rule is about the design's CONTENT against what stage 1 read — none is
 * about how the agent went about producing it.
 */
export function validateDesign(
  d: TestDesign,
  facts: StoryFacts,
  inScope: readonly TestType[],
): string[] {
  const problems: string[] = [];
  if (d.items.length === 0) return ["the design has no items"];

  const ids = new Set<string>();
  const storyAcs = new Set(facts.acceptanceCriteria);
  const noCriteria = storyAcs.size === 0;
  const bugs = new Map(facts.bugs.map((b) => [b.id, b]));
  // What an exclusion names, read the same forgiving way: a bug by its id
  // wherever it appears in the text, and a test type by name anywhere in it.
  const excludedBugs = new Set<TrackerId>();
  const excludedTypes = new Set<string>();
  for (const e of d.excluded) {
    const b = bugRef(e.what);
    if (b !== undefined) excludedBugs.add(b);
    for (const t of TEST_TYPES)
      if (new RegExp(`\\b${t}\\b`, "i").test(e.what)) excludedTypes.add(t);
  }

  for (const e of d.excluded) {
    if (!e.reason) problems.push(`exclusion "${e.what}" gives no reason`);
  }

  for (const it of d.items) {
    const at = it.id || "(no id)";
    // "D1" or, in a shared epic file where two stories both have a first item,
    // "D1-44". Refusing the second form blocked a whole run: the agent tagged
    // its scenarios @design:D1-44, was told the id was wrong, renamed the
    // design to D1 — and the scenarios in the feature file still said D1-44,
    // so every one of them read as "not in the design" (20260924T183415Z).
    if (!/^D\d+(-\d+)?$/.test(it.id))
      problems.push(`${at}: id must look like D1, D2, … or D1-44 for a shared epic file`);
    else if (ids.has(it.id)) problems.push(`${at}: id used twice`);
    ids.add(it.id);

    if (!(TEST_TYPES as readonly string[]).includes(it.type))
      problems.push(`${at}: type "${it.type}" is not one of ${TEST_TYPES.join(", ")}`);
    else if (!inScope.includes(it.type))
      problems.push(
        `${at}: type "${it.type}" is not in scope for this project (in scope: ${inScope.join(
          ", ",
        )})`,
      );
    if (!(DESIGN_TECHNIQUES as readonly string[]).includes(it.technique))
      problems.push(
        `${at}: technique "${it.technique}" is not one of ${DESIGN_TECHNIQUES.join(", ")}`,
      );
    if (it.type === "accessibility" && it.technique !== "checklist-based")
      problems.push(`${at}: an accessibility item is checklist-based (the axe-core rules)`);

    if (it.conditions.length === 0)
      problems.push(`${at}: list the test conditions — the values or situations exercised`);
    if (!it.expected) problems.push(`${at}: say what must be observed`);
    // The rule the logout test broke: an expectation nobody specified.
    // An accessibility item has no criterion behind it: it is in scope because
    // the project's config asks for that test type, and saying so is honest
    // where naming a criterion that never mentioned accessibility is not.
    const sourced =
      SOURCE.test(it.source) ||
      (it.type === "accessibility" && /config|test.?types|wcag|axe/i.test(it.source)) ||
      // No criteria: the description and the story itself are what there is.
      (noCriteria && DERIVED_SOURCE.test(it.source));
    if (!sourced)
      problems.push(
        `${at}: source "${it.source || "(none)"}" names no criterion, task, bug or comment — ` +
          "an expectation with no source is a guess about the application",
      );

    // An expectation with an alternative is not an expectation.
    //
    // 20260925T194528Z proposed: "the URL changes to /#/login (or the session
    // ends and the user is no longer shown as signed in)". A reviewer approving
    // that has approved a CHOICE, which the agent then makes later and by
    // itself — and the weaker branch is the one a failing test reaches for. The
    // hedge is also how a product owner's decision ("logout must land on the
    // login page") quietly becomes negotiable.
    const hedge = alternativeInExpectation(it.expected);
    if (hedge)
      problems.push(
        `${at}: the expected result offers an alternative (${hedge}) — "${it.expected
          .replace(/\s+/g, " ")
          .slice(0, 90)}". ` +
          "One item, one expectation: pick the one that must hold, or split this into two items. " +
          "A reviewer cannot approve a choice that is made after the approval.",
      );

    // What it covers must exist.
    const label = acLabels(it.covers)[0];
    const bug = bugRef(it.covers);
    const task = taskRef(it.covers);
    if (label) {
      if (!storyAcs.has(label) && !storyAcs.has(baseLabel(label)))
        problems.push(
          `${at}: covers ${label}, which is not one of the story's criteria (${[...storyAcs].join(
            ", ",
          )})`,
        );
    } else if (bug !== undefined) {
      const b = bugs.get(bug);
      if (!b)
        problems.push(
          `${at}: covers bug #${bug}, which is not one of the open bugs read in stage 1`,
        );
      else {
        if (it.type !== "confirmation")
          problems.push(
            `${at}: covers bug #${bug}, so its type must be "confirmation" (a re-test of a known bug), not "${it.type}" — ` +
              'change "type" to "confirmation" and keep the item',
          );
        if (isKnownBroken(b.state) && it.expectFail !== true)
          problems.push(
            `${at}: bug #${bug} is ${b.state} (known broken) — its test is EXPECTED to fail; set expectFail: true ` +
              'so that a pass reaches a person as "did not reproduce"',
          );
        if (!isKnownBroken(b.state) && it.expectFail === true)
          problems.push(
            `${at}: bug #${bug} is ${b.state}, not known broken (Active / In Progress) — its test is not expected to fail`,
          );
      }
    } else if (task !== undefined) {
      if (!facts.tasks.includes(task))
        problems.push(`${at}: covers task #${task}, which is not one of the story's tasks`);
    } else if (!(
      it.covers.toLowerCase() === "story" &&
      (it.type === "accessibility" || noCriteria)
    )) {
      problems.push(
        `${at}: covers "${it.covers}" — name a criterion (AC-2), a bug (bug #48) or a task (task #46)`,
      );
    }
    // Both of these read as statements about a particular bug in the first
    // version ("a confirmation test covers a bug (\"bug #48\")"), which is how a
    // message meant as a rule got read as a finding — by the agent and by a
    // person, on the same day. Say the rule, then say what this item did.
    if (it.type === "confirmation" && bug === undefined)
      problems.push(
        `${at}: type "confirmation" is for a test that confirms a BUG, so covers must name one ` +
          `(e.g. "bug #48") — this item covers "${it.covers}". Either name the bug, or change the type.`,
      );
    if (it.expectFail === true && bug === undefined)
      problems.push(
        `${at}: expectFail is only for an Active bug's test, and this item covers "${it.covers}", ` +
          "not a bug. A test that is expected to fail is a test whose failure is already recorded " +
          "as a defect; anything else must be expected to pass.",
      );
  }

  // With no criteria there is nothing to cover one-for-one, but the story's
  // behaviour still has to be tested by something.
  if (noCriteria && !d.items.some((it) => it.type === "functional"))
    problems.push(
      "this story has no acceptance criteria, so there is nothing to cover criterion by criterion — " +
        'but it still needs at least one functional item, covering "story" and citing the description',
    );

  // Coverage: every criterion has a functional test.
  for (const ac of storyAcs) {
    const covered = d.items.some(
      (it) =>
        it.type === "functional" &&
        acLabels(it.covers).some((l) => l === ac || baseLabel(l) === ac),
    );
    if (!covered) problems.push(`${ac} has no functional test in the design`);
  }

  // Every open bug is either tested or explicitly left out, with a reason.
  for (const b of facts.bugs) {
    const tested = d.items.some((it) => sameId(bugRef(it.covers), b.id));
    if (!tested && !excludedBugs.has(b.id))
      problems.push(
        `bug #${b.id} [${b.state}] is neither tested nor listed in "excluded" with a reason — ` +
          `either add an item covering "bug #${b.id}", or add ` +
          `{"what": "bug #${b.id}", "reason": "<why not>"} to "excluded"`,
      );
  }

  // Every type in scope is used, or its absence is explained.
  for (const t of inScope) {
    if (!d.items.some((it) => it.type === t) && !excludedTypes.has(t))
      problems.push(
        `test type "${t}" is in scope but has no item — add one, or add ` +
          `{"what": "${t}", "reason": "<why not>"} to "excluded"`,
      );
  }

  return problems;
}

/** The stage-1 facts, from the preflight digest recorded in the ledger. */
export function storyFacts(events: AnyRunEvent[]): StoryFacts | undefined {
  const digest = successful(completedCalls(events), "aqa.story_context").pop();
  const f = asRecord(asRecord(digest?.result)?.["facts"]);
  if (!f) return undefined;
  return {
    acceptanceCriteria: asArray(f["acceptanceCriteria"]).map(String),
    bugs: asArray(f["bugs"]).map((b) => {
      const r = asRecord(b) ?? {};
      return {
        id: idOf(r["id"]),
        state: String(r["state"] ?? ""),
        title: String(r["title"] ?? ""),
      };
    }),
    filedBugs: asArray(f["filedBugs"]).map((b) => {
      const r = asRecord(b) ?? {};
      return {
        id: idOf(r["id"]),
        state: String(r["state"] ?? ""),
        title: String(r["title"] ?? ""),
        agent: r["agent"] === true,
      };
    }),
    tasks: asArray(f["tasks"]).map(idOf),
    ...(asRecord(f["story"]) ? { story: asStub(f["story"]) } : {}),
    ...(asRecord(f["epic"]) ? { epic: asStub(f["epic"]) } : {}),
    ...(asRecord(f["framework"]) ? { framework: f["framework"] as FrameworkProfile } : {}),
  };
}

/**
 * An id read back from the ledger. A Jira key stays a key; an Azure DevOps id
 * stays a number; anything else is NaN, as `Number()` made it before Jira, so
 * the checks that skip a missing id still skip it.
 */
function idOf(v: unknown): TrackerId {
  return normId(v) ?? Number.NaN;
}

function asStub(v: unknown): { id: TrackerId; title: string } {
  const r = asRecord(v) ?? {};
  return { id: idOf(r["id"]), title: String(r["title"] ?? "") };
}

/** The design in force: the last one a person approved and the runtime recorded. */
export function approvedDesign(events: AnyRunEvent[]): TestDesign | undefined {
  const last = successful(completedCalls(events), "aqa.test_design").pop();
  return last ? parseDesign(last.args) : undefined;
}

/** The design as a person reads it at the approval prompt. */
export function renderDesign(
  d: TestDesign,
  opts: {
    noCriteria?: boolean;
    /** Items already tested, from `coverageOf` — shown so a reviewer knows what is new. */
    covered?: Map<string, { scenario: string; how: string }>;
  } = {},
): string[] {
  const counts = TEST_TYPES.map((t) => [t, d.items.filter((i) => i.type === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`);
  const covered = opts.covered;
  const already = covered ? d.items.filter((i) => covered.has(i.id)).length : 0;
  const head =
    already > 0
      ? `TEST DESIGN — ${d.items.length} item(s): ${already} already covered, ${
          d.items.length - already
        } new · ${counts.join(" · ")}`
      : `TEST DESIGN — ${d.items.length} item(s): ${counts.join(" · ")}`;
  const out = [head, ""];
  if (opts.noCriteria)
    out.push(
      "THIS STORY HAS NO ACCEPTANCE CRITERIA. Everything below is derived from the story's",
      "description, its tasks and its comments — read each expectation as someone's reading of",
      "the story rather than as a stated requirement, and approve only what you accept as one.",
      "",
    );
  for (const it of d.items) {
    out.push(
      `${it.id} ${it.covers} — ${it.type}, ${it.technique}` +
        (it.expectFail ? " — EXPECTED TO FAIL (Active bug)" : ""),
    );
    const hit = covered?.get(it.id);
    if (hit) out.push(`      ALREADY TESTED by "${hit.scenario}" (matched on ${hit.how})`);
    if (it.conditions.length > 0) out.push(`      conditions: ${it.conditions.join("; ")}`);
    out.push(`      expect: ${it.expected}   (from ${it.source})`);
  }
  if (d.excluded.length > 0) {
    out.push("", "NOT TESTED, and why:");
    for (const e of d.excluded) out.push(`  ${e.what} — ${e.reason}`);
  }
  return out;
}

/**
 * Which design items are ALREADY tested, and by what.
 *
 * Path B exists because the tests are already there, and yet the design step
 * presented five items as fresh work on every run of story #44 — "test design
 * approved — 5 item(s); tests are written from it" — while the agent went on to
 * run tests written the day before. The reviewer was reading a plan for work
 * that was done ("Test are already writen right why you think it wrighting
 * agagin").
 *
 * Matching is by what the scenario CARRIES, in descending order of certainty:
 * its @ac / @bug tag, then its @design:<id> tag. Nothing is matched by
 * similarity of prose — an item that cannot be matched is reported as new,
 * which is the safe direction: it asks for a test that may already exist rather
 * than assuming one that does not.
 */
export function coverageOf(
  design: TestDesign,
  opts: { featureText?: string; specText?: string; story?: TrackerId },
): Map<string, { scenario: string; how: "criterion" | "bug" | "design id" }> {
  const out = new Map<string, { scenario: string; how: "criterion" | "bug" | "design id" }>();
  const feature = opts.featureText;
  if (!feature) return out;

  // This story's scenarios only: the epic file holds every story's.
  const owned = new Set(
    opts.story === undefined
      ? scenarioStoryTags(feature).map((s) => s.scenario)
      : scenarioStoryTags(feature)
          .filter((s) => includesId(s.stories, opts.story))
          .map((s) => s.scenario),
  );
  // An empty string is a spec that was READ and has no tests: different from a
  // spec that could not be read, where the tags are all there is to go on.
  const implemented =
    opts.specText === undefined ? undefined : new Set(testsByTitle(opts.specText).keys());
  const isReal = (scenario: string) =>
    owned.has(scenario) &&
    // When the spec is readable, a scenario only counts as covered if a test
    // for it actually exists in the file.
    (implemented === undefined ||
      [...implemented].some((t) => t.includes(scenario) || scenario.includes(t)));

  const tagged = scenarioTagsOf(feature);
  for (const it of design.items) {
    const ac = acLabelNumber(it.covers);
    const bug = bugRef(it.covers);
    // A match only counts when the scenario is the same TYPE of test (when it
    // says): run 20261011T214846Z reported a security item (token removed from
    // storage) "already tested" by the AC-1 functional test, which never looks
    // at storage. Design ids are renumbered every run, so they stay the last
    // resort, never the first.
    // Several items can share a criterion — AC-3's four boundary cases, each
    // with its own scenario. Matching the first scenario for all of them told
    // the reviewer D8–D11 were "ALREADY TESTED by AC-3a" (20261012T220131Z).
    // So among the scenarios that match on criterion or bug, the one carrying
    // this item's own design id wins, then one no other item has claimed.
    const matching = tagged.filter((sc) => {
      if (!isReal(sc.scenario)) return false;
      const sameType = sc.types.length === 0 || sc.types.includes(it.type);
      if (!sameType) return false;
      return (
        (ac !== undefined && sc.acs.includes(ac)) || (bug !== undefined && includesId(sc.bugs, bug))
      );
    });
    if (matching.length > 0) {
      const claimed = new Set([...out.values()].map((v) => v.scenario));
      const pick =
        matching.find((sc) => sc.designs.includes(it.id.toUpperCase())) ??
        matching.find((sc) => !claimed.has(sc.scenario)) ??
        matching[0];
      if (pick) {
        const how = ac !== undefined && pick.acs.includes(ac) ? "criterion" : "bug";
        out.set(it.id, { scenario: pick.scenario, how });
        continue;
      }
    }
    for (const sc of tagged) {
      if (!isReal(sc.scenario)) continue;
      const sameType = sc.types.length === 0 || sc.types.includes(it.type);
      if (
        ac === undefined &&
        bug === undefined &&
        sameType &&
        sc.designs.includes(it.id.toUpperCase())
      ) {
        out.set(it.id, { scenario: sc.scenario, how: "design id" });
        break;
      }
    }
  }
  return out;
}

/** "AC-3a" → 3. */
function acLabelNumber(covers: string): number | undefined {
  const m = /\bAC[- ]?(\d+)/i.exec(covers);
  return m ? Number(m[1]) : undefined;
}

/** Every scenario with the tags that say what it covers. */
function scenarioTagsOf(feature: string): Array<{
  scenario: string;
  acs: number[];
  bugs: TrackerId[];
  designs: string[];
  types: string[];
}> {
  const out: Array<{
    scenario: string;
    acs: number[];
    bugs: TrackerId[];
    designs: string[];
    types: string[];
  }> = [];
  let tags: string[] = [];
  for (const raw of feature.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@")) {
      tags.push(...line.split(/\s+/));
      continue;
    }
    const m = /^Scenario(?: Outline)?:\s*(.*)$/i.exec(line);
    if (m) {
      const num = (re: RegExp) =>
        tags.map((t) => Number(re.exec(t)?.[1])).filter((n) => Number.isFinite(n));
      out.push({
        scenario: (m[1] ?? "").trim(),
        acs: num(/^@ac:(\d+)/i),
        bugs: tags
          .map((t) => normId(/^@bug:([A-Za-z][A-Za-z0-9_]+-\d+|\d+)/i.exec(t)?.[1]))
          .filter((n): n is TrackerId => n !== undefined),
        designs: tags
          .map((t) => /^@design:(D\d+(?:-\d+)?)$/i.exec(t)?.[1]?.toUpperCase())
          .filter((x): x is string => !!x),
        types: tags
          .map((t) => /^@type:([a-z][a-z-]*)$/i.exec(t)?.[1]?.toLowerCase())
          .filter((x): x is string => !!x),
      });
      tags = [];
    } else if (line && !line.startsWith("#")) {
      tags = [];
    }
  }
  return out;
}

/**
 * The tags a scenario must carry to say what KIND of test it is.
 *
 * `@story` and `@design` say whose test this is and which design item it
 * implements. These two say what it does — the ISTQB type and the technique —
 * and they are what makes a lane runnable: `--grep @type:security` is a
 * security run, `--grep-invert @type:accessibility` is a suite without the
 * axe scans. The design already names both for every item, so carrying them
 * into the file costs nothing and is checkable.
 */
export function kindTagsFor(item: DesignItem): string[] {
  return [`@type:${item.type}`, `@technique:${item.technique}`];
}

/** Every tag on each scenario, in order, with the scenario it belongs to. */
export function scenarioTags(feature: string): Array<{ scenario: string; tags: string[] }> {
  const out: Array<{ scenario: string; tags: string[] }> = [];
  let tags: string[] = [];
  for (const raw of feature.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@")) {
      tags.push(...line.split(/\s+/));
      continue;
    }
    const m = /^Scenario(?: Outline)?:\s*(.*)$/i.exec(line);
    if (m) {
      out.push({ scenario: (m[1] ?? "").trim(), tags: [...tags] });
      tags = [];
    } else if (line && !line.startsWith("#")) {
      tags = [];
    }
  }
  return out;
}

/** The @design:<id> tags on each scenario of a feature file. */
export function scenarioDesignTags(
  feature: string,
): Array<{ scenario: string; designs: string[] }> {
  const out: Array<{ scenario: string; designs: string[] }> = [];
  let pendingTags: string[] = [];
  for (const raw of feature.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@")) {
      pendingTags.push(...line.split(/\s+/));
      continue;
    }
    const m = /^Scenario(?: Outline)?:\s*(.*)$/i.exec(line);
    if (m) {
      out.push({
        scenario: (m[1] ?? "").trim(),
        designs: pendingTags
          .map((t) => /^@design:(D\d+(?:-\d+)?)$/i.exec(t)?.[1]?.toUpperCase())
          .filter((x): x is string => !!x),
      });
      pendingTags = [];
    } else if (line && !line.startsWith("#")) {
      pendingTags = [];
    }
  }
  return out;
}

/**
 * For each @design:<id> in a spec, whether the test that follows the tag
 * comment carries an expected-to-fail marker. bdd2pw writes a scenario's tags
 * as a `// @tag` comment line above its test.
 */
export function specBodies(spec: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string[] = [];
  let body: string[] = [];
  const flush = () => {
    const text = body.join("\n");
    for (const id of current) out.set(id, (out.get(id) ?? "") + "\n" + text);
  };
  for (const line of spec.split("\n")) {
    const tags = [...line.matchAll(/@design:(D\d+(?:-\d+)?)/gi)].map((m) =>
      (m[1] ?? "").toUpperCase(),
    );
    if (/^\s*\/\//.test(line) && tags.length > 0) {
      flush();
      current = tags;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

export function specMarkers(spec: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const lines = spec.split("\n");
  let current: string[] = [];
  let body: string[] = [];
  const flush = () => {
    const marked = /\btest\.fail\s*\(/.test(body.join("\n"));
    for (const id of current) out.set(id, (out.get(id) ?? false) || marked);
  };
  for (const line of lines) {
    const tags = [...line.matchAll(/@design:(D\d+(?:-\d+)?)/gi)].map((m) =>
      (m[1] ?? "").toUpperCase(),
    );
    if (/^\s*\/\//.test(line) && tags.length > 0) {
      flush();
      current = tags;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

/** Where the tests on disk do not trace back to the approved design. */
export function traceProblems(
  design: TestDesign,
  features: Array<{ path: string; text: string }>,
  specs: Array<{ path: string; text: string }>,
  /**
   * The story this run is scoped to. The epic's feature file holds every
   * story's scenarios, so without this the design of story #1 is asked to
   * account for story #44's tests.
   *
   * 20260925T145714Z: it was, and the agent's way out was to relabel the
   * logout scenarios as covering story #1's AC-1. A check that cannot be
   * satisfied honestly is a check that teaches dishonesty.
   */
  story?: TrackerId,
): { untested: string[]; untagged: string[]; unmarked: string[]; wrongShape: string[] } {
  const all = features.flatMap((f) =>
    scenarioDesignTags(f.text).map((s) => ({ ...s, path: f.path })),
  );
  const owner = new Map<string, TrackerId[]>();
  for (const f of features)
    for (const s of scenarioStoryTags(f.text)) owner.set(s.scenario, s.stories);
  // A scenario tagged for ANOTHER story is not this design's business. One
  // with no @story tag at all is nobody's and stays in scope.
  const scenarios =
    story === undefined
      ? all
      : all.filter((s) => {
          const owns = owner.get(s.scenario) ?? [];
          return owns.length === 0 || includesId(owns, story);
        });
  const tagged = new Set(scenarios.flatMap((s) => s.designs));
  const known = new Set(design.items.map((i) => i.id));
  const untested = design.items
    .filter((i) => !tagged.has(i.id))
    .map((i) => `${i.id} (${i.covers})`);
  const untagged = scenarios
    .filter((s) => s.designs.length === 0 || s.designs.some((d) => !known.has(d)))
    .map((s) => `${s.path}: "${s.scenario}"`);
  const markers = new Map<string, boolean>();
  for (const sp of specs)
    for (const [id, marked] of specMarkers(sp.text))
      markers.set(id, (markers.get(id) ?? false) || marked);
  const unmarked = design.items
    .filter((i) => i.expectFail === true && markers.get(i.id) !== true)
    .map((i) => `${i.id} (${i.covers})`);
  // Does the test actually do what its design item said it would?
  //
  // The design for 20260923T225303Z said the accessibility scan would be
  // scoped to the login form and assert on rule ids. The spec on disk did
  // neither — it was a file from an earlier run, reused because it existed —
  // and the bug that came out of it blamed the login fields for a hidden
  // input elsewhere on the page. "A test exists" was checked; "the test is
  // the one that was approved" was not.
  const bodies = new Map<string, string>();
  for (const sp of specs)
    for (const [id, body] of specBodies(sp.text)) bodies.set(id, (bodies.get(id) ?? "") + body);
  const wrongShape: string[] = [];
  for (const item of design.items) {
    const body = bodies.get(item.id);
    if (!body) continue;
    for (const missing of shapeProblems(item, body))
      wrongShape.push(`${item.id} (${item.covers}): ${missing}`);
  }

  return { untested, untagged, unmarked, wrongShape };
}

/**
 * What a design item's own type requires of the test that implements it.
 *
 * Deliberately a short list of CHECKABLE properties rather than an attempt to
 * compare prose with code: each one is something the design promised and the
 * file can be read for.
 */
export function shapeProblems(item: DesignItem, body: string): string[] {
  const out: string[] = [];
  // A test may not catch its own failure.
  //
  // 20260925T114717Z: the logout step was wrapped in try/catch with
  // `page.goto("/#/logout")` as the fallback. The locator was wrong, the click
  // never happened, the fallback loaded a route Juice Shop does not have — and
  // the test went on to report "the session token was not cleared". A test
  // that recovers from its own broken step does not fail; it invents a result.
  //
  // 20261012T153713Z: told only "remove the try/catch", the agent read the
  // file, decided the green suite was enough and ended the run. Quoting the
  // line and the edit leaves nothing to weigh: the fix is one replace.
  if (/\bcatch\s*(\([^)]*\))?\s*\{/.test(body) || /\.catch\s*\(/.test(body)) {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\bcatch\s*(\([^)]*\))?\s*\{/.test(l) || /\.catch\s*\(/.test(l));
    const where =
      lines.length > 0
        ? ` — the line${lines.length > 1 ? "s" : ""} ${lines.map((l) => `\`${l}\``).join(", ")}`
        : "";
    out.push(
      `the test catches its own failure and carries on${where}. Remove the try/catch and the fallback ` +
        "(fs.replace_in_file: drop `.catch(...)` from that line — include the line above it in `old` " +
        "if the same text appears elsewhere in the file, such as a hook): " +
        "if the control cannot be reached the test must fail THERE, saying so — a step that " +
        "recovers silently turns a locator problem into a false report about the product. " +
        "A green suite does not settle this, and it is not a reason the design cannot be followed: " +
        "the gap stays open until the line is gone",
    );
  }
  if (item.type === "accessibility") {
    if (!/\.include\s*\(/.test(body))
      out.push(
        "the scan is not scoped — add .include(<the form or region under test>) so a violation " +
          "elsewhere on the page is not reported against this story",
      );
    if (!/\.map\s*\(/.test(body) || !/\bid\b/.test(body))
      out.push(
        "the assertion is on the whole violations array — assert on the rule ids " +
          "(violations.map(v => v.id)) so the failure names the rules",
      );
  }
  if (item.technique === "state-transition") {
    // An action-then-state test must show the ACTION happened before it
    // judges the state it leaves behind. 20260924T183415Z clicked Logout,
    // never checked that the click did anything, then reported "the token was
    // not cleared" — three bugs from one unnoticed failed click. With the
    // action asserted, the same run says "logout did not happen", which is
    // true and is a test problem, not a defect.
    const assertions = (body.match(/\bexpect\s*\(/g) ?? []).length;
    if (assertions < 2)
      out.push(
        "a state-transition test needs at least two assertions: one that the action took effect " +
          "(the menu closed, the URL changed, the request returned), and one for the state it " +
          "leaves behind. With only the second, a failed action is reported as a wrong state",
      );
  }
  if (item.expectFail === true && !/\btest\.fail\s*\(/.test(body))
    out.push("no test.fail marker, though the design says this test is expected to fail");
  return out;
}

/** The @story:<id> tags on each scenario of a feature file. */
export function scenarioStoryTags(
  feature: string,
): Array<{ scenario: string; stories: TrackerId[] }> {
  const out: Array<{ scenario: string; stories: TrackerId[] }> = [];
  let tags: string[] = [];
  for (const raw of feature.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@")) {
      tags.push(...line.split(/\s+/));
      continue;
    }
    const m = /^Scenario(?: Outline)?:\s*(.*)$/i.exec(line);
    if (m) {
      out.push({
        scenario: (m[1] ?? "").trim(),
        stories: tags.map(storyTagId).filter((n): n is TrackerId => n !== undefined),
      });
      tags = [];
    } else if (line && !line.startsWith("#")) {
      tags = [];
    }
  }
  return out;
}

/** Every story id a feature file\'s scenarios are tagged with. */
export function storiesIn(feature: string): Set<TrackerId> {
  const out = new Set<TrackerId>();
  for (const s of scenarioStoryTags(feature)) for (const id of s.stories) out.add(id);
  return out;
}

/**
 * The titles of the tests belonging to ONE story, read from the spec.
 *
 * With an epic-wide spec, a run executes other stories\' tests too. They are
 * not this run\'s to triage, to file bugs for, or to report as its result —
 * this is what separates them. bdd2pw writes a scenario\'s tags as a `// @tag`
 * comment above its test, so the tag survives into the spec.
 */
export function storyTestTitles(spec: string, storyId: TrackerId): Set<string> {
  const out = new Set<string>();
  let current: TrackerId[] = [];
  for (const line of spec.split("\n")) {
    if (/^\s*\/\//.test(line)) {
      const ids = storyTagIds(line);
      if (ids.length > 0) current = ids;
      continue;
    }
    const m = /^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(["'`])([\s\S]*?)\1/.exec(line);
    if (m) {
      if (includesId(current, storyId)) out.add((m[2] ?? "").trim());
      current = [];
    }
  }
  return out;
}

/** The last content this run has for a path, from what it wrote or read. */
export function fileTextFromEvents(events: AnyRunEvent[], path: string): string | undefined {
  const calls = completedCalls(events);
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!c || !c.ok || String(c.args["path"] ?? "") !== path) continue;
    if (c.toolName === "fs.write_file") return String(c.args["content"] ?? "");
    if (c.toolName === "fs.read_file") {
      // A RANGE is not the file.
      //
      // `fs.read_file` grew `fromLine`/`toLine` so that a spec too long for the
      // context budget could still be examined. Everything that reads "the file
      // as this run saw it" then had to learn that a read may be a fragment —
      // and in 20260928T093234Z one did not: the last read of the spec was lines
      // 328–370, `ownTestTitles` parsed that fragment, found no `@story:44` tag
      // on Story-c because Story-c is at line 402, and the run report announced
      // that one of this story's own failing tests "belongs to another story".
      //
      // A fragment is worse than nothing here: nothing falls back to disk or
      // degrades safely, while a fragment answers confidently about a file it
      // has only part of. So a partial read is skipped and the search continues
      // to the last COMPLETE view of the file.
      if (isPartialRead(c.args, c.result)) continue;
      const content = asRecord(c.result)?.["content"];
      if (typeof content === "string") return content;
    }
  }
  return undefined;
}

/** Did this read ask for, or return, only part of the file? */
export function isPartialRead(args: Record<string, unknown>, result: unknown): boolean {
  if (args["fromLine"] !== undefined || args["toLine"] !== undefined) return true;
  const r = asRecord(result);
  return r?.["fromLine"] !== undefined || r?.["toLine"] !== undefined;
}

/** Each test in a spec, by title, with its body. */
export function testsByTitle(spec: string): Map<string, string> {
  const out = new Map<string, string>();
  // A TEST, not a step or a group: `test(`, `test.only(`, `test.skip(`,
  // `test.fixme(`, `test.fail(`, `test.slow(` with a title. `test.step("…")`
  // and `test.describe("…")` matched too until run 20261012T140617Z, which
  // counted 20 "tests" in a 5-test spec and cut every test's body at its first
  // step — so a rule reading a test saw only its opening lines.
  const re = /\btest(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(["'`])([\s\S]*?)\1/g;
  const starts: Array<{ title: string; at: number }> = [];
  for (const m of spec.matchAll(re)) starts.push({ title: (m[2] ?? "").trim(), at: m.index ?? 0 });
  for (let i = 0; i < starts.length; i++) {
    const here = starts[i];
    if (!here) continue;
    const end = starts[i + 1]?.at ?? spec.length;
    out.set(here.title, spec.slice(here.at, end));
  }
  return out;
}

/**
 * What the matcher was given, as `(first argument)` — or "" when it takes none.
 *
 * A trailing options object is dropped: `{ timeout: 5000 }` is how long to wait
 * for a claim, not part of the claim, and a repair may legitimately change it.
 */
function matcherArgument(after: string): string {
  if (!after.startsWith("(")) return "";
  let depth = 0;
  let end = -1;
  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return "";
  const args = after.slice(1, end).trim();
  const withoutOptions = args.replace(/,\s*\{[^{}]*\}\s*$/, "").trim();
  return `(${withoutOptions})`;
}

/**
 * What a test ASSERTS, normalised — the arguments of every expect(...) call,
 * with whitespace flattened.
 *
 * Used to tell a heal from a retreat: changing a locator is repair, changing
 * what the test expects is a different test wearing the same name.
 */
export function assertionsOf(body: string): string[] {
  const out: string[] = [];
  const re = /\bexpect\s*\(/g;
  for (const m of body.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < body.length && depth > 0; i++) {
      const c = body[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    // The matcher AND what it expects. Keeping only the matcher name was a
    // hole big enough to drive a retreat through: `toHaveURL(/#\/login/)`
    // relaxed to `toHaveURL(/#\//)` produced the same signature, so the rule
    // that refuses a weakened claim saw no change and allowed it — twice
    // refused, once let through, and the suite then passed while checking less
    // (20260925T192122Z).
    const rest = body.slice(i);
    const tail = /^\s*(\.\s*\w+)+/.exec(rest)?.[0] ?? "";
    out.push(
      `${body.slice(start, i - 1)}${tail}${matcherArgument(rest.slice(tail.length))}`
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}
