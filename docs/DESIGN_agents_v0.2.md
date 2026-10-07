# agentic-qa — orchestrator and agents (v0.2, spec)

**Status:** specification. Nothing in here is built yet except where a section says
"already built". Written 2026-09-25, after the heal slice landed and after four runs
failed on the same wrong assumption: that a run *creates* the automation it tests.

**One sentence:** an orchestrator written in code picks the path and calls specialist
agents in a fixed order; each agent sees only its own adapters, returns a typed result,
and everything it did is one gated call in one ledger.

---

## 1. Why this shape

Today one model holds every adapter and a ~9,800-token instruction set covering design,
BDD vocabulary, page objects, healing, triage and bug filing. Three consequences, all
observed:

- **The budget goes on discovery.** Run 20260925T151945Z spent 94 events and never ran
  the suite: it rewrote a feature file, scaffolded into the wrong file, then spent three
  turns trying to read a spec a refusal would not let it read.
- **The wrong path is taken silently.** The same agent decides whether automation exists
  by reading directories. When it guessed wrong, nothing refused it — it simply generated
  42 unbound steps in a file nobody wanted.
- **Roles that need no judgement still cost a turn.** Executing a suite, counting a
  report and triaging a failure are deterministic. They are currently model turns.

The fix is not a bigger prompt. It is to put the routing in code, and to give each agent
only what its job needs.

### The one thing this design refuses

**The orchestrator is not a model.** A model at the top of the system means a replay can
route differently than the run it replays, and "why did it skip authoring?" becomes a
question about a prompt rather than a fact on disk. Every branch in §3 is decided by code
from observable state.

## 2. Principles

1. **One gate, one ledger, one policy table.** Splitting agents does not split governance.
   Every tool call any agent makes is judged by `ScopedGate` and written to
   `.aqa/runs/<id>/events.jsonl`.
2. **Adapters belong to agents.** bdd2pw is the author agent's; Playwright is the
   execute agent's. An agent that cannot see an adapter cannot use it, and the manifest
   still refuses it if it tries.
3. **Agents do not talk to each other.** Each returns a typed result to the orchestrator.
   No agent is ever handed another agent's prose as instructions.
4. **State, not effort, decides the path.** What is on disk and what the story says,
   read by code, never "the agent believes there is a framework".
5. **A gap must be closeable by the agent it is told to.** A refusal names the one call
   that fixes it.

## 3. Path selection (code)

Run at the start of every run, before the first model turn, from the stage-0 survey plus
stage-1 story context. Both already exist (`surveyFramework`, `gatherStoryContext`).

| Observed state | Path | What runs |
| --- | --- | --- |
| No Playwright config in the workspace | **P0 — refuse** | Nothing. `aqa init-framework` is a separate, human-approved action. The run stops with that instruction. |
| Config exists; no feature file for this epic | **A — author** | context → design → author → implement → execute → triage → heal? → report → defect? |
| Feature file exists; no spec, or spec has no test for this story's scenarios | **A′ — complete** | context → design → author (missing scenarios only) → implement → execute → … |
| Feature and spec exist, and every scenario tagged `@story:<id>` has a test | **B — execute** | context → design (reduced) → execute → triage → heal? → report → defect? |

Rules that fall out:

- **On B nothing is authored and bdd2pw is never called.** The suite is executed as it
  stands. This is the path your repo is in, and the one the runtime has never taken.
- **The path is a ledger event** (`kind: "route"`, with the survey facts that decided it),
  so a replay takes the same path by construction.
- **A′ writes only what is missing.** Scenarios for other stories in the epic file are
  not rewritten — see the refusal in §6.

## 4. The agents

Each entry: who does it, what it is given, what it may call, what it returns. "code" means
no model turn at all.

### 4.1 Context — code (already built)

- **Given:** story id, project.
- **Does:** governed ADO reads — story, epic, siblings, tasks, comments, the project's
  open bugs — filtered of this runtime's own reports and bugs (`isRunReport`,
  `isAgentBug`), plus the workspace survey.
- **Returns:** `StoryFacts` + `FrameworkProfile` + the digest text handed to later agents
  as a *source*, never as instructions.

### 4.2 Design — model

- **Given:** the digest, the past-defect profile, the test types in scope, and (new) the
  scenarios already on disk for this story.
- **May call:** `aqa.test_design`, `aqa.defect_context`.
- **Returns:** an approved `TestDesign`, or the run stops. Human approves.
- **New on path B:** each item is marked `alreadyCovered: "<scenario title>"` when a
  scenario tagged `@story:<id>` with the same criterion or bug already exists. The
  approval prompt reads "7 items — 5 already covered, 2 new".
- **Refusals (built):** invalid design, design-before-tests, bug not tested or excluded,
  type in scope with no item.

### 4.3 Author — model

- **Given:** the approved design, the epic feature path, the feature file as it is.
- **May call:** `fs.read_file`, `fs.write_file` (the `.feature` file only),
  `bdd2pw.analyze`.
- **Returns:** the feature file's scenarios for this story, each tagged
  `@story:<id> @ac:<n>|@bug:<id> @design:<Dn>`.
- **New refusals:** may not hand the file to the implementer until `bdd2pw.analyze`
  reports **zero unbound steps** (§6), and may not change another story's scenario text.

### 4.4 Implementer — model

- **Given:** the feature file, the survey (where specs and page objects live), the page
  snapshot when it needs one.
- **May call:** `bdd2pw.scaffold`, `fs.*` on the spec and page objects,
  `playwright.browser_snapshot`.
- **Returns:** a spec whose tests match their design items in shape (`shapeProblems`).
- **New rules:** `scaffold` is refused when the epic spec already exists (it would turn
  implemented tests back into TODOs); the scaffold result must name the files it actually
  wrote, scanned from disk, not a directory it guesses.

### 4.5 Execute — code

- **Given:** the spec path, and optionally one test title for a filtered rerun.
- **Does:** `pw.run_tests`. No model turn.
- **Returns:** `TestRunSummary`, including `pageAtFailure` per failure.
- **Rule (built):** the report, the verifier and bug settlement all read the last
  *unfiltered* run (`lastFullRun`). A filtered run is a working tool, never a result.

### 4.6 Triage — service or in-process (already built)

- **Given:** the run summary.
- **Returns:** a verdict per failure — `real-defect`, `test-defect`, `flake`,
  `environmental` — plus a run-level classification. A `real-defect` verdict quarantines
  that test: its assertions may not be weakened and it may not be deleted.

### 4.7 Heal — model, small (built, §4.7 is the newest slice)

- **Given:** one failing test and the page snapshot the failure carries.
- **May call:** `aqa.heal_locator`, `fs.write_file` (the locator line), one filtered
  `pw.run_tests`.
- **Returns:** the chosen candidate and the result of the rerun.
- **Rules (built):** a bug may not be proposed while a locator failure has not been read
  (`unhealedLocator`), nor from a test that catches its own failure
  (`swallowedFailure`); assertions of a quarantined test may not change.
- **Loop:** heal → rerun that test → full suite. Next candidate only if it still fails on
  a locator; a different failure goes back to triage.

### 4.8 Report — code (already built)

- Composes the run report from the ledger: every test with its result, expected-to-fail
  markers, failures with their first error, other stories' failures named as such, and
  the limitations of the environment. The model may post it verbatim and may not restate
  its figures.
- **Fix needed:** the headline counts every failure in the epic spec, so a story whose own
  tests all passed still reads "NOT green". It must read on this story's tests, with the
  epic's other failures as context.

### 4.9 Defect — model, behind a human

- **Given:** the final run, the triage verdicts, the past-defect profile.
- **May call:** bug `create` only, type `Bug` only. `update`, `update_batch`, `add_child`
  do not exist for any agent.
- **Rules (built):** parented to the story, tagged `agentic-qa`, one bug per failing test,
  held until the run ends, dropped if its test ended green or belongs to another story,
  refused if it doubts itself in its own text.

## 5. Contracts

Three record types, each already a ledger event or a small addition:

```jsonc
// NEW: why this run took this path
{ "kind": "route", "path": "B", "because": {
    "config": "playwright.config.ts", "feature": "features/epic-42-….feature",
    "spec": "tests/epic-42-….spec.ts", "storyScenarios": 4, "implemented": 4 } }

// NEW: one per agent, closing its turn
{ "kind": "agent", "role": "heal", "ok": true,
  "result": { "test": "Story-a — …", "chose": "page.getByRole(\"menuitem\", …)" },
  "calls": [128, 131, 134] }          // the events it made

// EXISTING: every call, with its policy decision and observation
{ "kind": "call" } / { "kind": "policy" } / { "kind": "observation" }
```

The orchestrator passes only typed records between agents — never one agent's free text
as another's instructions. An agent's prose reaches the ledger as a `note` and nothing
reads it back as fact.

## 6. New refusals this design requires

| Refusal | Why it exists |
| --- | --- |
| `noFrameworkAtAll` → stop the run | Path P0. Four runs were spent testing the runtime's own `examples/sample-project`. |
| `scaffoldWouldOverwrite` | `bdd2pw.scaffold` when the epic spec exists would replace 13 implemented tests with TODOs. |
| `unboundStepsBeforeScaffold` | `bdd2pw.analyze` must report zero unbound steps first. Run 20260925T151945Z generated 42 TODOs and found out afterwards. |
| `rewordsAnotherStory` | A feature write may not change another story's scenario text. `dropsAnotherStory` catches deletion only. |
| `staleReadAfterGeneration` (fix) | `alreadyRead` must count `bdd2pw.scaffold` as a change. This refusal ended a run. |

## 7. Failure modes, and what stops each

| Failure | Stop |
| --- | --- |
| A model decides the route | The route is code, recorded as a `route` event. |
| An agent uses another agent's power | Tool lists per role; the manifest refuses anything unlisted. |
| One agent believes another's prose | Only typed records cross the boundary. |
| A generated file lands where nobody looks | The scaffold result names the files it wrote, from disk. |
| Implemented tests are regenerated into TODOs | `scaffoldWouldOverwrite`. |
| A story is blamed for another story's failures | Verify and report scope by `@story:<id>` (built). |
| A false bug from a test that hid its own break | `swallowedFailure` (built). |
| A locator failure becomes a product defect | `unhealedLocator` + `aqa.heal_locator` (built). |
| Splitting agents breaks replay | One ledger; `aqa replay` must reproduce every run in the corpus — the test that gates this whole change. |

## 8. Verification

State, not effort. Each slice ships with tests in the style the repo uses:

1. **Route:** given a workspace with config + feature + implemented spec, the route is B
   and no authoring tool is ever offered. Given no config, the run stops with
   `init-framework`.
2. **Tool isolation:** the heal agent's tool list does not contain `bdd2pw.scaffold`; a
   call to it is refused by the manifest.
3. **Replay:** every ledger in `.aqa/runs/` replays to the same verdicts after the split.
4. **Design on B:** a design whose items are already covered renders "5 already covered,
   2 new" and writes nothing.
5. **Scaffold guard:** scaffold with the epic spec present is refused, naming the file.
6. **Analyze gate:** a feature with an unbound step refuses scaffold and names the step.
7. **Heal loop:** a failing locator, healed, rerun filtered, then full — and the report
   reads the full run.

## 9. Task split

Each task is independently shippable, tested, and synced before the next begins.

| # | Task | Depends on | Done when |
| --- | --- | --- | --- |
| S1 | Fix `alreadyRead` (a scaffold changes files); scaffold result names files written | — | A scaffold is followed by a successful read of the generated file, in a test |
| S2 | Route in code: P0 / A / A′ / B + `route` ledger event | S1 | Test 1 and 3 pass; a B run offers no authoring tools |
| S3 | Design on path B: mark already-covered items, render the reduced prompt | S2 | Test 4 passes; story #44 approval reads "already covered" |
| S4 | Author guards: analyze-before-scaffold, `rewordsAnotherStory`, `scaffoldWouldOverwrite` | S2 | Tests 5 and 6 pass |
| S5 | Split the heal and execute agents: own prompts, own tool lists, `agent` ledger event | S2 | Test 2 and 7 pass; heal prompt under 40 lines |
| S6 | Report headline scoped to this story's tests | — | A story whose own tests pass reads green, with other failures as context |
| S7 | Wire bdd2pw's LLM fallback (config `bdd2pw.llm` + `AI_GOVERNANCE_URL`), surfaced in the report | S4 | A scaffold reports `llmFallback: anthropic` and leaves no unbound step |
| S8 | Split author, implement and defect agents | S5 | Replay corpus unchanged |
| S9 | Jira adapter: a tracker seam, then Jira behind it | S8 | The same story runs end to end against Jira and against Azure DevOps, with one ledger shape and no rule naming a tracker |

S1, S2 and S6 are the ones that unblock the current runs. S8 is the end of the migration
and is deliberately last: it is the largest and the least urgent. S9 comes after S8 because
it is the first task that is about reach rather than about honesty.

### S9, in more detail

A Jira adapter is not "one more adapter". Azure DevOps is currently named in places that
have nothing to do with talking to a server:

- **Rules.** `unlinkedBug`, `untaggedTestCase`, `wrongSuiteTarget` and `duplicateTestCase`
  read `ado.wit_work_item_write` arguments — `fields`, `workItemType: "Bug"`, `testsWorkItemId`.
  A rule that names a tracker cannot govern a second one.
- **Context and report.** `story_context` reads a work item, its epic, siblings, comments
  and bugs; the run report posts a comment with a test table. Both assume ADO's shapes.
- **Scope and provenance.** `agent.scope.work_items`, `isAgentBug`, `isRunReport` and the
  `@story:`/`@bug:` tags all carry integer work-item ids.

So S9 is two pieces of work, and the first is the real one:

1. **A tracker seam.** One vocabulary the runtime speaks — story, acceptance criteria,
   child bug, test case, comment, link — with ids as opaque strings, and every rule and
   report written against that instead of against `ado.*`. This is a refactor with no new
   capability and no new behaviour: the test for it is that the replay corpus and every
   existing refusal message are unchanged.
2. **Jira behind the seam.** Issue for story, sub-task or linked bug, and the two honest
   gaps: Jira has no first-class test case (Xray/Zephyr are add-ons, so `capabilities.test_cases`
   joins `capabilities.test_plans` as something a config declares and the report admits when
   absent), and Jira's ADF comment format is not markdown.

The governance stays where it is. A tracker is a system of record whichever one it is, so
the policy classes, the deferral of bugs until execution finishes, and the human approval
before any write are untouched by this task — which is the point of doing the seam first.

## 10. Open questions

1. **Design reuse across runs.** An approved design could carry forward while the story's
   `rev` is unchanged, so the same question is not asked twice a day. Tempting, and it
   weakens "the run contains its own evidence". Leaning: reuse, but record the
   earlier run and rev in the ledger and say so on screen.
2. **Page-object ownership.** Heal changes a spec's locator line; a missing page-object
   field is the implementer's. Leaning: keep it that way, and let heal report
   "needs a POM field" rather than adding one.
3. **Per-agent models.** Nothing here requires one model for all agents. Execute and
   report need none; heal could run on a small one. Worth measuring once S5 lands.
4. **Budgets per agent** rather than per run, so a stuck author cannot starve the healer.

## 11. Non-goals

- No agent-to-agent messaging, ever.
- No model in the orchestrator.
- No memory in this version — `DESIGN_memory_v0.1.md` stands on its own and comes after
  the stages are finished.
