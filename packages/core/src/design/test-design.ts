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
  /**
   * The model's one-line justification that THIS item's page and source follow
   * from the story's own text — not from an existing test's scope or label
   * (W2/W6, F-0087/F-0088). Optional, and never string-matched: it is shown to
   * the approver, whose job is to judge whether the page and source really fit.
   */
  rationale?: string;
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
  /** The criteria's LABELS ("AC-1", "AC-2"), which is what a design item cites. */
  acceptanceCriteria: string[];
  /**
   * A hash of what the story SAYS — its acceptance criteria and description,
   * in full (`storyTextHash` in design/fingerprint.ts). The labels above do
   * not change when a criterion is reworded, so without this a corrected
   * requirement read as an unchanged story (run 20261112T232301Z). Absent in
   * ledgers recorded before it existed.
   */
  textHash?: string;
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
      ...(typeof r["rationale"] === "string" && r["rationale"].trim()
        ? { rationale: r["rationale"].trim() }
        : {}),
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
/** Words that name an action moving the page from one state to another. */
const STATE_CHANGE =
  /\b(click\w*|choos\w*|chose|select\w*|navigat\w*|submit\w*|enter\w*|typ(e|es|ed|ing)|press\w*|open\w*|clos\w*|log(s|ged|ging)? ?(in|out)|sign(s|ed|ing)? ?(in|out|up)|add\w*|remov\w*|sort\w*|filter\w*|search\w*|switch\w*|toggl\w*|go(es)? to|went to|scroll\w*|apply|applie\w*|register\w*|after|then|changes?|moves?|becomes?)\b/i;

/**
 * An assertion call: \`expect(…)\`, and the retrying forms \`expect.poll(…)\` and
 * \`expect.soft(…)\`, however the chain is broken across lines. bdd2pw 4.6.3's
 * active-page rule emits \`await expect\n  .poll(…)\`; counting only
 * \`expect(\` read that test as having no assertion (20261019T181040Z).
 */
export const ASSERTION_CALL = /\bexpect(?:\s*\.\s*(?:poll|soft))?\s*\(/g;

/**
 * A shape problem that makes a test weaker or broader than its design but
 * does not make it broken or fake (decided 19 Oct 2026). Those still stop the
 * run: a failing or empty test, one that catches its own failure, a known-bug
 * test without its marker, a state transition with no action. These get one
 * fix attempt and then go to the reviewer, in the report and the Jira record.
 */
/**
 * The part of a review-only problem a person reads: its first sentence. The
 * rest is advice to the agent (which selector to build, which run tried what)
 * and made the Jira comment in 20261019T202717Z hard to read.
 */
export function forReviewer(problem: string): string {
  const cut = problem.indexOf(". ");
  return (cut >= 0 ? problem.slice(0, cut) : problem).replace(/\.$/, "");
}

export function isReviewOnly(problem: string): boolean {
  return (
    problem.startsWith("the scan is not scoped") ||
    problem.startsWith("the assertion is on the whole violations array") ||
    problem.startsWith("a state-transition test needs an assertion that the action took effect") ||
    problem.startsWith("the destination assertion matches a prefix") ||
    problem.startsWith("the control-state assertion has no valid-case counterpart") ||
    problem.startsWith("a negative assertion located by text")
  );
}

/** The separate claims in an expected result: split on ";", "and", "then". */
export function expectationParts(expected: string): string[] {
  return expected
    .split(/;|\.\s+(?=[A-Z])|,?\s+and\s+(?=(?:the|a|an|it|its|each|every|page|no)\b)|,?\s+then\s+/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

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
    // State transition means an action that moves the page from one state to
    // another. 20261019T155404Z labelled every item state-transition, including
    // "each product card shows a name, a price and an image" and "page controls
    // are present"; the end-of-run check then demanded a before-and-after
    // assertion of tests that have no action, and the agent invented some.
    if (
      it.technique === "state-transition" &&
      !STATE_CHANGE.test(`${it.conditions.join(" ")} ${it.expected}`)
    )
      problems.push(
        `${at}: technique "state-transition" needs an action that changes the page's state, and ` +
          "this item names none in its conditions or expected result. If it checks what one page " +
          'shows, use "equivalence-partitioning"; if there is an action, name it in the conditions ' +
          '(for example "page 2 control is clicked")',
      );
    // …and its expected result says two things: what shows the action took
    // effect, and the state it leaves. The end-of-run check asks the test for
    // both; if the design states only one, the agent has to invent the other
    // (20261019T155404Z, 163019Z). Asked here, the reviewer approves both.
    else if (it.technique === "state-transition" && expectationParts(it.expected).length < 2)
      problems.push(
        `${at}: a state-transition item's expected result names two things, separated by ";": what ` +
          "shows the action took effect (for example, the control you used is now shown as the " +
          'selected one) and the state it leaves behind. It names one: "' +
          it.expected +
          '"',
      );

    if (it.conditions.length === 0)
      problems.push(`${at}: list the test conditions — the values or situations exercised`);
    if (!it.expected) problems.push(`${at}: say what must be observed`);
    // The rule the logout test broke: an expectation nobody specified.
    // An accessibility item has no criterion behind it: it is in scope because
    // the project's config asks for that test type, and saying so is honest
    // where naming a criterion that never mentioned accessibility is not.
    const sourced =
      SOURCE.test(it.source) ||
      // A tracker issue key on its own, or with a type word before or after it
      // ("SCRUM-9", "task SCRUM-9", "SCRUM-9 sub-task"): a sub-task is where the
      // implementation facts live, and refusing the key for its form pushed the
      // agent to drop the true source (W3, F-0086). Case-sensitive, so a
      // lowercase word like "page-2" is not mistaken for a key.
      /\b[A-Z][A-Z0-9_]+-\d+\b/.test(it.source) ||
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

    // W33 (F-0151, F-0130): a test that changes the shared sign-in account and
    // does not restore it makes the whole suite non-rerunnable — SCRUM-10's
    // forgot-password test reset the fixture account's password and left it
    // changed, and in a full parallel run every later sign-in answered 401.
    // Nothing in the design rules looked for it. If an item mutates a credential
    // of the account the suite signs in with, its expected result has to say how
    // the account is left usable: the original restored, or an account this test
    // creates. Registration (a NEW account) is not a mutation of the shared one.
    // Read the EXPECTED result, not the conditions: "the password is changed" is
    // the outcome that mutates the account, whereas a sign-in test only enters a
    // password as setup and an axe test signs in before scanning — including
    // their conditions flagged both (32 items across the ledgers, almost all
    // sign-in/accessibility setup; scoping to expected leaves the genuine
    // change-password items).
    if (mutatesAccount(it.expected) && !leavesFixtureRestored(it.expected))
      problems.push(
        `${at}: this item changes the shared sign-in account (a password, e-mail or security ` +
          "question the suite logs in with). Its expected result must say how the account is left " +
          "usable for the tests that run after it — restore the original value at the end, or use " +
          "an account this test creates — otherwise a whole-suite run answers 401 on every sign-in " +
          "after it and cannot be re-run.",
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

  // Coverage: every criterion has a test. Normally that is a functional test,
  // but a criterion whose natural type is accessibility or security is satisfied
  // by an item of that type covering it (W25, F-0112). "Every criterion has a
  // functional test" refused AB#110's AC-3 ("the sign-in page passes a WCAG
  // scan") for having no functional item; the agent added a functional item to
  // satisfy the rule and implemented it as a second copy of the axe scan — the
  // coverage rule produced padding. The design records only the AC labels, not
  // their text, so the criterion's natural type is read from the item the agent
  // chose to cover it with; the reviewer approving the design is the check that
  // the type fits the criterion. confirmation is for a bug, never a criterion,
  // so it does not count here.
  const coveringTypes: readonly TestType[] = ["functional", "accessibility", "security"];
  for (const ac of storyAcs) {
    const covered = d.items.some(
      (it) =>
        coveringTypes.includes(it.type) &&
        acLabels(it.covers).some((l) => l === ac || baseLabel(l) === ac),
    );
    if (!covered)
      problems.push(`${ac} has no functional, accessibility or security test in the design`);
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

  // W15/W18/W21 (F-0097/F-0100/F-0104): a stateful story names its isolation.
  // SCRUM-19's basket tests shared one account and ran serially, so the product
  // one test added was still in the basket when the next added it — Juice Shop
  // answered 500 and a badge expecting "1" read "2". The agent repaired locators
  // for nine runs instead of isolating the data. Checked once per story, not per
  // item: isolation is a suite-level decision (usually one beforeEach), so a
  // design that mutates shared state has to say, SOMEWHERE in its items (or an
  // exclusion reason), how each test gets its own data.
  const designText = (it: DesignItem) => `${it.conditions.join(" ")} ${it.expected}`;
  const anyStateful = d.items.some((it) => mutatesSharedState(designText(it)));
  const anyIsolation =
    d.items.some((it) => statesIsolation(designText(it))) ||
    d.excluded.some((e) => statesIsolation(e.reason));
  if (anyStateful && !anyIsolation)
    problems.push(
      "this story changes shared server-side state (a basket, booking or order), but no item says " +
        "how each test gets its own data. Tests share one account and run one after another, so one " +
        "test's leftover breaks the next — a product already in the basket answers HTTP 500, a badge " +
        "that expects 1 reads 2. Add the isolation to the item(s) that mutate state: a fresh account " +
        "per test, the state cleared before each test (a beforeEach that empties the basket), or a " +
        "unique datum per test (a different product).",
    );

  return problems;
}

/** The stage-1 facts, from the preflight digest recorded in the ledger. */
export function storyFacts(events: AnyRunEvent[]): StoryFacts | undefined {
  const digest = successful(completedCalls(events), "aqa.story_context").pop();
  return factsFrom(asRecord(digest?.result)?.["facts"]);
}

/** Stage-1 facts from their recorded (untyped) form — the preflight digest's `facts`. */
export function factsFrom(raw: unknown): StoryFacts | undefined {
  const f = asRecord(raw);
  if (!f) return undefined;
  return {
    acceptanceCriteria: asArray(f["acceptanceCriteria"]).map(String),
    ...(typeof f["textHash"] === "string" && f["textHash"] ? { textHash: f["textHash"] } : {}),
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
  if (last) return parseDesign(last.args);
  // A story unchanged since an earlier run keeps the design a person approved
  // there (design/fingerprint.ts). The route event carries it, with the run it
  // came from, so the approval it rests on is one click away in the ledger.
  const carried = carriedDesign(events);
  return carried ? parseDesign(carried.args) : undefined;
}

/**
 * The design approved in the latest earlier run of this story, when the story
 * has changed since (or cannot be shown unchanged) and its tests are on disk:
 * what those tests were written for. The first route records it
 * (`because.previousDesign`), so the comparison with the design approved in
 * this run is made from the ledger alone.
 */
export function previousDesign(
  events: AnyRunEvent[],
): { runId: string; design: TestDesign } | undefined {
  for (const e of events) {
    if (e.kind !== "route") continue;
    const p = asRecord(asRecord(asRecord(e.payload as unknown)?.["because"])?.["previousDesign"]);
    const args = asRecord(p?.["args"]);
    if (p && args) return { runId: String(p["runId"] ?? ""), design: parseDesign(args) };
  }
  return undefined;
}

/** The design a route carried over from an earlier run of an unchanged story. */
export function carriedDesign(
  events: AnyRunEvent[],
): { runId: string; fingerprint: string; args: Record<string, unknown> } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== "route") continue;
    const c = asRecord(asRecord(asRecord(e.payload as unknown)?.["because"])?.["carriedDesign"]);
    const args = asRecord(c?.["args"]);
    if (c && args)
      return { runId: String(c["runId"] ?? ""), fingerprint: String(c["fingerprint"] ?? ""), args };
  }
  return undefined;
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
    // The model's justification that this page and source fit the story, shown
    // so the approver can judge it (W2/W6). When absent, say so — an item with
    // no justification is the one most likely to have been copied from an
    // existing test's scope or label.
    out.push(`      why: ${it.rationale ? it.rationale : "— not justified against the story"}`);
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
): Map<string, { scenario: string; how: "criterion" | "bug" | "type" | "design id" }> {
  const out = new Map<
    string,
    { scenario: string; how: "criterion" | "bug" | "type" | "design id" }
  >();
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
    // An item that covers the story itself (accessibility) has no criterion or
    // bug to match on: run 20261016T201236Z designed the axe scan as a new D26
    // while this story's "AC-story: Login page passes axe-core WCAG A/AA scan"
    // (D13) already existed, and a second copy of that test was written. A
    // scenario of this story with the same declared type and no criterion or
    // bug tag is that test.
    if (ac === undefined && bug === undefined) {
      const claimed = new Set([...out.values()].map((v) => v.scenario));
      const same = tagged.filter(
        (sc) =>
          isReal(sc.scenario) &&
          sc.acs.length === 0 &&
          sc.bugs.length === 0 &&
          sc.types.includes(it.type),
      );
      const pick =
        same.find((sc) => sc.designs.includes(it.id.toUpperCase())) ??
        same.find((sc) => !claimed.has(sc.scenario));
      if (pick) {
        out.set(it.id, { scenario: pick.scenario, how: "type" });
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
): {
  untested: string[];
  untagged: string[];
  unmarked: string[];
  wrongShape: string[];
  /** Weaker or broader than the design, but working: one fix attempt, then the reviewer's. */
  reviewShape: string[];
} {
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
  // A design item is tested only when a scenario tags it AND, once the spec
  // exists, a test in the spec references that @design id (W8/W10,
  // F-0090/F-0092). design-item-not-tested used to read the feature file alone,
  // so an item whose scenario was tagged but whose generated test was dropped
  // or never written read as covered — "every approved design item has a test
  // that references it" is the spec-level half the feature tag cannot see. With
  // no spec on disk yet, no-spec-written carries it, so the spec clause is off.
  const specBodyIds = new Set<string>();
  for (const sp of specs) for (const id of specBodies(sp.text).keys()) specBodyIds.add(id);
  const haveSpecs = specs.length > 0;
  const untested = design.items
    .filter((i) => !tagged.has(i.id) || (haveSpecs && !specBodyIds.has(i.id)))
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
  const reviewShape: string[] = [];
  for (const item of design.items) {
    const body = bodies.get(item.id);
    if (!body) continue;
    for (const missing of shapeProblems(item, body))
      (isReviewOnly(missing) ? reviewShape : wrongShape).push(
        `${item.id} (${item.covers}): ${missing}`,
      );
  }

  // W33 (F-0151, F-0130): the fixture is left as it was found. For an item whose
  // design is about changing an account credential, the TEST must either restore
  // it or run against its own account. The restore can live in an afterEach /
  // afterAll hook outside the item's own body, so the whole spec is searched,
  // not just the body. Review-only: the mutation is real but whether the suite
  // is left rerunnable is a judgement a person makes from the whole file.
  const allSpecText = specs.map((s) => s.text).join("\n");
  const restored = leavesFixtureRestored(allSpecText);
  for (const item of design.items) {
    const body = bodies.get(item.id);
    if (!body) continue;
    if (!mutatesAccount(item.expected)) continue;
    if (!bodyMutatesAccount(body)) continue;
    if (restored) continue;
    reviewShape.push(
      `${item.id} (${item.covers}): the test changes the shared sign-in account and nothing ` +
        "restores it, so a whole-suite run answers 401 on every sign-in after it. Restore the " +
        "original value at the end of the test (or in an afterEach/afterAll hook), or run against " +
        "an account this test creates.",
    );
  }

  // W15/W18/W21 (F-0097/F-0100/F-0104): a stateful test isolates its data. A
  // test that mutates shared state (adds to the basket, creates a booking) when
  // nothing isolates it — not its own body, not a shared hook the whole spec
  // runs — inherits a prior test's state and collides (the SCRUM-19 500s). The
  // isolation can be inline (AC-2 cleared the basket before adding) or in a
  // beforeEach, so the whole spec is searched. Review-only: whether two tests
  // truly collide is a judgement from the file.
  const specIsolates = isolatesTestData(allSpecText) && /beforeEach|afterEach/.test(allSpecText);
  for (const item of design.items) {
    const body = bodies.get(item.id);
    if (!body) continue;
    if (!bodyMutatesSharedState(body)) continue;
    if (isolatesTestData(body) || specIsolates) continue;
    reviewShape.push(
      `${item.id} (${item.covers}): the test changes shared server-side state (a basket, booking ` +
        "or order) and nothing isolates it — no fresh account, no cleared state, no unique datum, " +
        "in this test or a shared beforeEach. A test that ran before it leaves its data behind, so " +
        "this one collides (a product already in the basket, a duplicate booking → HTTP 500) and " +
        "the suite is not re-runnable. Register a fresh account per test, clear the state before " +
        "each test, or use a unique datum per test.",
    );
  }

  // W11 (F-0093): the scope rule removes the story's own control when it lives
  // in the header. SCRUM-18's search box is in the top toolbar; the accessibility
  // scan was scoped to <main>, which excludes the toolbar, so a real "label"
  // violation on the search box passed and the run reported nothing. The scope
  // rule exists to keep site-wide header/footer noise off a story — but scoping
  // to a generic page region also drops the story's own controls that happen to
  // sit outside main. When the scan is scoped to main/body alone and the story
  // is about a control that usually lives in the header or toolbar, the scope
  // may have hidden a defect in the story's own control; a person decides, so it
  // is review-only.
  const storyText = design.items
    .map((i) => `${(i.conditions ?? []).join(" ")} ${i.expected} ${i.covers}`)
    .join(" ");
  if (HEADER_CONTROL.test(storyText)) {
    for (const item of design.items) {
      if (item.type !== "accessibility") continue;
      const body = bodies.get(item.id);
      if (!body) continue;
      const includes = [...body.matchAll(/\.include\s*\(\s*(['"`])([^'"`]*)\1/g)].map((m) =>
        (m[2] ?? "").trim(),
      );
      const genericOnly = includes.length > 0 && includes.every((x) => GENERIC_REGION.test(x));
      if (genericOnly)
        reviewShape.push(
          `${item.id} (${item.covers}): the accessibility scan is scoped to the main region ` +
            `(${includes.join(", ")}), which excludes the header and toolbar — but this story is ` +
            "about a control (a search box, menu or cart) that usually lives there, so a real " +
            "defect in the story's own control is scoped out and never reported. Scope the scan to " +
            'the story\'s own control as well as the main content — .include("<the control>") ' +
            "alongside the region, not the region alone.",
        );
    }
  }

  return { untested, untagged, unmarked, wrongShape, reviewShape };
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
          "elsewhere on the page is not reported against this story. Scope it to the story's own " +
          "control wherever it lives — a search box, menu or sign-in icon in the header is part " +
          "of this story, so include it even though it sits outside the main content; scoping to " +
          "<main> alone scopes a header control out of the scan (W11). .include takes a CSS " +
          "selector, and the page snapshot shows roles rather than classes, so build it from " +
          'what the snapshot shows: a role (navigation → "nav", main → "main", form → ' +
          '"form", list → "ul"), an attribute the elements carry ("[data-test]" values), or ' +
          "several joined with commas. A class you have not seen on the page will match nothing " +
          '(20261019T181040Z tried ".products")',
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
    //
    // The check needs an action to apply to, and it must not send the agent
    // looking for a claim the design never made. 20261019T155404Z: a green
    // suite was sent back with "one that the action took effect (the menu
    // closed, the URL changed …)"; the agent rewrote a passing test to add
    // one, broke it, and proposed the same false bug three times. The example
    // of a URL also contradicted `claimNotInDesign`. So: no action, no check;
    // and the message names the design item's own expectation and points at
    // what the page shows, never at an address the design does not mention.
    const actions = [
      ...body.matchAll(
        /\.(click|dblclick|fill|press|check|uncheck|selectOption|setInputFiles|tap|hover)\s*\(/g,
      ),
    ];
    // Navigation is the action when the design says so and names no other:
    // "user navigates directly to the product list URL" → redirected to sign-in
    // (20261024T175506Z, a 9/9 run blocked for "performs no action" because
    // the only verb in the test was page.goto). A goto before a click is setup,
    // not the action, so it counts only when the conditions name navigation
    // and nothing a hand would do on the page.
    const conditionsText = (item.conditions ?? []).join(" ");
    const navigationIsTheAction =
      actions.length === 0 &&
      /\b(navigat\w*|go(es)? to|went to|open\w*|visit\w*|load\w*|reload\w*)\b/i.test(
        conditionsText,
      ) &&
      !/\b(click\w*|fill\w*|enter\w*|typ(e|es|ed|ing)|press\w*|select\w*|submit\w*|check\w*|toggl\w*|hover\w*)\b/i.test(
        conditionsText,
      );
    const gotos = navigationIsTheAction
      ? [...body.matchAll(/\.(goto|reload|goBack|goForward)\s*\(/g)]
      : [];
    const last = actions[actions.length - 1] ?? gotos[gotos.length - 1];
    // No action at all, though a state-transition item names one (the design
    // check makes sure it does). 20261019T200105Z passed a "page 2 control is
    // marked after clicking page 2" item with a test that never clicked and
    // only checked that page 1 was current on load — the relaxation above had
    // turned "no action" into "nothing to check".
    if (last === undefined)
      out.push(
        `the design item is a state transition — "${(item.conditions ?? []).join("; ")}" → ` +
          `"${item.expected}" — but the test performs no action. Perform the action its ` +
          "conditions name (a click, a fill, a selection), then assert each part of the " +
          "expected result",
      );
    if (last !== undefined) {
      const assertions = (body.match(ASSERTION_CALL) ?? []).length;
      const after = (body.slice((last.index ?? 0) + last[0].length).match(ASSERTION_CALL) ?? [])
        .length;
      if (assertions < 2 || after === 0)
        out.push(
          `a state-transition test needs an assertion that the action took effect as well as one for ` +
            `the state it leaves behind (the design expects: "${item.expected}"). Assert each part of ` +
            "that expectation, using what the page shows after the action — the element you acted on " +
            "or the content that changes, read from the page snapshot — and wait for it with a " +
            "web-first assertion before comparing. Do not add a check the design does not state, " +
            "such as an address change",
        );
    }
  }
  // W34 (F-0153): an assertion that is true for the wrong reason.
  //
  // Two accepted tests passed while a seeded fault was live, because the
  // assertion did not actually exercise the transition the design named:
  //   - a logout test asserted toHaveURL(/#\//), a prefix that /#/login also
  //     satisfies, so "returns to the home page" passed on the wrong page;
  //   - a "Register button is disabled when the passwords differ" test filled
  //     only the two password fields and asserted toBeDisabled(), which held
  //     because the other required fields were empty, whether or not the rule
  //     under test exists.
  // Neither is a broken or fake test, so both go to the reviewer (isReviewOnly)
  // rather than stopping the run: only a seeded fault reveals them, and the
  // heuristic that finds them can misread a legitimate test.
  //
  // Each is scoped to a design item whose OWN expected result is about that
  // kind of transition — a destination, or a control's enabled state. Firing on
  // any test would re-create the mistake the state-transition check was taught
  // not to make: telling the agent to add an address check the design never
  // named (20261019T155404Z), which it did, broke, and filed as a false bug.
  if (
    /\b(home ?page|login ?page|storefront|redirect\w*|lands? on|returns? to|url|route)\b/i.test(
      item.expected,
    )
  ) {
    const weakUrl = weakUrlDestination(body);
    if (weakUrl)
      out.push(
        `the destination assertion matches a prefix other pages also satisfy: ${weakUrl} is true ` +
          `of /#/login as much as the page the design names ("${item.expected}"). Pin the ` +
          "destination — assert the exact route the action reaches (anchor the end, " +
          "toHaveURL(/#\\/$/) for the home page, or give the full path), not a fragment every " +
          "in-app URL contains",
      );
  }
  if (
    /\b(disabled|enabled|greyed|grey(?:ed)?|clickable|cannot (?:be )?(?:click|submit))\b/i.test(
      item.expected,
    )
  ) {
    if (lopsidedControlState(body))
      out.push(
        "the control-state assertion has no valid-case counterpart: the test asserts the control " +
          "is disabled after an action but never asserts it is enabled when every other input is " +
          "valid, so the assertion holds whether or not the rule under test exists (a Register " +
          "button is disabled anyway while other required fields are empty). Assert both: the " +
          "control enabled in its all-valid baseline, and the control after the one condition " +
          "under test changes",
      );
  }
  // W10 (F-0092): a negative-form assertion must name an element, not prose.
  //
  // A "no match shows no product cards" test asserted
  // `getByText("product cards").not.toBeVisible()` — but "product cards" is a
  // description, never on any page, so the assertion passes whatever the product
  // does. Absence located by text is satisfied whenever that text is simply not
  // there, for any reason. The remedy is to locate the thing whose absence you
  // mean by what it IS (a role, a test id, the card's selector), so "no product
  // cards" is "no .product elements", not "the words 'product cards' are
  // unprinted". Review-only: a negative assertion on a real error string (say
  // "Internal Server Error") is legitimate and only a person can tell the two
  // apart.
  const prose = proseAbsenceAssertion(body);
  if (prose)
    out.push(
      `a negative assertion located by text passes whenever that text is absent for any reason: ` +
        `${prose}. Locate what you are asserting is gone by what it is — a role, a test id, or ` +
        "the element's selector (getByRole / getByTestId / locator) — so its absence means the " +
        "product behaved, not that a phrase happens not to be printed",
    );
  if (item.expectFail === true && !/\btest\.fail\s*\(/.test(body))
    out.push("no test.fail marker, though the design says this test is expected to fail");
  return out;
}

/**
 * A negative/absence assertion (`.not.toBeVisible()`, `.toBeHidden()`,
 * `.toHaveCount(0)`, …) whose target is located by TEXT (`getByText`, a `text=`
 * or `:has-text()` engine). Such an assertion passes whenever that text is
 * absent for any reason, so it proves nothing about the product (W10, F-0092).
 * Returns the offending assertion, normalised, or undefined.
 */
export function proseAbsenceAssertion(body: string): string | undefined {
  for (const a of assertionsOf(body)) {
    const negative =
      /\.not\.(toBeVisible|toBeAttached|toContainText|toHaveText|toBeInViewport)\b/.test(a) ||
      /\.toBeHidden\(/.test(a) ||
      /\.toHaveCount\(\s*0\s*\)/.test(a);
    const byText = /getByText\(/.test(a) || /text=/.test(a) || /:has-text\(/.test(a);
    if (negative && byText) return a;
  }
  return undefined;
}

/**
 * A verb changing a credential of the account the suite signs in with, in either
 * order — "reset the password" and "the password is changed" both count.
 */
const CREDENTIAL = /\b(password|e-?mail|security\s+(?:question|answer)|credentials?)\b/;
const ACCOUNT_MUTATION = new RegExp(
  `\\b(reset\\w*|chang\\w*|updat\\w*|set\\w*)\\b[\\s\\S]{0,40}?${CREDENTIAL.source}` +
    `|${CREDENTIAL.source}[\\s\\S]{0,40}?\\b(reset\\w*|chang\\w*|updat\\w*)\\b`,
  "i",
);

/** A restore, or the use of a throwaway/own account, that leaves the fixture usable. */
const RESTORE_SIGNAL =
  /\b(restore\w*|revert\w*|original\s+password|afterEach|afterAll|per-test account|throwaway|dedicated(?:\s+test)?\s+account|freshly[\s-]registered|newly[\s-]registered|unique\s+(?:e-?mail|account)|Date\.now\(\)|faker)\b/i;

/**
 * Whether a design item's prose, or a test, changes a credential of the shared
 * sign-in account (W33). Registration creates a NEW account, which is not a
 * mutation of the shared one, so a registration context with no reset/change/
 * update/forgot verb is excluded.
 */
export function mutatesAccount(text: string): boolean {
  // A change that did NOT take effect does not mutate the account: a refused or
  // rejected change, a "the password is not changed" negative case, or an
  // access-control check that the route requires sign-in. These are the bulk of
  // a change-password epic and must not be asked for a restore they never need.
  const nonOccurrence =
    /\bnot\s+(?:chang|updat|reset|accept)\w*|\brefus\w*|\breject\w*|\bdenied\b|requires?\s+(?:authentication|login|a\s+login|to\s+(?:be\s+)?(?:sign|log))|must\s+(?:be\s+)?(?:authenticat|logged|signed)|cannot\s+(?:chang|updat|reset|access)|unauthenticated/i.test(
      text,
    );
  const positiveSuccess =
    /\b(?:is|was|been|then)\s+(?:chang|updat|reset)\w*|\bsuccessfully\b|\bconfirmation\b/i.test(
      text,
    );
  if (nonOccurrence && !positiveSuccess) return false;
  const registrationOnly =
    /\b(register\w*|sign[\s-]?up|create[sd]?\s+(?:a\s+|an\s+)?(?:new\s+)?account|new user)\b/i.test(
      text,
    ) && !/\b(reset|chang\w*|updat\w*|forgot)\b/i.test(text);
  if (registrationOnly) return false;
  if (/\bforgot[\s-]?password\b/i.test(text)) return true;
  if (/\bdelete[sd]?\b[\s\S]{0,24}\baccount\b/i.test(text)) return true;
  return ACCOUNT_MUTATION.test(text);
}

/** Whether the design/test text states a restore or the use of its own account. */
export function leavesFixtureRestored(text: string): boolean {
  if (RESTORE_SIGNAL.test(text)) return true;
  // "change it back", "reset the password back", "put the account back".
  if (/\b(chang\w*|reset|put|set)\b[\s\S]{0,24}\bback\b/i.test(text)) return true;
  // "registers a (new) account", used so the test does not touch the shared one.
  if (/\bregisters?\b[\s\S]{0,24}\baccount\b/i.test(text)) return true;
  return false;
}

/** A control that usually lives in the header or toolbar, not in main (W11). */
const HEADER_CONTROL =
  /\b(search|magnifying|top[\s-]?bar|toolbar|header|nav(?:bar|\s*bar)?|menu|cart|basket|sign[\s-]?in\s+icon)\b/i;

/** A scan include that is a generic page region rather than a specific control (W11). */
const GENERIC_REGION = /^(?:main|body|\[role=["']?main["']?\]|#main|\.main)$/i;

/** Whether a spec body actually runs a credential-change flow (W33 verifier). */
export function bodyMutatesAccount(body: string): boolean {
  const flow =
    /forgot-?password|reset-?password|change-?password|new[\s-]?password|newPassword|security\s*answer|securityAnswer/i.test(
      body,
    );
  const acts = /\.(fill|click|press|check)\s*\(|request\.(post|put|patch)\s*\(/i.test(body);
  return flow && acts;
}

// ── W15/W18/W21 (F-0097/F-0100/F-0104): per-test data isolation ──────────────
// Stateful stories (a basket, a booking, an order) share one account and run
// one after another, so the state one test creates is still there for the next:
// Juice Shop answers 500 on the duplicate add, and a badge that expects "1"
// reads "2". The agent spent nine runs of nine repairing locators instead of
// isolating the data. These detectors drive a design rule and a review-only
// verifier check: a test that mutates shared server-side state must isolate it —
// a fresh account per test, the state cleared before each test, or a unique
// datum per test.

/**
 * A noun naming shared server-side state a story mutates and another test sees.
 * Not only e-commerce: the booker createroom run (20261104T231022Z) showed the
 * list was too narrow — "a room is added to the room list" is as stateful as a
 * basket add, and rooms, bookings and inbox messages accumulate the same way.
 */
const SHARED_STATE =
  /\b(basket|cart|booking|reservation|order|checkout|wish[\s-]?list|address\s*book|room|inbox)\b/;

/**
 * A verb that creates or changes that state (as opposed to reading it). `clear`,
 * `empty` and `remove` are isolation/teardown rather than the mutation under
 * test, so they are not here; a removal test still trips `SHARED_STATE` through
 * its add step.
 */
const STATE_MUTATION_VERB =
  /\b(add\w*|creat\w*|plac\w*|submit\w*|book\w*|reserv\w*|check\s*out|checkout)\b/;

/** A signal that the test did NOT change the state — refused, prevented, read-only. */
const STATE_NON_OCCURRENCE =
  /\bnot\s+(?:add|creat|plac|book|order|chang)\w*|\bno\s+\w+\s+(?:is|are|was|were)\s+(?:add|creat|book|order|plac)\w*|\brefus\w*|\breject\w*|\bprevent\w*|\bcannot\b|\bread[\s-]?only\b|\bjust\s+(?:view|see|show)\w*|\bwithout\s+(?:adding|changing|creating)\b/i;

/** A statement that each test gets its own data, or clears/resets what it shares. */
const ISOLATION =
  /\b(fresh|unique|per[\s-]?test|isolat\w*|own\s+(?:account|basket|booking|data)|new\s+account|registers?\s+(?:a\s+)?(?:new\s+)?account|before\s*each|beforeEach|after\s*each|afterEach|each\s+test|cleared|clear\w*\s+(?:the\s+)?(?:basket|cart|state|booking)|empt(?:y|ies|ied)\s+(?:the\s+)?(?:basket|cart)|reset\w*\s+(?:the\s+)?(?:basket|state|data)|a\s+different\s+(?:product|item|room|datum)|synth(?:etic)?[\s-]?data|synthdata|generated?\s+(?:test\s+)?data)\b/i;

/**
 * Whether a design item's prose describes mutating shared server-side state
 * (adding to a basket, creating a booking, placing an order). A read-only view
 * of that state, or a change that was refused, is excluded (W15/W18/W21).
 */
export function mutatesSharedState(text: string): boolean {
  // A refused / "no room is added" / read-only item does not mutate. A genuine
  // creation ("a room is added to the list") carries none of these words, so the
  // guard needs no positive-case exception — the booker createroom D2 ("no room
  // is added") stays excluded while D1/D3 ("room is added", "create the room")
  // are caught.
  if (STATE_NON_OCCURRENCE.test(text)) return false;
  if (!SHARED_STATE.test(text)) return false;
  // A mutation verb within a short window of the state noun, either order.
  return (
    new RegExp(`${STATE_MUTATION_VERB.source}[\\s\\S]{0,40}?${SHARED_STATE.source}`, "i").test(
      text,
    ) ||
    new RegExp(`${SHARED_STATE.source}[\\s\\S]{0,40}?${STATE_MUTATION_VERB.source}`, "i").test(text)
  );
}

/** Whether the design/test text states a per-test isolation strategy (W15). */
export function statesIsolation(text: string): boolean {
  return ISOLATION.test(text);
}

/** Whether a spec body actually performs a stateful mutation (W15 verifier). */
export function bodyMutatesSharedState(body: string): boolean {
  return (
    /\/BasketItems|addToBasket|add\s+to\s+basket|\/api\/Bookings\b|\/booking\b|createBooking|place[\s\S]{0,12}order|\/api\/Orders\b|\bcheckout\b/i.test(
      body,
    ) || /\.(post|put)\s*\(\s*[`'"][^`'"]*(basket|booking|order|reservation)/i.test(body)
  );
}

/**
 * Whether a spec body (or a shared hook its tests all run) isolates the data it
 * mutates: a fresh/registered account, a unique datum, or the state cleared.
 * The clearing can be inline in the test — SCRUM-19's AC-2 fetched the basket
 * and deleted its items before adding — or in a beforeEach/afterEach hook.
 */
export function isolatesTestData(text: string): boolean {
  return (
    /\bregisters?\b|\/api\/Users\b|\/rest\/user\/(?!login)|createAccount|sign[\s-]?up/i.test(
      text,
    ) ||
    /Date\.now\(\)|faker|randomUUID|crypto\.random|`[^`]*\$\{[^}]*\}@|synthdata/i.test(text) ||
    /\.delete\s*\(\s*[`'"][^`'"]*(BasketItems|basket|booking|order)/i.test(text) ||
    /empt(?:y|ies|ied)\s+(?:the\s+)?(?:basket|cart)|clear\w*\s+(?:the\s+)?(?:basket|cart|state)/i.test(
      text,
    )
  );
}

/**
 * A toHaveURL / url-contains assertion whose pattern is only the SPA root
 * scaffolding (`#`, `/`) with no route segment and no end anchor, so a longer
 * URL such as /#/login satisfies it too. Returns the offending token, or
 * undefined (W34, F-0153).
 */
export function weakUrlDestination(body: string): string | undefined {
  for (const m of body.matchAll(/\.toHaveURL\s*\(/g)) {
    const arg = balancedArg(body, (m.index ?? 0) + m[0].length - 1);
    if (arg !== undefined && isRootOnlyUrl(arg)) return firstArgument(arg);
  }
  // expect(page.url()).toContain("…") / .toMatch(/…/) — only when it is plainly
  // a URL being matched, so a text assertion that happens to contain "/" is left
  // alone.
  for (const m of body.matchAll(/\.(?:toContain|toMatch)\s*\(/g)) {
    const at = m.index ?? 0;
    const arg = balancedArg(body, at + m[0].length - 1);
    if (arg === undefined) continue;
    const before = body.slice(Math.max(0, at - 48), at);
    if (!/\b(url|href|location)\b/i.test(before)) continue;
    if (isRootOnlyUrl(arg)) return firstArgument(arg);
  }
  return undefined;
}

/** The text inside the parentheses that open at `open`, or undefined. */
function balancedArg(body: string, open: number): string | undefined {
  if (body[open] !== "(") return undefined;
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return undefined;
}

/** The first argument, dropping a trailing options object (`, { timeout }`). */
function firstArgument(arg: string): string {
  return arg.replace(/,\s*\{[^{}]*\}\s*$/, "").trim();
}

/**
 * True when a toHaveURL/contains argument pins nothing but the app root: a
 * regex or string whose meaningful part is only `#` and `/`, and which is not
 * anchored to the end. `/#\/$/` (exact home) and `/#\/login/` (a route) are
 * both fine; `/#\//` and "/#/" are not. A variable or expression is treated as
 * pinned — code cannot read what it resolves to.
 */
function isRootOnlyUrl(raw: string): boolean {
  let s = firstArgument(raw);
  let endAnchored = false;
  const rx = /^\/([\s\S]*)\/[a-z]*$/i.exec(s);
  if (rx) {
    s = rx[1] ?? "";
    endAnchored = /\$$/.test(s);
  } else {
    const str = /^(['"`])([\s\S]*)\1$/.exec(s);
    if (!str) return false;
    s = str[2] ?? "";
  }
  if (endAnchored) return false;
  const core = s.replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "").replace(/\\/g, "");
  return core.length > 0 && /^[#/]+$/.test(core);
}

/**
 * True when a test asserts a control is DISABLED after an action but never
 * asserts the enabled (valid-case) counterpart. The disabled state then proves
 * nothing about the condition under test: an incomplete form disables the
 * control on its own (W34, F-0153). The enabled-only direction is not weak —
 * a disabled control would fail it — so only the disabled-without-enabled shape
 * is flagged.
 */
function lopsidedControlState(body: string): boolean {
  const disabled = /\.toBeDisabled\s*\(/.test(body) || /\.not\s*\.toBeEnabled\s*\(/.test(body);
  const enabled = /\.toBeEnabled\s*\(/.test(body) || /\.not\s*\.toBeDisabled\s*\(/.test(body);
  const action = /\.(fill|type|press|click|check|uncheck|selectOption|setInputFiles)\s*\(/.test(
    body,
  );
  return disabled && !enabled && action;
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

/**
 * Test titles tagged for ANOTHER story — a leftover in a shared epic spec that
 * this run did not write and is not its to repair, triage or report (W28, W19,
 * F-0126). A test with no @story tag is nobody's and stays in scope, so it is
 * NOT returned here.
 */
export function otherStoryTestTitles(spec: string, storyId: TrackerId): Set<string> {
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
      if (current.length > 0 && !includesId(current, storyId)) out.add((m[2] ?? "").trim());
      current = [];
    }
  }
  return out;
}

/**
 * Scenario names in a feature file tagged for ANOTHER story (W28/W19, F-0126).
 * bdd2pw names each test after its scenario, so a failing test's title matches
 * the scenario name here — which is the reliable signal right after a scaffold,
 * when the generated spec is on disk but not yet in the run's reads. A scenario
 * with no @story tag is nobody's and is not returned.
 */
export function otherStoryScenarios(feature: string, storyId: TrackerId): Set<string> {
  const out = new Set<string>();
  for (const s of scenarioStoryTags(feature))
    if (s.stories.length > 0 && !includesId(s.stories, storyId)) out.add(s.scenario);
  return out;
}

/** The last content this run has for a path, from what it wrote or read. */
export function fileTextFromEvents(events: AnyRunEvent[], path: string): string | undefined {
  const calls = completedCalls(events);
  // In-place edits made after the last full view, newest first, replayed onto
  // that view. Without them the "file as this run saw it" was the file before
  // the edits: in 20261023T165205Z the accessibility scan was scoped with
  // .include("mat-toolbar") by an edit, and the bug from that scoped scan was
  // dropped at the end of the run for claiming a scope "the spec does not"
  // have. An edit that no longer fits the text it is replayed onto means the
  // view is not this file any more, and nothing is better than a wrong answer.
  const edits: Array<{ old: string; new: string; all: boolean }> = [];
  const replay = (base: string): string | undefined => {
    let text = base;
    for (let k = edits.length - 1; k >= 0; k--) {
      const e = edits[k]!;
      if (!text.includes(e.old)) return undefined;
      text = e.all ? text.split(e.old).join(e.new) : text.replace(e.old, e.new);
    }
    return text;
  };
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!c || !c.ok || String(c.args["path"] ?? "") !== path) continue;
    if (c.toolName === "fs.replace_in_file") {
      const o = c.args["old"];
      const n = c.args["new"];
      if (typeof o === "string" && typeof n === "string")
        edits.push({ old: o, new: n, all: c.args["all"] === true });
      continue;
    }
    if (c.toolName === "fs.write_file") return replay(String(c.args["content"] ?? ""));
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
      if (typeof content === "string") return replay(content);
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
  for (const m of body.matchAll(ASSERTION_CALL)) {
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
