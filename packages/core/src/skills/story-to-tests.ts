import { routePathOf } from "../route/route.js";
import type { AnyRunEvent, Skill } from "../types.js";
import { StoryToTestsVerifier, type StoryToTestsOptions } from "../verify/story-to-tests.js";
import { gatherStoryContext } from "./story-context.js";
import { gatherJiraStoryContext } from "./jira-story-context.js";
import type { Tracker } from "../design/ids.js";
import { lockedScenarios, makeStoryRefusal } from "./story-rules.js";
import { composeRunReport } from "../mcp/adapters/summary.js";
import { composeQaRecord } from "../report/qa-record.js";
import { readSourceFiles } from "../report/coverage.js";
import { asRecord } from "../verify/evidence.js";
import { chooseRoute } from "../route/route.js";
import {
  approvedDesign,
  coverageOf,
  featurePathFor,
  parseDesign,
  specPathFor,
} from "../design/test-design.js";
import { nameChanged, suiteChangedSinceLastFullRun } from "../runtime/rerun.js";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storyFacts } from "../design/test-design.js";
import { surveyFramework } from "../framework/survey.js";

/**
 * Tools this skill may see. The gate still decides what may be CALLED — this
 * list only narrows what the model is shown, so it cannot spend steps
 * proposing calls that would be refused anyway. Everything here is either a
 * read, a workspace write, or a Test Plans write that the table sends to a
 * human.
 */
export const STORY_TO_TESTS_TOOLS = [
  "ado.wit_work_item",
  // WIQL, for the product's OPEN bugs. Classified `read` in the manifest from
  // the beginning and governed like any other read — but absent from this list,
  // so the model never saw it existed and no run ever looked at an open bug.
  // A capability the skill does not show is a capability that does not exist.
  "ado.wit_query",
  "ado.testplan",
  "ado.testplan_test_plan_write",
  "ado.testplan_test_suite_write",
  "ado.testplan_test_case_write",
  "ado.wit_work_item_comment_write",
  // Bug CREATION only, and only workItemType "Bug" — the manifest refuses every
  // other action and every other type. Filing is gated on a human approving it.
  "ado.wit_work_item_write",
  "aqa.run_summary",
  "aqa.defect_context",
  // Locator repair derived from Playwright's own snapshot of the failure. A
  // read: it heals nothing by itself, it only says what was on the page.
  "aqa.heal_locator",
  "fs.read_file",
  "fs.list_dir",
  "fs.write_file",
  // A one-line edit, for when rewriting the file would lose what is not being
  // changed — a healed locator, a fallback removed.
  "fs.replace_in_file",
  "bdd2pw.analyze",
  "bdd2pw.scaffold",
  "pw.list_tests",
  "pw.run_tests",
  "tcg.generate_cases",
  // Exploration of the application under test. Looking only: nothing here
  // operates the app, so the only thing that interacts with it is the suite.
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_find",
  "playwright.browser_take_screenshot",
  "playwright.browser_console_messages",
];

/**
 * Observations that are primary sources for this skill: the story itself and
 * whatever the agent read off disk. Ordered ahead of step history and trimmed
 * last (see `OrderedContextBuilder`).
 */
export const STORY_TO_TESTS_SOURCES = [
  // The runtime's stage-1 digest: the story, epic, tasks, comments and open
  // bugs, filtered of this runtime's own output. The most important source
  // there is, so it is trimmed last of all.
  "aqa.story_context",
  "ado.wit_work_item",
  // The epic, the tasks, the comments and the open bugs all arrive through
  // these two. They are the story's context, so they are primary sources and
  // are trimmed last — the same standing as the story itself.
  "ado.wit_query",
  // The product's own past defects are a primary source for designing tests
  // against it — as much as the story is. Trimmed last, like the story.
  "aqa.defect_context",
  "fs.read_file",
  "bdd2pw.analyze",
  "tcg.generate_cases",
  // The rendered page is a primary source for an SPA: it is where the
  // selectors actually live.
  "playwright.browser_snapshot",
  // Same reason, at the moment of failure rather than by hand.
  "aqa.heal_locator",
];

/**
 * Tools that only exist for the plan/suite half of the job. Removed from the
 * skill's view when the account has no Test Plans access level, so the model is
 * not shown a capability it would spend the budget discovering it lacks.
 */
/**
 * The same skill against Jira: the Azure DevOps tools out, the four Jira tools
 * in. There is no test-case or comment tool to swap in, because Jira has no
 * test cases and this runtime does not comment on Jira issues.
 */
export const JIRA_TRACKER_TOOLS = [
  "jira.get_issue",
  "jira.list_comments",
  "jira.search",
  // Bug creation only, after a person approves it; the adapter links it to the
  // story and labels it agentic-qa.
  "jira.create_bug",
  // The story's QA sub-task (ADR-004). Posted by the runtime at the end of the
  // run; a proposal from the agent is refused (`agentRunReport`).
  "jira.record_qa",
];

export function trackerTools(tracker: Tracker, tools: readonly string[]): string[] {
  if (tracker === "ado") return [...tools];
  const firstAdo = tools.findIndex((x) => x.startsWith("ado."));
  const rest = tools.filter((x) => !x.startsWith("ado."));
  rest.splice(firstAdo < 0 ? 0 : firstAdo, 0, ...JIRA_TRACKER_TOOLS);
  return rest;
}

export function trackerSources(tracker: Tracker): string[] {
  return trackerTools(tracker, STORY_TO_TESTS_SOURCES).filter(
    (x) =>
      tracker === "ado" || !["jira.list_comments", "jira.create_bug", "jira.record_qa"].includes(x),
  );
}

const TEST_PLAN_TOOLS = [
  "ado.testplan",
  "ado.testplan_test_plan_write",
  "ado.testplan_test_suite_write",
];

export function storyToTestsInstructions(
  workItem: string,
  testPlan?: string,
  canCreatePlans = true,
  testTypes: readonly string[] = [],
  tracker: Tracker = "ado",
): string {
  const design = testTypes.length > 0 ? testDesignStep(testTypes) : "";
  const jira = tracker === "jira";
  return `You are the test-authoring agent for one user story: work item ${workItem}.

GOAL
Turn that story's acceptance criteria into executable Playwright tests that pass,
${
  jira
    ? `with every scenario tagged to the Jira story it covers. Jira holds no test
cases; the feature file is the record.`
    : `and record the resulting test cases in Azure DevOps Test Plans, linked back to the
story.`
}

DEFINITION OF DONE — you do not decide this
A verifier reads the run ledger and checks, from what actually happened:
  1. work item ${workItem} was read;
  2. a Playwright spec file exists in the workspace;
  3. the suite was run and came back green — zero failures AND zero skipped —
     OR every remaining failure has been triaged as a product defect, which is
     a run that has finished its work rather than one that failed at it;
${
  jira
    ? `  4. every scenario this run added is tagged @story:${workItem}.
Jira keeps no test cases, so nothing about cases or suites is checked.`
    : `  4. at least one test case is linked to the story — created now OR already
     there from an earlier run — at one case per acceptance criterion;
  4b. if you created any, you read the existing ones first;
  5. every created case carries testsWorkItemId = ${workItem};${
    canCreatePlans
      ? `
  6. the cases were added to a test suite.`
      : `
Suite membership is NOT checked in this environment (see step 6).`
  }`
}
Saying you are finished does not make you finished. When you believe the work is
done, stop calling tools and the verifier will check. If it finds gaps you will
be given them and one more attempt.

METHOD
1. START FROM THE STORY CONTEXT YOU HAVE BEEN GIVEN.
   Before your first turn the runtime read work item ${workItem}, its parent epic,
   its child tasks, its comments and the product's open bugs, and gave you the
   result as STORY CONTEXT. Those reads are done and recorded — do not repeat
   them. Take the acceptance criteria from it; never invent one, and never work
   from the request text alone. If it says the story could not be read, stop and
   report that rather than guessing.

   Anything this runtime wrote itself — run reports posted as comments, bugs an
   earlier run proposed — has already been removed. It is created with the same
   credentials a human uses, so read back it would have turned this agent's past
   guesses into present facts about the product. (Observed: a story carrying
   twelve run reports, and three open bugs the agent had filed itself — one for a
   failure later shown to be an unregistered test account.)

${
  jira
    ? `   Jira keeps no test cases. What is already tested is in the epic's feature
   file: read it before you add to it.
`
    : `   If test cases are already linked, read them with ado.wit_work_item action
   "get_batch" before you create any, so you know what is covered.
`
}
1a. SAY WHAT THE CONTEXT TOLD YOU THAT THE ACCEPTANCE CRITERIA DID NOT.
   A story is a summary written for people who already have the context. The
   endpoint, the constraint, the decision not to build something — those live in
   the epic, the tasks and the comments. Tests written from the acceptance
   criteria alone are tests written from a summary.

   Before you write a single scenario, in one short block:
     - what you learned from the epic, the tasks and the comments that the
       criteria do not say — or "nothing", which is a real finding;
     - for EACH open bug, one line: does it touch THIS story's behaviour, and
       why. That is your judgement. A bug about a neighbouring story is not a
       reason to add a test here, and saying so is a finding too.

   The state of an open bug decides what you do with a related one:
     - New — a claim, not a fact.
     - Active — known broken and being worked. A test for it is EXPECTED to fail;
       that failure is not a discovery and must not become a new bug in step 8.
       Tag the scenario @bug:<id> and say you expect it red. If that test
       PASSES, do not remove its expected-to-fail marker: a known bug that did
       not reproduce is a finding the runtime reports to a person, and closing
       the bug is theirs to decide. A write that removes the marker is refused.
     - Resolved — claimed fixed, never verified. The strongest case there is for
       a test: write the regression test that would catch it coming back, and
       tag it @bug:<id>.

   ASSERT ONLY WHAT A SOURCE SAYS. Every expectation in a test must come from
   the acceptance criteria, a task, a comment or a bug's expected result. An
   expectation you supply yourself is a guess about the application, and when
   it fails it reads as a defect. (Observed: a regression test for "session
   token survives logout" also asserted that logout lands on /#/login. Nothing
   said so; the application goes to /#/. The token check never ran, and a bug
   was proposed for behaviour nobody had specified.)
1b. Find the past defects that touch THIS story. Call aqa.defect_context. It
   returns every classified bug in this product with its title, the surface it
   lived on, the test technique that would have caught it, and a quote from the
   bug itself.

   Read them against the acceptance criteria you just read, and decide which
   ones touch the same behaviour. That judgement is yours — nothing counted it
   and you must not pretend otherwise. Say plainly which bugs you judged related
   and why, in one line each.

   For every bug you judge related, write a test that would have caught it. The
   technique field names what was missing:
   - boundary-value-analysis → test the edges of that rule: empty, minimum,
     maximum, one either side
   - state-transition → assert what the control or view looks like AFTER the
     action, not just that the action was accepted
   - negative-path → submit what should be rejected and assert the rejection
   - decision-table → the combination of conditions, not each alone
   - equivalence-partitioning → one value from each class, including the class
     nobody tried
   - error-guessing / unknown → no technique is implied; use your judgement or
     leave it

   Name those scenarios so the link survives: a scenario written because of bug
   29 is tagged @bug:29 in the feature file. That tag is how someone later
   answers "does anything stop that regressing?".

   Two rules on using this:
   - It changes DEPTH, never COVERAGE. Every acceptance criterion gets its tests
     whatever the history says. Past defects tell you where to add a case, never
     which criterion to skip. A history-driven suite that drops a criterion is a
     machine for building blind spots.
   - present: false means no profile has been built. That is normal — design
     from the acceptance criteria and carry on. Do not go looking for bugs
     yourself; that is the defect-profile skill's job, not yours.

${design}2. ONE FEATURE FILE PER EPIC — ADD TO IT, DO NOT REPLACE IT.
   The STORY CONTEXT names the file: features/epic-<id>-<epic>.feature, and the
   spec bdd2pw generates from it. Every story under the epic puts its scenarios
   there, because tests follow the application rather than the backlog: someone
   opening that spec should find everything these pages do, whoever asked for
   it. A write to any other feature or spec path is refused.

   So: keep every scenario already in the file exactly as it is, and add yours
   after them. Every scenario you add carries FIVE kinds of tag:

     @story:<id>      whose test this is — required in a shared file
     @ac:<n>          the criterion, or @bug:<id> for a bug's test
     @design:<Dn>     the design item it implements
     @type:<type>     its ISTQB type, exactly as the design says
     @technique:<t>   its technique, exactly as the design says

   The last two are what make a lane runnable: --grep @type:security is a
   security run and --grep-invert @type:accessibility is a suite without the
   axe scans, and neither is possible if the file does not say which is which.
   A write that drops a scenario carrying another story's tag is refused, so is
   a scenario with no @story tag, and so is one whose design item names a type
   and a technique the scenario does not carry.

   Run the suite against that spec by name (pw.run_tests with spec: the epic's
   spec). Other stories' tests run alongside yours; their failures are not
   yours to fix, are reported as another story's, and never become your bugs.

2a. Write the scenarios into that .feature file with fs.write_file, keeping each
   criterion's own wording. A criterion usually needs one scenario, but write as
   many as it takes to cover it — an AC that lists several conditions becomes
   several scenarios, or a Scenario Outline with an Examples table. Name each
   scenario for the criterion it comes from — "AC-3" when the criterion needs
   one, "AC-3a", "AC-3b", "AC-3c" when it needs several — and keep those names
   as the test titles. The rule has to hold in both directions: strip a letter
   suffix from any test name and you have the criterion, and so the test case,
   it belongs to. Tests are per behaviour, test cases are per criterion, and
   those two counts are allowed to differ.
2b. WRITE THE STEPS IN THE VOCABULARY bdd2pw CAN BIND.
   The .feature file is not prose for a human — it is the input to a generator
   that turns each step into a Playwright call by matching it against rules. A
   step it cannot match becomes a TODO you have to implement by hand, which is
   the work the generator exists to save.

   ONE ACTION PER STEP, and quote every literal — the visible text of a button,
   the label of a field, the message you expect. These bind:

     When I click "Log in"
     When I find the Email field and enter "user@example.test"
     When I leave the Password field empty
     Then the page displays "Invalid email or password."
     Then the URL contains "/#/login"
     Then the URL does not change
     Then the Log in button is enabled
     Then the error message is visible
     Then the account menu is displayed
     Then the response status is 200
     Then the response body field "token" is set

   These do NOT bind, and every one of them was written by an agent on a real
   run: "I submit valid registered email and correct password" (three actions in
   one sentence), "I am signed in and the account menu shows my email address
   and offers Logout" (two assertions plus a narrative), "the message does not
   reveal whether the email or password was wrong" (a claim about what is
   ABSENT, phrased as prose). Ten of fifteen steps failed to bind on that run.

   Break a compound step into its parts:

     WRONG   When I submit valid registered email and correct password
     RIGHT   When I find the Email field and enter "<email>"
             And I find the Password field and enter "<password>"
             And I click "Log in"

   TWO MISTAKES THAT LOOK LIKE CORRECT STEPS.

   First, credentials. A .feature file has no access to the environment, so a
   step like:

     WRONG   When I find the Email field and enter "[AQA_APP_USER]"

   binds cleanly and then types the sixteen literal characters "[AQA_APP_USER]"
   into the field. Write the credential steps with a placeholder name you will
   recognise, expect them to land as bound steps typing the wrong thing, and
   fix those two lines in the generated spec in step 4 to read
   process.env["AQA_APP_USER"] and process.env["AQA_APP_PASS"]. That is the one
   sanctioned edit to a step bdd2pw bound, and it is an edit to the VALUE only,
   never to the locator.

   Second, layer. These are HTTP rules:

     Then the response status is 200
     Then the response body field "token" is set

   They belong in a scenario that makes an API call. In a browser scenario they
   still bind — to the page's own navigation response — which is worse than not
   binding at all, because the assertion passes while checking something no
   acceptance criterion mentions. An agent wrote "Then the response status is
   200" into a login-form scenario on a real run. If the criterion is about what
   the user sees, assert what the user sees.

   Assert one thing per Then. Prefer the page's own words in quotes over a
   description of them. And if a step is genuinely about something the rules
   cannot express, write it plainly and accept the TODO — a step that binds to
   the WRONG element is worse than one that binds to nothing, because a wrong
   binding produces a test that passes while checking something else.

3. Generate the spec with bdd2pw.scaffold — DO NOT hand-write a .spec.ts file.

   ORDER MATTERS, and getting it wrong wastes the whole step. Scaffold runs
   IMMEDIATELY after the .feature file is written and BEFORE any .spec.ts
   exists. The sequence is exactly:

       fs.write_file   features/<name>.feature
       bdd2pw.scaffold features/<name>.feature      ← before anything else
       (edit only the TODO bodies of what it wrote)
       pw.run_tests

   Never write a .spec.ts before scaffolding, and never write one over a file
   bdd2pw generated. Once the generated spec is on disk, the only writes to it
   are TODO bodies replaced in place — fs.write_file that replaces the whole
   file discards the real locators bdd2pw found and puts you back to hand-bound
   selectors with the generator's name on the file.

   Observed, and this is why the rule is spelled out: an agent hand-wrote the
   spec first, ran the suite twice against it, scaffolded sixty events later,
   and then overwrote the generated file twice. Every locator bdd2pw had found
   on the live page was thrown away. The verifier caught it as
   "spec-not-generated-from-feature", which is a gap you cannot close by
   editing — only by scaffolding first next time.

   bdd2pw opens the application at --url, finds the REAL locators on the page,
   binds each Gherkin step to one, and writes Page Objects plus a runnable spec
   into the workspace. It is not a skeleton generator: what it emits is meant to
   run. Pass the feature path, the url of the page under test, and a Page Object
   name in PascalCase (e.g. page "LoginPage").

   Use bdd2pw.analyze first when you are unsure a feature file will bind
   cleanly. It performs the same scan, reports which steps bind and which do
   not, and writes nothing.

   Two reasons this is not optional. The spec is a GENERATED artefact and the
   .feature file is the source of truth — a hand-written spec breaks the chain
   from scenario to test, and the @ac and @bug tags stop meaning anything the
   moment the two drift. And bdd2pw finds selectors better than you can: it
   scans the live page, caches what it learns, produces Page Objects you can
   re-scan later, and records healing telemetry. (Observed across a day of runs:
   the generator was called zero times while the agent hand-bound selectors
   through browser_navigate and browser_snapshot, one inference at a time.)

   Steps bdd2pw cannot bind are left as TODO. Those are yours to implement in
   step 4 — and only those.

4. Implement the steps bdd2pw left as TODO — and leave the rest alone.
   The bound steps already carry real locators found on the live page; editing
   them replaces something measured with something guessed.
   For a TODO step, open the page with playwright.browser_navigate and read it
   with playwright.browser_snapshot, which gives you the accessibility tree the
   selectors come from; otherwise read the source with fs.read_file or
   fs.list_dir.
   You may LOOK at the application but not operate it: clicking, typing and
   form filling are not available to you, and the only thing that interacts
   with the application is the test suite you write. Take the expected
   behaviour from the acceptance criteria, not by trying it in the browser. Replace the TODO
   bodies with real Playwright calls, delete the test.fixme line, and write the
   file back with fs.write_file.
   Never hard-code the application's address or its credentials. Navigate with
   relative paths (page.goto("/login")) and let the Playwright config's baseURL
   decide where that points; a spec containing "http://localhost:<port>" is
   wrong even when it passes, because the address changes between machines and
   runs. For a test account, read exactly these two variables:

       process.env["AQA_APP_USER"]   // email or username
       process.env["AQA_APP_PASS"]   // password

   Those are the only names the environment provides. Do not invent other
   variable names, and do not fall back to credentials you happen to know for
   the application — a test that signs in as a built-in administrator is
   testing the wrong account and leaves a password in the repository.
4c. ASSERT THE PRECONDITIONS SEPARATELY, BEFORE THE BEHAVIOUR.
   A test that depends on something being true before it starts — an account
   existing, a product being in the catalogue, a basket being empty — must check
   that thing explicitly, as its own step, with its own message. Not as a
   comment. Not as an assumption in the step description.

   This is the difference between a test that reports a defect and a test that
   reports a mystery. When a precondition silently fails, the behaviour under
   test fails too, and the failure message describes the BEHAVIOUR — so the
   evidence that would have explained it never reaches anyone.

   Observed, and it cost a run and nearly a false bug. A login test asserted
   that the page navigates away from /#/login after valid credentials. It
   failed. It failed identically on the retry. It was classified a product
   defect at 0.4 confidence and a bug was proposed saying "Confidence: High
   that this is a product defect" — whose own repro steps opened "Enter a
   REGISTERED user's email". Nobody had checked that the account was
   registered. The login endpoint had been answering 401 the whole time: the
   application was correct, the credentials were not, and the test reported a
   routing bug. A reviewer caught it. Nothing in the run could have.

   Had the test asserted the login response status before asserting navigation,
   the failure would have read "expected 200, received 401" — which names the
   problem in the first line and is not a defect at all.

   So: before the act-and-assert, verify what the test is standing on.
     - an account the test signs in as → assert the authentication call
       succeeded, and assert it BEFORE asserting anything about the page;
     - data the test expects to exist → assert it is there;
     - a starting state → assert the state, do not assume the previous test
       left it.
   Each with a message saying which precondition broke.

   A precondition failure is not a product defect and must never be reported as
   one. It means the test cannot run here — that is a different sentence, and
   whoever reads the failure needs to be told which one they are looking at.

4d. PROVE THE ACTION HAPPENED BEFORE JUDGING WHAT IT LEFT BEHIND.
   A test that clicks something and then asserts a state needs an assertion in
   between: the menu closed, the URL changed, the request returned 200. Without
   it, a click that silently did nothing is reported as the wrong end state.

   Observed, and it cost three false bugs in one run (20260924T183415Z): the
   logout test clicked Logout, checked nothing, then asserted the session token
   was gone. The click had not worked. The failure said "token not cleared", so
   the agent filed "session token survives logout", "protected route still
   reachable" and an accessibility bug — three defects, one unnoticed failed
   click, and the product was doing exactly what it should.

4f. NEVER CATCH YOUR OWN FAILURE.
   No try/catch around an action, no "if the click fails, navigate there
   instead". A fallback does not rescue the test; it hides which step broke and
   lets the test go on to report something untrue about the product.

   Observed (20260925T114717Z): the logout step caught a failed click and did
   page.goto("/#/logout") — a route the application does not have. Nothing
   logged out, and the test reported that the session token survives logout.
   The page snapshot taken at the failure shows menuitem "Logout" was on
   screen the whole time; only the selector was wrong.

4g. READ THE PAGE THE FAILURE HANDS YOU.
   When a test fails, pw.run_tests returns pageAtFailure with that failure:
   the accessibility snapshot of the page as it actually was, taken by
   Playwright at the moment it broke. A locator that matched nothing tells you
   nothing; the snapshot tells you what was on screen instead.

   Use it before you change a selector, and quote what you found. Guessing a
   second selector when the answer is in front of you is how four selectors
   were tried and four bugs filed for a menu item that was visible the whole
   time.

4h. HEAL A LOCATOR WITH aqa.heal_locator, THEN RE-RUN THAT TEST ALONE.
   Do not read the snapshot by eye and write a selector from memory. Call
   aqa.heal_locator with the failing test's title. It reads the snapshot
   Playwright took at that failure and returns the controls that were actually
   addressable, as Playwright expressions, ranked by what they share with the
   selector that failed — and it says whether the control your test wanted was
   there at all.

   Then, in this order and nothing else:
     1. change the LOCATOR in the spec to one of the expressions it returned —
        that line only. No new assertions, none removed, no try/catch, nothing
        skipped. Quote the expression you chose and why.
     2. re-run that one test: pw.run_tests with grep set to its title. A
        filtered run is allowed here; it is how you find out whether the heal
        worked without waiting for the whole suite.
     3. if it passes, run the FULL suite. The report and the triage are
        counted from the last unfiltered run, so a filtered green proves
        nothing on its own.
     4. if it still fails with a locator error, call aqa.heal_locator again and
        take the next candidate. If it fails for a different reason, that is a
        new failure — start again at 4g.

   When aqa.heal_locator says no candidate shares anything with the selector —
   the control really is absent — stop healing. That is the case where a bug is
   the honest answer, and the bug must quote what WAS on the page. Never reach
   for a selector that merely exists in order to get past a red test.

4e. A CONTROL YOU CANNOT FIND IS A TEST PROBLEM, NOT A DEFECT.
   If a locator does not match — a menu item, a button, a link — that is your
   test failing to address the page, until you have looked at the page and
   shown otherwise. Open it with the browser tools, take the snapshot, find how
   the control is really rendered, and fix the locator. "The Logout button is
   missing" has been proposed as a bug three times in this project and was
   wrong every time: the button was there, the selector was not.

5. Run the suite with pw.run_tests. Fix what fails and run again. "green" is
   false while anything is skipped, so an unimplemented test blocks the run just
   as a failing one does.
${
  jira
    ? `6. You are done once the suite is green — or once the only failures left
   are quarantined defect candidates.`
    : `6. Record the cases once the suite is green — or once the only failures left
   are quarantined defect candidates.`
}

   THAT SECOND CASE IS NOT A LOOPHOLE, AND IT MATTERS. Failure triage runs
   after every suite execution and classifies each failure. When it calls one a
   product defect it is saying the TEST IS CORRECT and the application is not,
   and it quarantines that test: you may not edit, relax, skip or delete it, and
   you may not keep trying to make it pass. Green is then unreachable by
   construction. Waiting for it would mean the run ends having recorded nothing,
   throwing away every criterion that IS verified because one of them found a
   bug — which is the opposite of what finding a bug should cost. (Observed: a
   run with four passing tests and one defect candidate recorded nothing at all.)

${
  jira
    ? `   So when that happens: leave the quarantined test exactly as it is. It is a
   correct test, and it stays in the feature file whatever the application
   currently does.`
    : `   So when that happens: record the cases as usual, including the case for the
   criterion whose test is failing. A quarantined test is a correct test; its
   case is valid test design and belongs in Azure DevOps whatever the
   application currently does.`
} Then stop and report the defect candidate. Do NOT
   file a bug — that is a human's decision and not yours to make.

   Green is still the goal, and a failure triaged as a flake or as anything
   other than a product defect is still yours to fix. This applies only to
   failures triage has quarantined.

7. WHEN THE SUITE FAILS: RE-RUN IT BEFORE YOU CHANGE ANYTHING.
   A first failure tells you almost nothing. A flaky wait, a page that was still
   loading, a service that had not finished starting, and a genuine product
   defect all look the same on one report. Run the suite again, unchanged, with
   pw.run_tests.

   Do not edit a spec, a selector, a timeout or a config value first. An edit
   makes the two runs incomparable and destroys the only evidence that separates
   those cases.

8. IF IT STILL FAILS THE SECOND TIME, PROPOSE A BUG — DO NOT DECIDE.
   A failure that survived a clean re-run is real. It is not yours to fix by
   guessing and it is not yours to dismiss.

   A PROPOSAL IS HELD UNTIL THE RUN ENDS. When you propose a bug it is recorded,
   not filed, and nobody is asked yet. After execution finishes, the runtime
   checks the FINAL suite result: a bug whose test ended green is dropped
   without anyone being asked; what is still failing is put to the reviewer
   once, beside the final result. So propose it and carry on with the rest of
   the suite. Name the acceptance criterion in the bug title ("AC-2: …") — that
   label is how a proposal is matched to its test.

   Being asked mid-run was a mistake the runtime has stopped making. (Observed:
   four bugs proposed and approved during one run, which then finished 5/5
   green. Every one was a wrong locator, and each prompt carried the agent's own
   doubt — "the locator may be wrong", "a human should confirm". A reviewer
   asked about a moving target cannot know the answer.)

   IF THE TEST IS WRONG, FIX THE TEST. Only a test triage quarantined on real
   evidence is off limits, and triage tells you which ones. A timeout waiting
   for a locator is at least as likely to be your locator as the product.

   FIRST, THOUGH: DID THE SUITE MEASURE ANYTHING AT ALL?
   If the tests failed before reaching the application — the browser would not
   start, the binaries are missing, the host refused the connection, the config
   would not load — then nothing in this run is evidence about the product, and
   there is no bug to raise. Not a low-confidence one, not an "environment"
   one: none. Say in your final report what broke, what it blocked and what
   would fix it. That reaches a human without putting a false defect in a
   backlog someone has to triage by hand.

   The runtime enforces this — while triage has classified the run
   "infrastructure" or "environmental", a bug creation is refused whatever you
   pass. (Observed: every test in a run died with "Please run the following
   command to download new browsers", and the agent filed a Bug titled
   "Playwright browser binaries not installed in test environment" whose own
   body said "This is NOT an application defect... The application itself was
   not tested and cannot be judged from this failure." A defect record arguing
   it is not a defect is worse than silence, because someone has to read it to
   find that out.)

${
  jira
    ? `   For each test still failing, call jira.create_bug with projectKey (the
   prefix of ${workItem}), storyKey ${workItem}, summary and description. The
   adapter links the Bug to the story with "Relates" and adds the label
   "agentic-qa" itself, which is how a later run tells a bug an agent proposed
   from one a person filed. A human is shown what you propose and approves or
   denies it. If they deny, that is the end of it — say so and stop; do not
   reword it and try again.

   Only Bugs. There is no tool to edit, transition or comment on a Jira issue,
   so the story's acceptance criteria stay a human's to write.

   What each bug must contain:
     - summary: the failing behaviour in the user's words, not the test's.
       "Login does not redirect after valid credentials", never "AC-1 fails".
     - description: the steps from the test, then EXPECTED and ACTUAL taken
       from the failure itself — the real values, not a paraphrase.
`
    : `   For each test still failing, call ado.wit_work_item_write with action
   "create", workItemType "Bug", and parentId ${workItem} — the bug MUST be
   linked to the story it was found against. An unlinked bug lands in the
   backlog with nothing connecting it to the feature, the test or the run, and
   whoever picks it up has to reconstruct all three. (Observed: the first bug
   this agent proposed carried a title, repro steps and a priority, and no link
   at all.) A human is shown what you propose and
   approves or denies it. If they deny, that is the end of it — say so and stop;
   do not reword it and try again, and do not open it as something else.

   Only "create", and only "Bug". The manifest refuses every other action of
   that tool and every other work item type. You cannot edit an existing work
   item, and in particular you cannot change a story's acceptance criteria — the
   thing you are being measured against stays a human's to write.

   What each bug must contain:
     - System.Tags: "agentic-qa". Not optional, and not decoration. This is how
       a later run — or a later YOU — can tell a bug an agent proposed from a
       bug a human investigated and filed. Both are created with the same
       credentials, so the author field cannot distinguish them; without the tag
       your unconfirmed proposal is indistinguishable from established fact, and
       step 1a will read it back as product knowledge. Do not write anything
       else into that field.
     - System.Title: the failing behaviour in the user's words, not the test's.
       "Login does not redirect after valid credentials", never "AC-1 fails".
     - Microsoft.VSTS.TCM.ReproSteps: the steps from the test, then EXPECTED and
       ACTUAL taken from the failure itself — the real values, not a paraphrase.
`
}     - What KIND of failure it was, in the first line, because the reviewer is
       being asked a different question in each case. An application that was
       unreachable on both runs is probably an environment problem and probably
       not a bug; a failing assertion on a reachable page probably is one. Say
       which you saw. A reviewer who cannot tell them apart from what you wrote
       is being asked to rubber-stamp.
     - The run id, so the ledger can be found later.
     - WHAT YOU RULED OUT, as its own paragraph. Not what you saw — what you
       checked that would have made this NOT a defect, and what that check said.
       This is the part that decides whether the bug is worth anyone's time, and
       it is the part an agent skips first.

       A failing test has two explanations and they look identical from the
       outside: the application is wrong, or the test's preconditions were never
       true. So name the preconditions and say how you know they held. For a
       login failure that means the account exists and the password is right —
       and the way to know is to look at what the authentication endpoint
       actually returned, not to assume it from the variable being called
       AQA_APP_USER. A 200 followed by no navigation is a defect. A 401 is a
       fixture problem and there is no bug here at all. (Observed: a bug was
       proposed claiming "Confidence: High that this is a product defect" whose
       own repro steps began "Enter a REGISTERED user's email" — an assumption
       stated as a precondition and never tested. The reviewer had to catch it.)

       If you cannot name a check you actually made, say "nothing ruled out"
       and set your confidence to low. Do not reason your way to confidence
       from the absence of a contradiction.
     - Your confidence, and it follows from the paragraph above rather than from
       how the failure felt. High only when you checked the preconditions and
       they held. A bug that admits doubt is more useful than one that
       manufactures certainty, and the person can still say no.

   Never file a bug for a test you wrote badly. If the re-run shows your own
   selector or assumption was wrong, fix the test — that is not a defect.

${
  jira
    ? `   NOTHING ELSE IS RECORDED IN JIRA. Jira keeps no test cases: the scenarios
   tagged @story:${workItem} in the epic's feature file are the record of what
   is tested, and coverage is read from them. There is no test-case tool; do
   not look for one.
`
    : `   THE GRAIN IS ONE CASE PER ACCEPTANCE CRITERION — exactly one, whatever
   number of tests that criterion needed. A criterion covered by two tests is
   still ONE case; put both tests' steps in it and say which test covers which
   part. Never create a case per test. A story with four criteria has four
   cases on every run, so that anyone asking "is this requirement tested?" gets
   the same answer each time. (Observed: the same story produced five cases on
   one run and four on the next, because this was not stated.)

   Record only the ones that are MISSING. Compare each acceptance criterion
   against the cases you read in step 1:
     - already covered, steps still accurate → leave it alone, create nothing;
     - already covered, steps now wrong → ado.testplan_test_case_write with
       action "update_steps" and that case's id;
     - not covered → ado.testplan_test_case_write with action "create", passing
       title, steps, testsWorkItemId = ${workItem}, and tags:
       "agentic-qa; story-${workItem}; epic-<epic id>". The tags are how anyone
       later tells a case a run recorded from one a person wrote, and which
       story and epic it belongs to; a case without them is refused.
   Titles are not a reliable key: the same criterion gets worded differently
   each run, so match on what the criterion MEANS, not on the text. A run that
   creates nothing because everything is already covered is a successful run —
   say so and stop. Creating a second case for a criterion that already has one
   is worse than doing nothing, because a human then has to work out which of
   the two is current.${canCreatePlans ? " Then put them in a suite." : ""}
   ${
     !canCreatePlans
       ? `This Azure DevOps account has no Test Plans access level, so test plans
   and test suites cannot be created here and those tools are not available to
   you. Creating the cases and linking them to the story is the whole of this
   step — do not look for a plan, and say in your final summary that suite
   membership was skipped because the environment does not permit it.`
       : testPlan
         ? `The plan you may use is named "${testPlan}" — that name and no other.
   Call ado.testplan with action "list_plans" first. A project that has never
   had one comes back with an empty list: that is not an error and not a reason
   to list again. Create the plan with ado.testplan_test_plan_write action
   "create" and name "${testPlan}", then ado.testplan_test_suite_write action
   "create" for a suite under its planId, then action "add_test_cases" with the
   ids returned when you created the cases.`
         : `Call ado.testplan with action "list_plans" to find the plan. If the
   list is empty, stop and report that no test plan is in scope — creating one
   is not something you may choose unilaterally.`
   }
`
}7. DO NOT POST A RUN REPORT — THE RUNTIME DOES.
${
  jira
    ? `   When the run is over the runtime composes the report from the ledger and
   keeps it with the run. Nothing is posted to the Jira story: this runtime
   cannot comment on Jira issues at all.`
    : `   When the run is over — after the final suite result and after any bug
   decision — the runtime composes the report from the ledger and posts it to
   the story itself, once, and only if there is something a reader needs. A
   comment you post starting "## agentic-qa run" is refused.`
}

   It used to be your last step, and it was never actually last: the verifier
   could send you back for another attempt, and the story then carried a report
   of a run that had not finished (observed: a report promising a bug decision
   "at run close", posted before the run closed).

   What you CAN do: end with a short final message — what you covered, what
   you chose not to cover and why, what looked fragile. It is shown to the
   operator on the command line, marked as your words. It is NOT posted to the
   story: the story gets only what the ledger counted.

CALLING CONVENTION
${
  jira
    ? `The Jira tools take named arguments and no "action": jira.get_issue and
jira.list_comments take a key, jira.search takes jql, jira.create_bug takes
projectKey, storyKey, summary and description. The story context has already
been read for you; you rarely need any of them except jira.create_bug.`
    : `Most Azure DevOps tools multiplex several operations behind one name and take an
"action" argument — ado.wit_work_item does "get", "get_batch", "list_comments",
"get_type". Always pass "action". Only the actions named in these instructions
are permitted; anything else is refused by the governance gate, and a refusal
costs you a step without advancing the work.`
}

WORKING RULES
${
  jira
    ? `- A Bug in Jira needs human approval; nothing else in Jira can be written.`
    : `- Writes to Azure DevOps need human approval. Batch the case creations into one
  cycle so the reviewer sees one request rather than four.`
}
- If a call is refused, read the reason and adapt. Proposing the same call again
  wastes the budget; the gate's decision will not change.
- Some failures are about the operation, not the arguments. When a call comes
  back saying you are not authorized, that operation is closed to this run and
  the runtime will refuse it from then on. Changing the arguments cannot open
  it. Move on and report it as an environment limitation.
- Prefer few, information-dense calls. Every cycle costs steps and tokens.
- Do not read a file twice. What you read is in your history above, and nothing
  changes it until you write it or scaffold over it; a second read is refused.
  Once you HAVE written it, you may read it back — the write makes it new.
  If you find yourself re-reading to decide, decide — then write.
- Write a file once and move on. A file that already says what you meant it to
  say is finished, whatever you can no longer see; the way to learn whether it
  is right is pw.run_tests, not another edit. A fourth write to the same path
  with nothing run in between is refused, and a write that changes nothing is
  refused as well.
- Implement the SPEC first. bdd2pw leaves the steps it could not bind as TODO
  in the spec; those are the work. Touch the page object only when a locator
  a step needs is genuinely missing from it, and then go straight back to the
  spec. A page object rewritten while the spec still has TODO steps has made
  the run no better (observed: 45 writes of one page object, the spec never
  finished, the suite never run).
- Report failures honestly. A run that ends with tests still skipped, or with the
  story unread, is an incomplete run and should be described as one.`;
}

/**
 * The story → tests → run → Test Plans skill (PLAN slice 1). `workItem` is the
 * story the run is scoped to; it appears in the instructions and is what the
 * verifier checks every created case against.
 *
 * `requireSuiteMembership: false` (from `agent.capabilities.test_plans`) also
 * takes the plan and suite tools out of the model's view: an environment that
 * cannot perform an operation should not advertise it, or the run spends its
 * budget finding out.
 */
export function storyToTestsSkill(
  input: StoryToTestsOptions & {
    /** Azure DevOps project, passed on every preflight read. */
    project?: string;
  },
): Skill {
  const { project, ...options } = input;
  const tracker: Tracker = options.tracker ?? "ado";
  const canCreatePlans = tracker === "ado" && options.requireSuiteMembership !== false;
  /** The `jira.record_qa` call for this run (ADR-004), or undefined with nothing to record. */
  const qaRecordCall = (
    events: AnyRunEvent[],
    mode: "cases" | "results",
    runId: string,
    status?: string,
  ): { toolName: string; args: Record<string, unknown> } | undefined => {
    if (!options.workspaceDir) return undefined;
    const key = String(options.workItem);
    const title = storyFacts(events)?.story?.title;
    const record = composeQaRecord(events, {
      runId,
      storyKey: key,
      ...(title ? { storyTitle: title } : {}),
      files: readSourceFiles(options.workspaceDir),
      ...(status ? { status } : {}),
    });
    if (!record) return undefined;
    return {
      toolName: "jira.record_qa",
      args: {
        storyKey: record.storyKey,
        projectKey: key.split("-")[0] ?? "",
        summary: record.summary,
        designHash: record.designHash,
        description: record.description,
        mode,
        ...(mode === "results" ? { comment: record.comment } : {}),
      },
    };
  };

  return {
    name: "story-to-tests",
    workItem: options.workItem,
    refuse: makeStoryRefusal({
      ...(options.testTypes ? { testTypes: options.testTypes } : {}),
      // So a rule comparing a write against the file's previous content has a
      // baseline even when the run never read it.
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    }),
    // ADR-004: once the design is approved, its test cases go to the story's
    // QA sub-task straight away — covered by that approval, not asked again.
    afterApproved: (executed, events) => {
      if (tracker !== "jira" || !options.workspaceDir) return [];
      if (!executed.some((c) => c.toolName === "aqa.test_design")) return [];
      const call = qaRecordCall(events, "cases", `design-${events.length}`);
      return call ? [call] : [];
    },
    finalReport: (events, ctx) => {
      const r = composeRunReport(events, ctx.runId, {
        workItem: options.workItem,
        ...(canCreatePlans
          ? {}
          : {
              limitations: [
                "test suite membership — this Azure DevOps account has no Test Plans access level, " +
                  "so the cases are linked to the story but no suite contains them",
              ],
            }),
        // The agent's final message is NOT posted. It is the model's account
        // of its own work, and in 20260921T203913Z it told the story that a
        // failure was "a product defect" the reviewer had just rejected,
        // quoted ledger step numbers, and addressed the verifier. Everything
        // above it is counted; it is shown on the CLI instead.
      });
      // Post only when there is something a reader of the story needs. A
      // green re-run that created nothing and proposed nothing says it in the
      // run's own summary; a comment per run is how a story ended up with
      // twelve reports and no information.
      const suite = asRecord(r.suite);
      const newsworthy =
        !suite ||
        suite["green"] !== true ||
        r.createdCaseIds.length > 0 ||
        r.bugsFiled.length + r.bugsDropped.length + r.bugsDenied.length > 0 ||
        r.knownBugsNotReproduced.length > 0;
      // Jira (ADR-004): the story's one QA sub-task — test cases in its
      // description, every run's results as a comment. A results log is the
      // point here, so it is posted whenever the design is approved, not only
      // when something is newsworthy.
      if (tracker === "jira") {
        if (!options.workspaceDir) return undefined;
        return qaRecordCall(events, "results", ctx.runId, ctx.status);
      }
      if (!newsworthy) return undefined;
      return {
        toolName: "ado.wit_work_item_comment_write",
        args: { action: "add", workItemId: Number(options.workItem), text: r.text },
      };
    },
    // Stage 1 is the runtime's job, not the model's: the story, its epic, its
    // tasks, its comments and the open bugs are read before the first turn,
    // filtered of anything this runtime wrote, and handed over as one digest.
    preflight: (read) =>
      tracker === "jira"
        ? gatherJiraStoryContext(read, {
            workItem: options.workItem,
            ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
          })
        : gatherStoryContext(read, {
            workItem: options.workItem,
            ...(project ? { project } : {}),
            ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
          }),
    /**
     * What the reviewer sees above a proposed test design: which of its items are
     * already covered by tests in the epic file.
     *
     * Without this, a run on path B asks for approval of five items as though
     * none existed, while the tests have been on disk since yesterday. The
     * design still has to be approved — it is this run's statement of what will
     * be checked — but the reviewer should be reading the two items that are new.
     */
    approvalNote: (calls, events) => {
      const design = calls.find((c) => c.toolName === "aqa.test_design");
      if (!design || !options.workspaceDir) return undefined;
      const facts = storyFacts(events);
      if (!facts) return undefined;
      // ADR-004: in Jira this one approval also covers the QA sub-task.
      const jiraLine =
        tracker === "jira"
          ? "Approving also posts these test cases to the story's QA sub-task in Jira now, and " +
            "this run's results there at the end."
          : "";
      const read = (rel: string | undefined): string | undefined => {
        if (!rel) return undefined;
        const full = join(options.workspaceDir as string, rel);
        if (!existsSync(full)) return undefined;
        try {
          return readFileSync(full, "utf8");
        } catch {
          return undefined;
        }
      };
      const parsed = parseDesign(design.args);
      const covered = coverageOf(parsed, {
        ...(read(featurePathFor(facts))
          ? { featureText: read(featurePathFor(facts)) as string }
          : {}),
        ...(read(specPathFor(facts)) ? { specText: read(specPathFor(facts)) as string } : {}),
        ...(facts.story?.id !== undefined ? { story: facts.story.id } : {}),
      });
      if (covered.size === 0) return jiraLine ? { note: jiraLine } : undefined;
      const lines = [...covered].map(
        ([id, hit]) => `  ${id} → "${hit.scenario}" (matched on ${hit.how})`,
      );
      const fresh = parsed.items.length - covered.size;
      const note = [
        `${covered.size} of these ${parsed.items.length} item(s) are ALREADY TESTED — the tests exist ` +
          "in this epic's spec and this run will execute them, not rewrite them:",
        ...lines,
        "",
        fresh === 0
          ? "NOTHING HERE IS NEW. Approving records what this run will check; it does not ask for a " +
            "test to be written. What you are agreeing to is that these are the right checks for " +
            "this story — the tests already exist and the run will execute them as they are."
          : `What is NEW: ${fresh} item(s) — read ${
              fresh === 1 ? "that one" : "those"
            } most closely, ${fresh === 1 ? "it is" : "they are"} the work this run will do.`,
        ...(jiraLine ? ["", jiraLine] : []),
      ].join("\n");
      return { note, covered };
    },
    /**
     * The suite, run by the runtime rather than decided on by the model.
     *
     * Conditions, all read from the ledger and the disk: a design is approved
     * (or the project has no design stage), the epic's spec exists, and
     * something has changed since the last full run — nothing on the first
     * pass, a spec or page-object write after that. A filtered run never
     * counts as "the last run": those belong to the healer, checking one test.
     */
    autoRun: (events) => {
      if (!options.workspaceDir) return undefined;
      const facts = storyFacts(events);
      const spec = facts ? specPathFor(facts) : undefined;
      if (!spec || !existsSync(join(options.workspaceDir, spec))) return undefined;
      // Stage 2 first: running before a design is approved is what
      // `designFirst` refuses, and the runtime must not do what the model may
      // not.
      if (options.testTypes && options.testTypes.length > 0 && !approvedDesign(events))
        return undefined;

      // The same predicate `staleRerun` refuses the model by, read from one
      // place so the runtime and the gate can never disagree about whether a
      // run would see anything new. A filtered run belongs to the healer and
      // never counts as "the suite has run".
      const { lastFullRun, changed } = suiteChangedSinceLastFullRun(events);
      if (lastFullRun === undefined)
        return { toolName: "pw.run_tests", args: { spec }, why: "nothing has run yet" };
      if (changed.length === 0) return undefined;
      return {
        toolName: "pw.run_tests",
        args: { spec },
        why: `${nameChanged(changed)} changed since the last full run`,
      };
    },
    // The route: code, from what preflight observed plus the workspace as it is.
    // Not an instruction the model may weigh — on path B the authoring tools are
    // removed from its view entirely.
    route: (events) => {
      const d = chooseRoute({
        facts: storyFacts(events),
        ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
        frameworkFound: options.workspaceDir ? surveyFramework(options.workspaceDir).exists : true,
      });
      return {
        path: d.path,
        reason: d.reason,
        because: d.because,
        deny: d.deny,
        ...(d.stop ? { stop: d.stop } : {}),
      };
    },
    // Once a design is approved on path B, items no scenario covers yet mean
    // the run must add those scenarios — and only those. Switches once.
    reroute: (events) => {
      if (routePathOf(events) !== "B") return undefined;
      const design = approvedDesign(events);
      const facts = storyFacts(events);
      if (!design || !facts || !options.workspaceDir) return undefined;
      const featurePath = featurePathFor(facts);
      const specPath = specPathFor(facts);
      const read = (p?: string) => {
        if (!p) return undefined;
        const full = join(options.workspaceDir as string, p);
        return existsSync(full) ? readFileSync(full, "utf8") : undefined;
      };
      const featureText = read(featurePath);
      const specText = read(specPath);
      const covered = coverageOf(design, {
        ...(featureText !== undefined ? { featureText } : {}),
        ...(specText !== undefined ? { specText } : {}),
        ...(facts.story?.id !== undefined ? { story: facts.story.id } : {}),
      });
      const missing = design.items.filter((it) => !covered.has(it.id)).map((it) => it.id);
      if (missing.length === 0) return undefined;
      return {
        path: "A2",
        reason:
          `the approved design adds ${missing.length} item(s) no scenario covers yet ` +
          `(${missing.join(
            ", ",
          )}) — add their scenarios and scaffold; every existing scenario stays as it is`,
        // What is locked is what existed at THIS moment. Scenarios the run
        // adds afterwards for the new items stay its own to correct.
        because: {
          from: "B",
          appendOnly: true,
          missing,
          locked: lockedScenarios(featureText ?? ""),
        },
        deny: [],
      };
    },
    instructions: storyToTestsInstructions(
      options.workItem,
      options.testPlan,
      canCreatePlans,
      options.testTypes ?? [],
      tracker,
    ),
    allowedTools: [
      ...trackerTools(
        tracker,
        canCreatePlans
          ? STORY_TO_TESTS_TOOLS
          : STORY_TO_TESTS_TOOLS.filter((t) => !TEST_PLAN_TOOLS.includes(t)),
      ),
      // Stage 2's one tool, shown only when the project has test types in scope.
      ...(options.testTypes && options.testTypes.length > 0 ? ["aqa.test_design"] : []),
    ],
    sourceTools: trackerSources(tracker),
    verifier: new StoryToTestsVerifier(options),
  };
}

/** Stage 2: the test design, declared and approved before any test is written. */
function testDesignStep(types: readonly string[]): string {
  return `1c. STAGE 2 — DESIGN THE TESTS, AND HAVE THE DESIGN APPROVED, BEFORE WRITING ANY.
   Call aqa.test_design with the whole design. A person approves it before you
   write a feature file, scaffold, or create a test case — those calls are
   refused until a design is approved. If the reviewer rejects it, revise it and
   submit again.

   One item per test you intend to write:
     id          D1, D2, … — each scenario will carry the tag @design:D1
     covers      the criterion ("AC-2", or "AC-3a" for one part of AC-3), a bug
                 ("bug #48"), a task ("task #46"), or "story" (accessibility only)
     type        ISTQB test type, one of: ${types.join(", ")}
     technique   equivalence-partitioning, boundary-value-analysis,
                 decision-table, state-transition, error-guessing,
                 checklist-based
     conditions  the values or situations the test exercises
     expected    what must be observed
     source      WHERE that expectation comes from: "AC-2", "task #46",
                 "bug #50", "comment". An expectation with no source is a guess
                 about the application and is refused. An accessibility item
                 has no criterion behind it — say so: "agent.test_types
                 (WCAG A/AA)".
     expectFail  true for an Active bug's test, and only then

   Pick the technique from the RULE the criterion states:
     - a field that is required or has limits → boundary-value-analysis
       (empty, one character, valid, …);
     - inputs the rule treats alike, valid and invalid → equivalence-partitioning
       (e.g. registered / unregistered email);
     - several conditions that together decide the outcome → decision-table;
     - an action that changes what the page or session looks like afterwards →
       state-transition (e.g. signed in → signed out: is the token gone?).

   Types:
     - functional: every acceptance criterion needs at least one.
     - security: only what the story and its context imply — e.g. a login that
       does not reveal whether an account exists, a session that really ends.
       Observed through the browser as a user would; no attack tooling.
     - accessibility: one checklist-based item covering "story" — an axe-core
       scan. Make it DETERMINISTIC or it cannot support a bug: scan a fixed
       scope (the form under test, not the whole page, so a cookie banner or a
       storefront widget does not drift in and out between runs), pin the rule
       tags you are checking, and assert on the rule IDS —
       expect(violations.map(v => v.id).sort()).toEqual([]) — so a failure reads
       "label, color-contrast" rather than a page of JSON. Observed: a scan of
       the whole page reported a different violation on each run, which is a
       finding nobody can reproduce.
     - confirmation: a test for an open bug. Active → expectFail: true, and the
       test's first line is test.fail(true, "Bug #<id> Active: <title>").
       Resolved → confirms the fix and stays as a regression test. New → a
       claim; test it only if it touches this story, and never as expected to
       fail.

   Every open bug is either tested or listed under "excluded" with a reason
   ("bug #49 — New: an unconfirmed claim"). Every type in scope is used, or
   listed under "excluded" with a reason. Every criterion has a functional item.
   The runtime checks all of this before the reviewer sees the design, and
   tells you exactly what is missing.

   After approval, every scenario carries @design:<id> for the item it
   implements (alongside @ac:<n> / @bug:<id>). A scenario with no design tag was
   not approved, and a design item with no scenario was approved but not
   tested — the verifier checks both on the files.

`;
}
