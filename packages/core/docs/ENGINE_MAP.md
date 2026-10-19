# attestqa engine map

**Status:** working reference, started 2026-10-18 after a day of run-by-run fixes on Toolshop.
**Rule for every change to the engine:** read the relevant section here first, follow the [fix protocol](#10-fix-protocol), and update this file in the same change.

---

## 1. Why this file exists

On 18 Oct, seven Toolshop runs each stopped on a different problem. Each fix was real, and each one uncovered the next. The pattern came from fixing symptoms one rule at a time, without a picture of how the parts interact. This file is that picture.

## 2. The pipeline: stages and who owns each

| # | Stage | What happens | Owned by (code) |
|---|---|---|---|
| 0 | Route | Decide A (new tests), A2 (complete missing items), or B (run existing tests) | `route/route.ts`, `skills/story-to-tests.ts` (`reroute`) |
| 1 | Story context | The runtime reads the story, epic, siblings, comments, open bugs and framework *before* the model's first turn | `skills/story-context.ts`, `skills/jira-story-context.ts`, `framework/survey.ts` |
| 2 | Test design | The agent proposes items (`aqa.test_design`); the runtime checks them; a person approves | `design/test-design.ts` (`validateDesign`), `skills/story-rules.ts` (`invalidDesign`, `takenDesignIds`, `designFirst`) |
| 3 | Authoring | The agent writes the epic's `.feature` scenarios from the approved design | the agent, policed by the feature rules (§6) |
| 4 | Build | `bdd2pw.analyze`, then `bdd2pw.scaffold`, generate the spec and page object | `mcp/adapters/bdd2pw.ts` and the bdd2pw package |
| 5 | Implement | The agent fills in the TODO steps bdd2pw could not bind | the agent, policed by the spec rules (§6) |
| 6 | Execution | `pw.run_tests` (first run needs approval; the runtime may also run it itself via `autoRun`) | `mcp/adapters/pw.ts`, `runtime/loop.ts` |
| 7 | Triage | Each failure is classified (product defect, flaky, test problem, environment); possible defects are **quarantined** | `triage/classify.ts`, `triage/patterns.ts`, `triage/step.ts` |
| 8 | Heal | A locator failure switches the agent to the `heal` role | `agents/roles.ts`, `mcp/adapters/heal.ts`, `heal/locator.ts`, `heal/second-opinion.ts` |
| 9 | Defects | Bug proposals are held to the end, settled against the final run, then put to a person | `runtime/loop.ts` (`settleDeferredBugs`), `triage/settle.ts` |
| 10 | Verify | Gaps between what was asked and what exists; one retry, then blocked | `verify/story-to-tests.ts`, `triage/step.ts` |
| 11 | Report | `jira.record_qa` / ADO comment; stage lines and totals in the terminal | `report/qa-record.ts`, `runtime/stages.ts` |

## 3. Agents (roles)

There is **one model**. A *role* narrows the tools and instructions it sees. Code chooses the role from the ledger; the model never chooses it.

| Role | When | Tools | Instructions |
|---|---|---|---|
| `default` | Everything except healing | All of the skill's tools | The full story-to-tests instructions (about 9,200 tokens) |
| `heal` | The last suite run has a failure where `stuckAction(message)` is true, or a test that catches its own failure | `aqa.heal_locator`, `fs.read_file`, `fs.replace_in_file`, `pw.run_tests`, `pw.list_tests` | `HEAL_INSTRUCTIONS` in `agents/roles.ts` (about 25 lines) |

**Known defect (F1):** `stuckAction` relies on `LOCATOR_ERROR`, which matches `waiting for getBy…`. Playwright writes that line in the call log of **every** `expect(locator)` failure, including plain assertion mismatches that have a `Received:` line. So assertion failures are sent to the heal agent as "a locator that matched nothing" (Toolshop AC-3, `toHaveAttribute` with `Received: "page-link"`).

**Fixed 19 Oct:** `valueMismatch()` in `heal/locator.ts` is now checked first. A `Received…:`, `Expected pattern|…:`, "unexpected value" or `expect(received).toX(expected)` failure is an assertion, unless the element was not found. `stuckAction()` (used by the heal role, `aqa.heal_locator` and the bug rule `unhealedLocator`) returns false for it. Replaying run `223256Z`: the heal role that was started at event 116 no longer starts. Tests: `test/classify-failures.test.ts`.

## 4. Context the model sees each cycle

`runtime/context.ts`, `OrderedContextBuilder`. Each cycle sends the following sections; only their hashes and token counts go into the ledger:

| Section | Content | Size seen |
|---|---|---|
| `instructions` | The skill's instructions, plus the role's. Since 19 Oct, step 4 says every assertion states only what the design item expects, where a state sits is read from the snapshot, and `getByTestId` is preferred when the framework profile names a `testIdAttribute` (now read by `framework/survey.ts`) | about 9,200 tokens (`default`) |
| `request` | "Write tests for TOOL-6" | tiny |
| `tool_schemas` | The schemas of the visible tools | about 4,200 tokens |
| `sources` | Story context and source reads, up to 16,000 characters each (`SOURCE_CHARS`) | about 6,000 tokens |
| `history` | One compacted line per earlier call (2,000 characters each, `STEP_CHARS`); identical items are de-duplicated; the oldest are kept first up to a cap | grows to about 8,000+ tokens |
| `notes` | Refusals, gaps and runtime notes | small |

Each cycle is about 25–30k input tokens. A 1.5M-token budget is therefore only about 50–60 cycles, so every wasted cycle matters.

## 5. Loop controls (`runtime/loop.ts`)

| Control | What it does |
|---|---|
| Budgets | `budgets.steps` and `budgets.tokens` from the config (eval: 150 steps, 1.5M tokens) |
| `MAX_STALE_CYCLES = 3` | A cycle whose calls were all made before counts as stale; three in a row means blocked |
| `refusedAt` | A refused call is a repeat only while nothing has succeeded since (18 Oct fix) |
| `MAX_SAME_REFUSAL = 5` | The same tool refused for the same reason five times means blocked (18 Oct) |
| `MAX_SAME_DESIGN_PROBLEM = 6` | The same design problem six times means blocked |
| `MAX_DESIGN_DENIALS = 2` | A reviewer denies the design twice, and the run ends |
| `deferredBugs` | Bug proposals are refused as "deferred" and settled at the end |
| Mixed-bug rule | A bug in the same approval batch as other calls is refused |
| `approve_execution` | The first suite run needs a person's approval |
| `autoRun` | The runtime runs the suite itself when the spec changed since the last full run |
| `reroute` | B → A2 when an approved design adds items |
| Verifier retry | One retry with the gaps fed back, then blocked |

## 6. Refusal rules: 36 in `makeStoryRefusal`, plus 3 for the design

Grouped by stage, in the order the chain checks them (first match wins).

**Records (trackers):** `duplicateTestCase`, `duplicateBug`, `agentRunReport`, `untaggedTestCase`, `wrongSuiteTarget`

**Order of work:** `specBeforeScaffold`, `featureFirst`, `unboundStepsBeforeScaffold` (relaxed 18 Oct: after a second analysis), `scaffoldWouldOverwrite`, `noFramework`, `frameworkOwned`, `notInstalled`, `scratchInTheSuite`, `wrongEpicFile`

**Shared epic feature file:** `rewordsAnotherStory`, `dropsAnotherStory`, `untaggedScenario`, `missingKindTags`, `appendOnlyAfterReroute`, `appendOnlySpec`, `writeOnExecutePath`

**Loops and churn:** `alreadyRead`, `noChangeWrite`, `writeChurn`, `staleRerun`, `editorialOnly`

**Protecting test evidence:** `weakensAQuarantinedTest`, `repairsExhausted` (added 19 Oct: a test that has failed `MAX_FAILING_RUNS_PER_TEST` = 3 full runs may not be changed again; the verifier then reports it as a limitation, "put to the reviewer", instead of the `suite-not-green` gap, so the run ends cleanly; the stage report lists it under "Needs your decision"), `editsAPassingTest` (added 19 Oct: a test that passed in the last full run may not be changed while others fail, unless the latest verifier gaps name it or its design ID; replaying run `223256Z` refuses the edit at event 170 that broke AC-2), `expectedFailRemoved`, `misattributedKnownBug`, `fallbackInATest`, `writesMaskedValue`

**Bug quality:** `unlinkedBug`, `unhealedLocator`, `swallowedFailure`, `unobservedClaim`, `unscopedAccessibilityBug` (narrowed 18 Oct to accessibility bugs only)

**Design traceability:** `claimNotInDesign` (added 19 Oct: an address check, `toHaveURL` or "the URL …", introduced by a write is refused unless its design item's expected result, its conditions or its criterion speak of the address. Replays: refuses run `154651Z` event 98 and run `223256Z` event 187. Test ids are read from the comment block above a test, via `designIdsAbove`.)

**Design:** `invalidDesign` (+ `takenDesignIds`), `designFirst`

Each rule was written for a real incident (named in its doc comment). None of them was tested against the others.

## 7. Triage and quarantine

- **Categories:** `real-defect`, `flake`, `environmental`, `infrastructure`, plus test-code problems, scored by the pattern banks in `triage/patterns.ts`.
- **`applyRepetition`:** a `flake` that fails the same way twice becomes `real-defect` at 0.1 ("guessing has stopped working"). Since 18 Oct, "the same way" includes the locator.
- **Two different definitions of "quarantined" (F2):**
  - `triage/step.ts` → `quarantines(v)`: `real-defect` **and confidence > 0.1**. The verifier uses this.
  - `skills/story-rules.ts` → `quarantinedTitles()`: **any** `real-defect`, whatever the confidence. The write guard uses this.

  The result: tests the triage step deliberately did *not* quarantine (0.1, "we do not know") are still frozen by the write rule.
- **A brand-new test is quarantined on its first failure (F3):** an assertion mismatch (`Expected pattern:` … `Received`) scores `real-defect` at about 0.4. On a test written minutes earlier and never passed, that is far more likely a test mistake. From then on, `weakensAQuarantinedTest` refuses any change to its expectation.

**Fixed 19 Oct (F2, F3):** there is now one definition, `triage/quarantine.ts`.

- **When a test is quarantined:** only when the verdict is a confident product defect (`quarantines(v)`: `real-defect`, confidence > 0.1) **and** the test is proven. A test is proven if any of these hold:
  - it passed earlier in the run;
  - the run is on the execute path B;
  - it is a scenario locked by a re-route;
  - it is a known-bug test (`test.fail(` or `@bug:`).
- **Who uses it:** triage records the list in `payload.quarantined`. The write guard (`quarantinedTitles`) and the verifier (drift, defect candidates) read that list. Nobody recomputes it.
- **What changed in the notes to the agent:** they no longer say "propose a bug for each red test". Bugs are proposed only for quarantined failures, with the tracker's own tool. A test that has never passed gets a "check the test first" note instead.
- **The terminal:** it now says "new test failing that has never passed — the agent checks the test first; not yet a defect".
- **Replays:**
  - run `223256Z`: AC-3 and the accessibility test are no longer frozen;
  - run `125846Z`: the accessibility test is no longer frozen;
  - AC-2 still gets frozen, because it passed and was then edited. Item 3 (passing tests locked) stops that edit.

## 8. Verifier gaps (`verify/story-to-tests.ts`, `triage/step.ts`)

`story-not-read`, `no-test-design`, `design-item-not-tested`, `scenario-not-in-design`, `test-does-not-match-its-design`, `no-feature-file`, `no-spec-written`, `spec-not-generated-from-feature`, `hand-written`, `suite-not-run`, `suite-not-green`, `failures-not-triaged`, `known-bug-test-not-marked`, `quarantined-test-modified`, `no-test-cases`, `cases-not-linked`, `cases-not-in-suite`, `created-without-looking`, `bug-not-linked-to-story`, `bug-not-marked-as-agent-filed`

## 9. What went wrong on 18 Oct, and why

| Run | Stopped by | Root cause | Category |
|---|---|---|---|
| `163249Z` | Page showed no products; tests designed against an empty page | `--allowed-origins` blocked the API on :8091 | Config (fixed) |
| `222719Z` | Read a backup folder as the story's tests | Backup put inside the workspace (operator error) | Operator (fixed) |
| `115605Z` | Two false bugs, proposed 15 times; budget | One-off reads of a loading page; the Jira bug link was read from the wrong field | **C1** guessing + bug (fixed) |
| `123415Z` | Deadlock: no scaffold until 0 unbound, and no edit until a run | Two rules, never tested together | **C3** rule interaction (fixed) |
| `125846Z` | Quarantined test could not be repaired | bdd2pw `$` bug; repetition counted different locators as the same; quarantine refused moving to a parent | bdd2pw + **C2** (fixed) |
| `154651Z` | 18 refused bug proposals; budget | The accessibility rule matched the failing test's title, not the bug's | **C3** (fixed) |
| `223256Z` | AC-1 and AC-2 passed, then were broken by edits; the accessibility test was frozen; 5-refusal stop | The agent edited passing tests; it invented a URL check; F1, F2, F3 | **C1, C2** |

**The three structural causes:**

- **C1, guessing.** The agent writes expectations from assumptions, not from the page or the design. Examples: the URL changes to `?page=2`, `active` sits on the button, titles are present immediately. It also "repairs" tests that are passing.
- **C2, quarantine too early.** A brand-new, never-passed test is frozen as a defect candidate on its first failures. This blocks the only repair that could fix it, made worse by F2.
- **C3, rules piled up.** 36+ rules, each correct alone, collide in practice. There's no test of how they interact.

## 10. Fix protocol: follow it for every engine change

1. **Locate the stage and owner** in §2, and read that code.
2. **List every rule and loop control** (§5, §6, §7) that acts on that stage, and read each doc comment.
3. **Prefer changing or removing a rule over adding one.** A new rule needs a stated reason why no existing rule could carry it.
4. **Replay the real ledgers** that showed the problem against the change (they live in `packages/core/.aqa/runs/` and `TestRunApplication/*/.aqa/runs/`). Write a test from the real events.
5. **Check interactions:** run the rule-interaction tests (to be added, §11 step 4).
6. **Update this file** (§3–§9) in the same change.

## 11. The fix plan for C1–C3 (agreed 18 Oct: fix everything first, then release)

0. **Coverage first; a rerun builds only what is new** (requested 19 Oct).
   1. **Story fingerprint.**
      - The first run saves a fingerprint of the story (description plus acceptance criteria) in the tracker's QA record (the Jira QA sub-task, or the ADO run comment) and in the ledger.
      - On a rerun with an unchanged fingerprint: no design turn, no authoring. List the existing test cases, run them, report.

      **Done 19 Oct:** `design/fingerprint.ts` (`storyFingerprint`, `latestPriorDesign`, `readRuns`). The fingerprint is recomputed from each earlier run's recorded facts, so nothing is stored separately; the route event records it (`because.fingerprint`, `because.previous`), and the Jira QA record's run comment notes it. On route B with an unchanged fingerprint and every prior design item still covered, the route carries the design (`because.carriedDesign`), denies `aqa.test_design`, and tells the agent in a route note. `approvedDesign()` falls back to the carried design, so `designFirst`, `autoRun` and the verifier treat it as approved. Story changed, or an item lost its scenario → normal design, with the reason on the route line. The CLI passes `previousRuns` from `--ledger`. Tests: `test/fingerprint.test.ts`.
   2. **Design starts from what exists.** Before proposing anything, the design stage gathers three lists:
      - the story's test cases in the tracker (ADO test cases linked to the story; the Jira QA sub-task's list);
      - the scenarios tagged with the story in the epic feature file;
      - the tests in the epic spec.

      It then builds a coverage map: each acceptance criterion, open bug and test type, against what already covers it.
   3. **The agent proposes only the gaps.**
      - It covers whatever acceptance criterion, bug or test type no existing case covers.
      - An existing tracker test case with no script (written by a person) is automated as it stands, keeping its ID; the agent does not invent a replacement.
      - "No new test cases are required" is a valid design: zero new items, a one-line reason per criterion, and the reviewer approves it like any other design. The run then executes the existing tests.

      **Done 19 Oct (0.2 and 0.3, from the repository side):** `design/coverage-map.ts` builds the map from the epic feature file (scenarios tagged `@story:<id>`, matched by `@ac:n`, `@bug:<id>`, `@type:<t>`) and the epic spec (scripted or not). The preflight appends it to `aqa.story_context` as "EXISTING COVERAGE", with the instruction to reuse existing ids, propose only the "none" lines, implement unscripted scenarios as written, and say "no new test cases are required" when nothing is missing. The tracker-side list (Jira QA sub-task, ADO linked test cases) joins this map with step 0.4, when cases carry stable IDs. Tests: `test/coverage-map.test.ts`.
   4. **Stable test-case IDs on both sides.**
      - Each case gets an ID (for example `TOOL-6-TC03`, or the ADO test-case ID), written in the tracker record and as a tag or comment above its test in the spec.
      - The design ID (`D3`) stays as the cross-reference.
   5. **The terminal lists every case at the start of a run**, with its state: `exists`, `exists (no script yet)`, `new`, or `changed`. The later stages act only on the cases that need work.

      **Done 19 Oct (0.4 and 0.5):** `design/cases.ts`. The case ID is derived, `<story>-<Dn>`, because design ids are unique per epic file and every scenario and test already carries `@story:<id> @design:<Dn>`; no new tag has to be kept in step. The Jira QA record's tables use it. The route event records `because.cases` (this story's scenarios, scripted or not) and the stage tracker prints them as `== Test cases: …` at the start of the run. The design approval note lists each item as exists / exists (no script yet) / changed (expected, conditions or expect-fail differ from the last approved design) / new. Not done: ADO test-case work-item IDs are not mapped onto case IDs yet. Tests: `test/cases.test.ts`, `test/fingerprint.test.ts`.
   6. **`--fresh` (evaluation only):** ignores existing tests and authors from scratch, for the three-runs-per-story consistency measurement. Normal users never need it.

      **Done 19 Oct:** `aqa run --fresh` sets `fresh` on the skill: no carried design, no coverage section in the story context, no case list, no "changed" comparison. It does not pretend existing tests are absent — the generator would overwrite them — so the route stops with the scenario count and the file when this story's scenarios are still on disk. The evaluation's reset step (move them to `_attempts/`) comes first. Tests: `test/fingerprint.test.ts`.

1. **Quarantine only proven tests (C2, F2, F3).**
   - One definition of quarantine, used by triage, the write guard and the verifier alike.
   - It applies only to (a) tests that passed earlier, in this run or before it, or (b) confirmation tests for known bugs.
   - A new test that has never passed stays the agent's to fix.
2. **Classify failures correctly (F1).**
   - A failure with `Received:` / `Expected …:` is an assertion failure, never "a locator that matched nothing", whatever the call log says.
   - Only true locator failures go to the heal role.
   - Use pw-self-heal 1.3.0's `classifyError` / `diagnose` as the single classifier.
3. **Look before asserting (C1).**
   - Before implementing TODOs, the agent records what the page does for each design item: URL behaviour, where a state like `active` lives, loading placeholders, test-id attribute. It saves this as a short "observed" note in the run.
   - Spec assertions must come from the approved design plus that note.
   - Passing tests are not edited unless a verifier gap names them.
4. **Bounded repair phase.**
   - After the first full run: at most N repair attempts per failing test, and passing tests are locked.
   - Then the run stops and reports what is still failing, as test problems or possible defects for a person.
5. **Rule audit (C3).**
   - Go through the 39 rules against the new structure, and remove those that steps 1–4 make unnecessary.
   - Add a rule-interaction test suite that plays each recorded run's key moments through the whole chain.

   **Done 19 Oct.** Every proposal in the 36 recorded story runs (1,217 proposals, 491 refused today; 170 of them by the design rules) was replayed through the current chain with every rule evaluated, not only the first that refuses. Result per rule: how often it refuses first, how often it would also refuse behind another rule.
   - No rule is redundant. The two that never refuse first are kept on purpose: `featureFirst` is the only rule for a page-object write before the scaffold (its spec-write cases are shadowed by `specBeforeScaffold`), and `dropsAnotherStory` is the only rule for deleting another story's scenario (`rewordsAnotherStory` sees only scenarios that are kept).
   - One false positive fixed: `claimNotInDesign` refused address checks whose design item did speak of the destination ("returns to the storefront home page", "is sent to the login page", "stays on /#/login" — 9 runs). It now accepts a literal path and moving to / staying on a named page, and still refuses "page 2 is loaded" and "goes to the next page".
   - `repairsExhausted` would have fired in 10 old runs; none of them ended green, so the cap of 3 did not cost a finish.
   - Gate attempt 1 (19 Oct, run 135539Z) stopped at the scaffold: the agent rewrote the feature after analyzing it, `unboundStepsBeforeScaffold` refused with the OLD analysis's unbound steps, the agent took that refusal as stale and repeated the scaffold until the 3-cycle stop. The rule now compares the last analysis with the last write to the feature and asks for a new analysis when the file changed since. Its key moment is in the interaction tests.
   - Gate attempt 2 (19 Oct, run 144404Z) reached execution: 1 passed, 3 failed — all three bdd2pw LLM-lane mistakes (handoff `bdd2pw-handoff-navigation-axe-2026-10-19.md`). The agent's first edit to each of them was refused as "exhausted": `exhaustedTests` counted failing full runs, and the two reruns in between were set off by a page-object URL and an import line. Item 4 now counts repairs per test (`changedTests` in the fs result; content tracking for older ledgers). This also overturned the earlier reading of run 223256Z event 217: it was AC-3's first repair, not a fourth guess.
   - Gate attempt 3 (19 Oct, run 155404Z, bdd2pw 4.6.1): suite GREEN 5/5 at event 195, then the end-of-run state-transition check ("needs two assertions: one that the action took effect (the menu closed, the URL changed …)") sent it back. The agent rewrote a passing test to satisfy it, broke it (read page 2's products before the list refreshed), and triage called the failure a product defect three times; the agent proposed three versions of the same false bug. They were dropped at the end only by luck: the bug said AC-2 and the failing test was AC-2b, so the label match failed. Fixes: a test that passed earlier and fails since an edit is the test's fault (`regressedByEdit`, triage and settle); AC-2 matches AC-2b; repeated bug proposals keep the last; the state-transition check needs an action, quotes the design expectation and no longer mentions URLs (it contradicted `claimNotInDesign`, cause C3 again); the design check refuses state-transition on items with no action (D1 and D3 in this run). Not fixed: the scenarios for D2 and D3 carried each other's @design tags, and nothing checks a scenario's wording against the item it is tagged with.
   - Gate attempts 4–5 (19 Oct, runs 162611Z stopped by hand after its scaffold, and 163019Z): the fingerprint reused 162611Z's design and treated its never-run scaffold output as an existing, proven suite (route B). AC-3 was frozen as a defect candidate on its first failure, its correct repair (`li.active`) was refused four times, and the agent proposed a false bug, which the reviewer denied. Fixes: a prior run is built on only if it ended and ran its full suite after its last change; otherwise its tests are `unverifiedTests` (executed, not proven, design asked again). Tests failing when a reused run ended (`previousFailing`) are not proven either. State-transition design items must name the action's effect and the end state. The QA record reads full runs only (it reported AC-1 "passed" from a one-test re-run).
   - Gate attempt 6 (19 Oct, run 171551Z, bdd2pw 4.6.3): "suite green, 4 passed" straight after the scaffold, and the agent declared the work done. Six of the ten assertion steps were EMPTY: bdd2pw now emits an unbound step as an empty `test.step("[SKIPPED] …")` with a `// TODO` comment, not as `fixme`, and an empty step passes. `green` had assumed unbound steps come out as `fixme` (skipped). Fix: `withUnimplemented` in pw.ts reads the spec and reports any passed test with such a step as "unimplemented" (not passed, suite not green); the verifier lists the steps to implement. Also: the verifier reported "no Playwright spec file exists" because the scaffold reports no artefacts and the agent never opened the spec; the spec the suite ran now counts. bdd2pw handoff: `bdd2pw-handoff-empty-todo-steps-2026-10-19.md`.
   - Gate attempt 7 (19 Oct, run 181040Z): the empty-step fix worked — the agent filled in the TODO steps and the suite went 4/4 green with every step implemented. Blocked only by two verifier gaps. D2: a counting bug — bdd2pw 4.6.3's active-page rule writes `await expect\n.poll(…)`, and every assertion counter looked for `expect(` only, so two of D2's three checks were invisible (the weakening guards had the same blind spot: dropping a poll assertion would not have been noticed). Now one `ASSERTION_CALL` pattern covers `expect`, `expect.poll`, `expect.soft`. D4: the accessibility scan was page-wide (bdd2pw's axe rule always is); the agent tried `.include(".products")`, a class it had never seen, and gave up. The message now says to build the selector from roles and attributes in the snapshot.
   - Gate attempt 8 (19 Oct, run 200105Z): design reused, 4/4 green, but the AC-3 test never clicked page 2 (F-0071) and is now sent back. The reviewer asked which findings should stop a run. Decision: kind 1 (broken or fake: failing, empty TODO step, catches its own failure, missing `test.fail` marker, design item without a test, state transition with no action) blocks. Kind 2 (works but weaker or broader than the design: unscoped axe scan, no took-effect assertion) gets one fix attempt as gap `test-is-weaker-than-its-design`; on the next verify the same item becomes a limitation "for your review — …" (`splitReviewItems`, `isReviewOnly`), shown under "Needs your review" in the report and as a "Needs review" paragraph in the Jira QA comment. The QA comment also carries a "Design expects / Test checks" table (Then/And step titles from the spec), printed in the record_qa approval, so a gap no rule can judge (D1: "every card has a name, price and image" checked by one product's name and price) is visible to the reviewer.
   - Gate attempt 9 (19 Oct, run 202717Z): 4/4 green on the reused design; D4 went to review as designed, but the agent never touched D3. The route-B note said "your work is only what its results call for — repairing a test that fails"; with a green suite the agent twice answered "no further action is needed", even after reading the gap. Fix: at route time the reused design is traced against the files (`traceProblems`) and the note names the passing tests that must change. The reviewer text is cut to its first sentence (`forReviewer`).
   - Interaction tests: `test/rule-interactions.test.ts` plays trimmed real ledgers (`test/fixtures/ledgers/*.jsonl.gz`, runs 223256Z and 154651Z; checked for hosts and e-mail addresses — only localhost and public sites) through the whole chain and the role picker.
6. **Clean run gate.** TOOL-6 must complete green with no manual intervention other than the two approvals before the release.
