# Changelog

## 2.0.1

### Patch Changes

- Azure DevOps test cases are no longer refused for missing tags. The test-plan tool that creates them has no tags field and rejects fields it does not list, so the rule could never be met and every Azure DevOps run stopped there on "no progress". A case created that way is traced by its TestedBy link to the story and listed in the run's results comment; tags are still required where a tool can carry them.
- Azure DevOps stories whose acceptance criteria are an HTML list (`<ul><li>AC-1: …</li>`) are read correctly again. In 2.0.0 the list bullets hid every label, the story looked as if it had no criteria, and every design item was refused as "not one of the story's criteria ()". Jira and Azure DevOps now read criteria labels with one function. The example configs now show the Azure DevOps story form (`AB#<id>`) and quote the `--env` list, which PowerShell otherwise splits at the comma.
- A new test that fails on its first run because the product is wrong can now be reported. After checking the test against its design and the page, the agent may propose a bug with the evidence; a person decides at the end of the run, as for any bug. While that bug is held, its failing test counts as reported rather than unfinished, so the run can complete. If the reviewer files none of the held bugs and the suite is still red, the run ends blocked instead of done. Locator and test-code failures can never become bugs.
- On the execute path a run may now undo or correct a line it added itself earlier in the same run, and may move an accessibility scan's `.include(...)` / `.exclude(...)` region the way it repairs a locator. Before, a run that scoped a scan to a region not on the page (`.include("main")` on a page with no `<main>`) was refused every attempt to put it right and stopped on no progress. Triage now reads axe's "No elements found for include/exclude" as the test's own error, not a possible product defect.
- An accessibility test's failure now says what failed: each axe rule, its impact, the elements it failed on and, for colour contrast, the measured and required ratios (for example "color-contrast (serious) on 4 element(s): …; contrast 3.42:1 (needs 4.5:1)"). Before, the message was cut to its first 600 characters, which held one rule's tag list and no element, so the agent, triage and any bug it filed could not say which elements failed. The run report no longer lists a failing test under "Needs your decision" once a bug about it has been filed.

## 2.0.0

### Major Changes

- 0b1b138: Engine 2.0.0, the engine inside attestqa release v1.0.0. Breaking: the ledger carries `tool: "attestqa"` and new event kinds (`route`, `agent`, `triage`) and payload fields; Node.js 20 or later is required. New since 1.1.0: Jira beside Azure DevOps through one tracker interface; routes A / A2 / B decided from what is on disk; a test design approved by a person before any test is written; append-only completion of shared feature and spec files; triage with decisive overrides; locator heal with pw-self-heal as a second opinion; `aqa coverage` and `aqa check-rules`; a VS Code extension (released separately as `attestqa-vscode`).
- fca42cd: Ledger 2.0. New ledgers are written with `tool: "attestqa"`; ledgers written as "agentic-qa" (every run before the rename, including the Paper I corpus) still load, replay and report exactly as before. Three new event kinds record what people do: `ruling` (a decision about what the software should do, citable by later runs), `user_edit` (a change made through attestqa by a person, never claimable by the agent) and `run_aborted` (written by the host when a run's process dies without an `end`; replay reports such a run as aborted).

### Minor Changes

- 588039b: Azure DevOps: every run now ends with a results comment on the story (after your approval), like the Jira QA sub-task's results log. Previously a green run that created no test case and proposed no bug posted nothing, which left no record of the run on the story.
- 745a842: Three decisions per Jira story, in order. Approving the test design now also posts its test cases to the story's QA sub-task straight away (the prompt says so); new optional `agent.approve_execution: true` makes the first suite run of each run wait for a person, with later re-runs going ahead under that approval; bugs are still put to you after execution. The results comment follows at the end under the design approval. New `Skill.afterApproved` hook for runtime calls covered by an approval already given. Fixed: after an in-place edit (`fs.replace_in_file`), re-reading the changed lines was refused as "nothing has changed", and the rules judged later edits against the file as it was before the edit.
- ea2f32b: New `aqa coverage --workspace <project> [--ledger .aqa] [--story <id>] [--out <file>] [--json]`. For each story it shows the last approved test design, the scenario and test that implement each design item (matched by `@story` and `@design` tags only), and the last recorded result — passing, known bug reproduced, known bug not reproduced, failing, not run, or no test — plus acceptance criteria with no test and scenarios outside the design. Offline: no model, tracker or browser. Exits 0 when every item is covered and green, 3 otherwise. `storyCoverage` and `renderCoverage` are exported for use as a library.
- fd1c5f7: New `aqa init`: sets up a Playwright project in one step. It asks for the tracker (Jira or Azure DevOps), the stories the agent may work on and the application's address, then writes a valid `ai-quality.config.yaml`, a `.env` with empty credential lines (never overwritten; an existing one is only checked for missing names, never read for values) and `.gitignore` lines for `.env` and `.aqa/`. Flags (`--tracker`, `--scope`, `--url`, `--dir`, `--force`) replace the questions where there is no terminal.
- caf1031: Takes bdd2pw 4.5.0 (pw-emit 1.4.0). Scaffolds now pass `--spec-name`, so an epic's spec is named after its feature file (`features/epic-scrum-5-…feature` → `tests/epic-scrum-5-….spec.ts`), the path every rule and the verifier already expected. The scaffold result reports where each step's code came from, counted from bdd2pw's `// @bdd2pw lane=rule|llm|todo` provenance comments. The agent's browser and generated suites default to the installed Chrome (`AQA_BROWSER`, `PW_CHANNEL` to change it). The design checker accepts Jira task and bug keys as sources.
- Bugs carry their evidence and the report links them. When a person approves a Jira bug, the runtime attaches the failing test's own Playwright screenshot and trace from the final run (chosen from the report, never by the agent; only files inside the test project, at most 5, 10 MB each). The filed bug and the story's QA sub-task are returned with their Jira links, and the end-of-run report lists each filed bug with its link, the QA record link, and each failing test with its screenshot path.
- 6b41189: New `aqa check-rules <run-dir>... --config <file>`: replays each recorded run's proposals through today's rules offline (no model, no tools, no network), lists every decision that would now differ, and probes the run's end point for a rule deadlock (no way left to write a missing design item's test); exits 2 on a deadlock. Fixed the deadlock it found: after a re-route from the execute path to completion, "write the feature first" and the verifier's hand-written-spec check no longer apply — the new test is written by hand beside the existing ones, as the scaffold guard asks.
- fd1c5f7: Claude through a company gateway: attestqa now reads the same two settings Claude Code uses, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, so a machine where Claude Code works through the company's LLM gateway (including gateways in front of Bedrock, Vertex or Foundry) runs attestqa with no new key. `agent.model.endpoint` can set the gateway per project. The run's first line names the gateway and the credential variable, never the value. `aqa init` asks which model route the company uses (Claude gateway, Anthropic key, Azure OpenAI, or an OpenAI-compatible gateway) and points Copilot users to the VS Code extension, the only supported place to use Copilot's models.
- The test design now starts from what already exists. Before designing, the agent sees which acceptance criteria, open bugs and test types of the story already have a scenario in the epic feature file (and whether it is scripted), and which have none. It proposes only the gaps, keeps existing design ids, implements a scenario that has no script yet as written, and can answer "no new test cases are required".
- 588039b: `--env` takes a comma-separated list (`--env .env.booker,.env`); the first file to set a variable wins. One application's project and test account can sit in a small file of their own, layered over the shared credentials.
- 51664df: Jira adapter (`jira.*` tools): read an issue (summary, type, status, description, acceptance criteria from a configured field or a description section, labels, links, sub-tasks), read its comments, and run a JQL search; create a Bug linked to its story after approval. Works with Jira Cloud (API v3, email + API token) and Data Center (API v2, personal access token). There is no tool to edit, transition, comment on or delete anything.
- 745a842: Jira stories get one QA sub-task (ADR-004): its description holds the current test cases from the approved design, and each run adds a comment with every case's result — composed from the ledger and the test files, posted by the runtime at the end of the run after your approval (`jira.record_qa`). The description is rewritten only when the approved design changes; attestqa edits no other field of any issue, and skips its own QA sub-task when reading the story. Projects without a sub-task type get the record as a comment on the story.
- caf1031: Jira stories run end to end. Set `JIRA_BASE_URL` with `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud) or `JIRA_PAT` (Data Center) in `.env`, and `aqa run "Write tests for SHOP-12"` reads the story from Jira (`--tracker jira|ado` overrides the guess). The agent sees the four Jira tools instead of the Azure DevOps ones; Jira keeps no test cases, so none are asked for and the feature file's `@story` tags are the record; the run report stays with the run. Every bug rule — held to the end of the run, asked about on its own, refused while the environment was down, refused as a duplicate — now applies to `jira.create_bug` through one shared view of a proposed bug. Fixed: story facts read back from the ledger turned a Jira key into NaN.
- 75098da: Model providers: a `gateway` provider for a company's own OpenAI-compatible gateway (endpoint required, non-secret headers allowed, any header that looks like a credential refused at load time, key from `AQA_GATEWAY_API_KEY`). `agent.model.auth` (`key` | `none` | `entra` | `aws-sso`) and a `TokenSource` interface, so company sign-in can supply a fresh short-lived token for every request instead of a stored key. `registerProvider()` lets plug-ins such as `@attestqa/provider-bedrock` add providers without the core depending on them. A shared conformance suite now runs against every OpenAI-compatible provider.
- 7510a6d: `aqa.heal_locator` now also ranks the candidates with pw-self-heal (heuristic mode, suggest-only) and returns its choice as `secondOpinion`, including whether it agrees with attestqa's own ranking. Nothing is applied: the repair is still a spec write the story rules check, and attestqa's own ranking still decides the verdict. Triage now uses pw-self-heal's stale-element class: a page, frame or element torn down mid-action ("Execution context was destroyed…") is a flake with its own explanation, not a real defect at 0.1 confidence.
- 6b41189: A run that starts on the execute path now switches to "complete" when the approved test design adds items no scenario covers, so the new scenarios can be written; existing scenarios must stay byte for byte. A known-bug marker (`test.fail(true, "Bug #X …")`) added to a test that is not tagged `@bug:X` is refused when proposed: it turns an unexplained failure into a pass.
- 4c680d6: Lessons from the first Jira runs (SCRUM-8 on Juice Shop). Triage now decides two kinds of failure that never reached the product instead of guessing: a failure inside a `beforeEach`/`beforeAll` hook is environmental (nothing in the test body ran), and an invalid selector is the test's fault and is no longer upgraded to a "defect candidate" just because it repeats. The live line no longer presents the no-pattern default as a product defect ("matched no known failure pattern — held for you as possible defects, at low confidence"). Test-design coverage only counts a scenario as testing an item when it is the same type of test, so a security item is not reported "already tested" by a functional scenario on the same criterion.
- A run now announces each stage as it starts and finishes: test design (and when it waits for your approval), test case authoring, building the test script with bdd2pw, execution (and its approval), self-healing, defect analysis and creating defects. It ends with a report: total scripts, passed, failed, defects found, and whether the story completed. In VS Code's Copilot Chat these stage lines appear in the chat itself.
- Test cases have one stable ID everywhere: the story plus its design item (`TOOL-6-D3`), shown in the Jira QA record and matching the `@story:TOOL-6 @design:D3` tags on the scenario and the test. Every run now starts by listing the story's existing cases (`exists` or `exists (no script yet)`), and the design approval lists each proposed case as `exists`, `exists (no script yet)`, `changed` (its expectation differs from the last approved design) or `new`.
- A story that has not changed is not designed again. Each run records a fingerprint of the story (title, acceptance criteria, open bugs with their state, test types in scope). When it matches the latest earlier run that had a design approved, and every item of that design still has its scenario, the run reuses that design: no design turn, no authoring — the existing tests run, and only their results call for work. The terminal says "Test design: reused", and the Jira QA record notes the fingerprint. A changed story, or a design item whose scenario is gone, is designed again, and the route says why.
- 29892b9: Story ids can be Jira keys. `@story:SHOP-12` tags, epic file names (`epic-shop-1-checkout.feature`), bug and task references and the shared-file rules all accept a Jira key beside an Azure DevOps number; Azure DevOps ids behave exactly as before. New `gatherJiraStoryContext` reads a Jira story, its epic and sibling stories, sub-tasks, comments and open bugs into the same facts the Azure DevOps reader produces, leaving out the runtime's own run reports and Bugs.
- fd1c5f7: GitHub Copilot as a model route: `provider: vscode-copilot`. VS Code lends Copilot's models only to extensions, so the attestqa VS Code extension relays a run's model calls to VS Code's Language Model API through a private 127.0.0.1 address with a per-run token (`AQA_VSCODE_LM_ENDPOINT`, `AQA_VSCODE_LM_TOKEN`). Outside VS Code the route stops at once with an explanation. Copilot reports no usage, so token figures are recorded as estimates (`usage.estimated: true` in the ledger). `aqa init` offers it as option 5.

### Patch Changes

- 6b41189: After a re-route to append-only completion, only the scenarios that existed at the re-route are locked; the run can correct the scenarios it adds. Each new design item gets exactly one scenario, and once every new item has one, further feature edits are refused until `bdd2pw.analyze` has run, so the run moves on to analyze and scaffold instead of rewording.
- 6b41189: After a re-route to append-only completion, the new design item's test is written into the existing spec by hand (scaffold stays refused, since it would regenerate implemented tests). A new rule keeps that safe: every test already in the spec keeps all of its assertions, and each new test carries the @design tag of an item being completed.
- 44e1e37: Adding a second story's scenarios to a shared epic feature file no longer deadlocks. A comment line (`# --- SCRUM-6 ---`) is no longer counted as a step of the scenario above it, so a pure append is not mistaken for rewording another story, and the refusal now says how to append safely (`fs.replace_in_file` on the file's last line). New rule `writesMaskedValue`: a write that would put a read-time mask (`[EMAIL]`, `[PASSWORD]`, `[TOKEN]`, …) into a file is refused with an explanation, instead of corrupting the file or failing as an unexplained "rewording".
- Assertions must come from the approved design. A check of the page address that the design item never mentions is refused (the agent cannot operate the application, so it cannot know whether the address changes), and the instructions now say to assert only what each design item expects and to read where a state sits from the page snapshot. A project's `testIdAttribute` (for example `data-test`) is read from its Playwright config and shown to the agent, so `getByTestId` finds its elements.
- 660704e: On the execute path (route B), removing a line that contains a locator was always treated as a locator repair — including assertion lines, so an `expect(page.getByText(…))…` could be deleted or rewritten. A removed assertion is now allowed only when an assertion making the same claim (locators set aside) remains; moving the locator inside a check is still a repair. "strict mode violation" (an ambiguous locator) is now classified as the test's own fault rather than a possible defect, and "failures-not-triaged" is reported only when triage really gave no verdict for the latest run.
- A test that found its element and failed on a value (a `Received` line, an `Expected pattern`, a deep-equality diff) is no longer treated as "a locator that matched nothing". It stays with the main agent instead of being handed to the heal agent, and it no longer blocks a bug as an unexplained locator failure. An element that never appeared is still a locator failure.
- 7510a6d: Requires bdd2pw 4.5.2 (4.5.1's fixes plus HTTP-worker support for them), which no longer writes `page.locator("")` or blanks a page object it cannot read. When bdd2pw cannot reach the application's pages (exit 4), the tool result now says so plainly (`cause: "discovery-failed"`) and tells the agent to fix the environment rather than the feature file.
- ad31edd: Requires bdd2pw 4.5.4, which no longer rewrites an existing Page Object on a re-scaffold when it cannot read the Page Object's locators back. On 4.5.2, a run that scaffolded a story could empty a shared Page Object that other specs still used.
- A failing test now gets three full runs with repairs. After that, the agent may not change it again, and the run ends with the test reported for a person to decide (a test problem or a possible defect) instead of spending the rest of its budget guessing. The final report lists these under "Needs your decision".

  The cap now counts repairs to each test (three edits to the test itself, each followed by a full run it still failed), not failing suite runs. Runs set off by a page-object or import change no longer use up the repairs of tests nobody touched. `fs.write_file` and `fs.replace_in_file` report `changedTests` for a spec, and `replace_in_file` writes a `$` in the new text literally.

- Requires bdd2pw 4.6.5 (a test with an unbound step is marked fixme instead of passing empty; repeated elements become list fields; a negative active-page rule; an active-page step checks all three common markers and waits for the page to update; pagination steps are no longer bound to opening the home page; accessibility steps use `AxeBuilder`; re-scaffold no longer touches or shrinks a page object a spec still uses; quoted text with `$` and digits, such as prices, is emitted unchanged) and pw-self-heal 1.3.0 (assertion and loading failure classes, `diagnose()`, offline candidate extraction).
- ad31edd: The design check now keeps a design's numbers in step with the feature file before anyone is asked to approve it. An item that one of the story's existing scenarios already tests must use that scenario's `@design` id; a scenario the story already has but the design leaves out is named; and a number another story owns in the shared epic file is refused with the next free one suggested. An accessibility item that covers the story now matches the story's existing scenario of the same type, instead of being treated as new. When a revised design is approved during an append-only completion, the plan is recalculated from that latest approval.
- cca0e4c: A test for a bug must be type "confirmation", and the design check now says so in those words. It used to say the item "is type confirmation", which made the agent change the type the wrong way, again and again (AB#1, 50+ submissions). Separately, the run now stops as blocked when the same design problem comes back on 6 submissions in a row, naming the problem, instead of spending the budget.
- 0b1b138: When several design items cover the same acceptance criterion, the approval screen now shows each item's own scenario — the one carrying its `@design` tag, or else one no other item has claimed — instead of reporting all of them as tested by the first match.
- A test whose steps bdd2pw left empty (a `[SKIPPED]` step or a `// TODO` from the generator) is no longer counted as passed. It is reported as "not implemented", the suite is not green, and the verifier lists the empty steps for the agent to implement. The verifier also counts the spec the suite ran as present, so a scaffolded spec is no longer reported as "no Playwright spec file exists".
- `expect.poll(…)` and `expect.soft(…)` now count as assertions everywhere the runtime reads a test's checks (the design-conformance check, the weakening guards), including when the chain is split across lines as bdd2pw's active-page rule writes it. A test whose checks were all `expect.poll` was sent back as having too few assertions. The accessibility-scope message now says how to build an `.include` selector from what the page snapshot shows.
- 11d6a32: A `test.fail` test that fails as its known bug says it should is now reported as `expected-failure` ("fails as expected — known bug reproduced") instead of `passed`, in the per-test rows, the run summary and the terminal line. Playwright's own pass count is unchanged.
- a58ca20: A spec write that wraps a step of a test in a fallback (`try/catch` or `.catch(...)`) is now refused when it is proposed, not only by the verifier at the end of the run. Only a fallback the write introduces is refused; rewriting a test to remove one is still allowed.
- `aqa run --fresh` (evaluation only) designs and authors a story from scratch: earlier runs and existing coverage are ignored. It stops at once, saying what to move aside, if the story's scenarios are still in the feature file — so a from-scratch measurement never runs over existing tests.
- 6b41189: Heal names the failing locator on a test timeout (the stuck action is read from Playwright's later error entry, not only the first "Test timeout" line) and matches accessible names ignoring spacing, case and punctuation, so a click waiting on "Log in" is pointed at the button named "Login". A Jira bug In Progress now counts as known broken, so its confirmation test is expected to fail, as an Azure DevOps Active bug's is.
- `aqa.heal_locator` no longer treats an assertion failure as a broken locator. When a test found its elements and an assertion about them failed, it now says there is nothing to heal and names the two test mistakes to rule out first (reading the page before its data loaded, and checking a state on the wrong element), instead of ranking unrelated links and suggesting the control "may genuinely be absent".
- 0b1b138: A test quarantined as a defect candidate can now have the locator inside its assertion healed — `expect(page.getByRole("button", { name: "Log in" })).toBeEnabled()` → `{ name: "Login" }` — when the new locator is one `aqa.heal_locator` offered from the page in this run. The matcher and its expected value still may not change, and a locator the heal tool never offered is still refused.
- 6b41189: The heal role is chosen for a "test that catches its own failure" only when the catch is in that test's own body, not anywhere in the spec (a `beforeEach` that dismisses a pop-up with `.catch(() => {})` no longer pulls every failing test into a five-tool heal). An edited `.feature` file no longer triggers an automatic suite run on its own: nothing executes differently until `bdd2pw.scaffold` regenerates the spec, and a scaffold now counts as a change.
- 1ced643: The agent's history now shows each call's key arguments (paths, urls, ids, modes; long text by length only), so two calls of the same tool can be told apart. Without them an agent that had analyzed its new feature file read the result as the old file's and analyzed it again until the run stopped (AB#1). The tag check also now says which tag to change: "(@design:D2) — replace @type:security with @type:functional" instead of "needs @type:functional", which the agent could not act on and rewrote the same tag line 16 times.
- A Jira bug proposal is no longer dropped as "not linked to the story": the check now reads the bug's `storyKey`, as Jira bugs carry it, instead of the Azure DevOps `parentId`. The agent is also told to assert with Playwright's retrying assertions rather than one-off reads of text or counts, which mistook a page still loading its data for a product defect.
- 60824d0: A new story whose tests go into a spec other stories' tests already fill no longer deadlocks. The route records `sharedSpec` when the epic's spec already has implemented tests; scaffolding stays refused (it would regenerate those tests), and the new story's tests are written by hand beside them — each tagged `@story:<id>` and `@design:<Dn>` — while every existing test keeps its assertions. The scaffold refusal now says that writing by hand is the next step.
- 7800b39: One broken selector shared by several tests is now one repair. `fs.replace_in_file` takes `all: true` to change every occurrence (judged by the rules as the write it amounts to); when `old` is not found, the error names the closest real line and says when the model escaped quotes the file does not have. `aqa.heal_locator` lists the other tests the last run lost to the same selector and says to fix them in one call. Triage recognises `waiting for getByRole(…)` and `element(s) not found` as a locator that matched nothing, not a possible defect at 0.1.
- While some tests are failing, a test that passed in the last full run can no longer be changed, unless the verifier named it as not matching its design. Before, repairs to one test regularly broke tests that were already passing.
- The agent's screenshots and page snapshots are saved beside the run's ledger (`.aqa/playwright/`) instead of in whatever directory `aqa` was started from. Messages that told users to run a non-existent `aqa init-framework` command now say to set up a Playwright project (`npm init playwright@latest`).
- 8d661ec: The Jira QA sub-task's description now gives each test case in BDD form: the Gherkin scenario its test is generated from (with the feature's Background), under a summary table of ID, criterion, type and scenario. A case whose scenario is not written yet shows its conditions and expected result until the next refresh. Cloud renders the scenarios as code blocks; Data Center as `{noformat}`.
- A failing test is quarantined as a possible product defect only when the verdict is confident and the test is proven: it passed earlier in the run, existed before the run, or is a known bug's test. A test written in this run that has never passed stays the agent's to check and fix. Triage, the edit guard and the verifier now share this one definition. Bugs are proposed only for quarantined failures, using the tracker's own bug tool.
- Repairs to a quarantined test are recognised more fairly. The same assertion read from a parent or child of the old element (for example a page marker that sits on the list item around a button) keeps the claim; the end-of-run check now sees in-place edits as well as whole-file writes and uses the same rule as the write guard; and a failure's evidence names its locator, so fixing one broken step and moving on to the next is no longer counted as the same failure twice.
- The approval for the Jira QA record and for a test run now reads as plain sentences: where it goes, what it changes, the test cases and this run's results, one per line (press `v` for the raw arguments). A state-transition test that performs no action at all is now sent back; it was let through as "nothing to check".
- A call the gate refused can be proposed again once something has happened since. Before, the agent analyzed a feature as told, proposed the scaffold that had been refused, and was told it had "already made this exact call", so the run stopped with no progress. The run now also says when the agent's browser was refused an origin outside `scope.urls` (for example an application's API on another port), since the page is then missing its data.
- ae7fb10: The replay report is headed "attestqa replay" (it still said "agentic-qa replay"), and the MCP client announces itself as attestqa.
- A test that works but checks less, or more broadly, than its approved design (a page-wide accessibility scan, a missing "took effect" assertion) no longer blocks the run forever. The agent gets one attempt to fix it; after that it is listed under "Needs your review" in the run report and in the Jira QA comment, and the run can complete. Broken or fake tests (failing, empty steps, a state change with no action, a design item with no test) still block. The Jira QA comment and its approval now show, for each test case, what the design expects beside what the test checks.

  When a reused design is checked against tests that already pass, the agent is now told up front which of them do not match the design and must change; before, it was told its only work was fixing failures, so a green suite with a wrong test ended the run with nothing done. The review note in the report and Jira comment is now one sentence.

- 18cfe0f: The runtime's own calls at the end of a run (the Jira results comment, held bugs) are judged against the skill's whole toolset, not the active role's — a run that ended with the heal role active had its results post refused as "unknown tool". Playwright's "Browser logs:" block (the full Chrome command line when an installed Chrome is used) is removed from failure messages before they are cut to length, so the locator a stuck action was waiting for reaches triage and heal.
- An address check is no longer refused when the design item does speak of where the browser goes ("returns to the home page", "is sent to the login page", "stays on /#/login"). Found by replaying every proposal of 36 recorded runs through all the rules; no rule turned out redundant. Key moments of two real runs are now kept as interaction tests.

  A scaffold proposed after the feature file was rewritten is now told to analyze the new file again, instead of being refused with the old file's unbound steps (which the agent read as a stale refusal and repeated until the run stopped).

- A run now stops, blocked and with the reason quoted, when the same call is refused five times for the same reason even though its arguments are reworded each time; before, it carried on until the token budget ran out. The rule that refuses an accessibility bug from an unscoped scan now applies only to accessibility bugs, not to every bug proposed while that scan was failing.
- A feature with steps bdd2pw cannot bind may be scaffolded after one round of rewording (a second analysis), with the remaining steps left as TODO for the agent to implement. Requiring zero unbound steps made the agent weaken scenarios until they bound, or deadlocked the run.
- A test that passed earlier in a run and fails only after the agent edited it is now classified as the test's fault, and a bug resting on it is dropped with that reason. A bug about AC-2 now matches a failing AC-2b test, and repeated proposals for the same failing test keep only the last. The state-transition check applies only to tests with an action, quotes the design item's expectation, and no longer suggests an address check; the design check sends back a state-transition item that names no action.
- 6b41189: A `test.step(...)` or `test.describe(...)` is no longer read as a test. Every rule that reads a spec by test (coverage, the weakening and append-only rules, heal, the role choice, the scaffold-overwrite guard) now sees each test's whole body and the right test count.
- A run's tests are only built on when that run finished and ran its suite after its last change. Tests left on disk by a run that was stopped earlier are executed but treated as new (repaired, never frozen as proven), and its design is asked for again rather than reused. Tests still failing when the reused run ended are likewise repaired rather than frozen. A state-transition design item must say both what shows the action took effect and the state it leaves. The QA record now reads results from full suite runs only, matching the terminal report.
- 11d6a32: When a test catches its own failure, the verifier now quotes the offending line and says how to remove it, and says a green suite does not close the gap. The terminal shows the whole first sentence of a gap, including what follows a colon, instead of stopping at the colon.

All notable changes to this project will be documented in this file. Format: Keep a Changelog;
versioning: SemVer. Any change to the contract (PLAN §0: CLI flags, exit codes, env vars,
config schema, ledger event shapes, approval file mode, artefact paths) is a MAJOR bump.

## [Unreleased]

### Renamed — `@vijaypjavvadi/agentic-qa` is now `attestqa`

- The package is published as **`attestqa`** from 1.1.0. The old name stays on the registry
  as a shim that depends on `attestqa` and forwards the `aqa` command, so existing installs
  keep working; it is marked deprecated with a pointer here. The GitHub repository is renamed
  in place (GitHub redirects the old URL; the Zenodo concept DOI is unchanged).
- What does NOT change: the `aqa` command (a second `attestqa` command is added beside it),
  the ledger's `tool: "agentic-qa"` field — the corpus is frozen under that name and every
  earlier ledger carries it — the config schema, the exit codes and the artefact paths.
- Why the name: the runtime's distinguishing property is that it attests. Its report is
  counted from a replayable ledger rather than from the model's account of its own work, and
  the name should say so. "Agentic" describes the category; "attest" describes the claim.

### Added — the model is a provider, not a dependency

- **`agent.model.provider`** in `ai-quality.config.yaml`: `anthropic` (the default),
  `openai`, `azure-openai` or `local`. The original string form (`model: claude-sonnet-4-6`)
  still loads and still means Anthropic, so every existing config and every ledger in the
  corpus is unchanged. Set once per environment; the credential comes from the environment
  where the runtime runs — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, or
  none for `local` — and never from the config file. `AQA_MODEL` overrides the name, never
  the provider.
- **`src/runtime/openai.ts`**: one OpenAI-compatible chat-completions adapter for OpenAI,
  Azure OpenAI and local servers (Ollama, vLLM, LM Studio). Same `renderCycle`, same
  `RUNTIME_SYSTEM`, same wire names, same `scrub`, same stance: no provider-side
  conversation — the ledger is the memory whichever model is reading it. No SDK; one `fetch`.
- **`src/runtime/provider.ts`**: the one place a provider name becomes a model client. A
  missing credential names the variable, not the symptom.
- **`inference.provider`** on the ledger (additive, optional): absent on every ledger written
  before this, which were all Anthropic; present from now on so a corpus run on a second
  model is distinguishable without reading the model name.
- Why: every run in the corpus used one provider through one SDK, so "governance works"
  could be read as "one model respects refusals"; and a company standardised on GitHub
  Copilot has no Anthropic account. The seam answers both.

### Changed

- `AgentConfig.model` is a `ModelConfig` object rather than a string. The YAML accepts both
  forms; library callers reading `config.model` directly get `{ provider, name }`.
- The terminal's credential line names the configured provider's variable rather than
  assuming `ANTHROPIC_API_KEY`.

## [1.0.0] - 2026-09-18

First version under the stated contract. `EVENT_KINDS`, the ledger event shapes,
the CLI flags, the exit codes and the artefact paths are now things to depend on,
because the VS Code extension and the platform read them and Paper I's figures
are counted from them. Adding an event kind after this is a major bump.

### Added — failure triage

- **`src/triage/`: what kind of red this was.** A run that goes red gets its
  failures classified before anything decides what to do about them. Five
  categories, ported from `defect_analysis/engine/classifier.py`:
  `infrastructure`, `environmental`, `flake`, `real-defect`, `expected-failure`.
- **The port is a mirror, not a rewrite.** Each pattern keeps its Python source
  text and is compiled at load, so divergence between the two implementations is
  a string comparison rather than behaviour nobody noticed changing. The
  algorithm is scored, not first-match: each bank scores as the fraction of its
  patterns that matched, and the precedence order only breaks ties. A
  reimplementation that walked the precedence list would have been a different
  classifier wearing the same category names.
- **Contagion.** `environmental` and `infrastructure` invalidate every other
  result in the run: if the application was not serving, nothing was measured,
  and a `real-defect` verdict elsewhere in that run is not evidence of anything.
  The other three categories say something about one test and nothing about any
  other. This distinction is agentic-qa's, not the service's — a dashboard never
  has to decide what a verdict implies about its neighbours; a loop does.
- **Contagion requires evidence.** A failure over a minute long with no
  recognisable error reaches `infrastructure` on the duration boost alone. That
  is faithful to the Python and harmless there. Here it would write off a whole
  run, so the run-level verdict additionally requires that a pattern actually
  matched. A stopwatch is not grounds for the strongest claim triage can make.
- **Quarantine.** A test triaged `real-defect` may not be edited, and the rule is
  enforced by a check rather than an instruction: the failing test and its exact
  error are recorded, and a later attempt where it no longer fails the same way
  raises `quarantined-test-modified`. "It passes now" and "the assertion was
  relaxed" look identical from inside the run, and only one of them is good news.
- **The suite always runs to completion.** Triage never stops execution; what it
  can stop is the agent's edit-and-rerun loop. Twenty-nine other results cost
  nothing extra to collect and are worth having.
- **New gaps:** `sut-unavailable`, `harness-unusable`, `product-defect-suspected`
  (one per candidate), `quarantined-test-modified`. `suite-not-green` is
  suppressed when triage produced a more specific gap — it restates the exit code
  where the others name the fix.

### Changed — what running the real reporter showed

The unit tests above used Playwright JSON that I wrote by hand. Running the
actual reporter against a deliberately broken suite produced three verdicts and
all three were wrong, for reasons no synthetic fixture would have contained.

- **ANSI colour codes.** Playwright writes assertion diffs coloured, so a real
  `toBe` failure arrives as `Error: \u001b[2mexpect(\u001b[22m...`. The escape
  sequences sit between the words the patterns look for, and the evidence string
  a human reads came out as garbage. Messages and stacks are now stripped before
  matching.

- **The retry boost fired on every failure.** classifier.py nudges toward
  `flake` when `retries > 0`, and its comment says it means "retries WITH A
  SUBSEQUENT PASS HISTORY" — but the code only checks the count. Under
  Playwright, `retries: 1` in the config makes every failing spec report one
  retry regardless: the real report showed `results: failed,failed` on all three
  failures. At +0.25 that boost outscores most pattern banks, so a plain
  `connect ECONNREFUSED` — an outage, the most consequential verdict there is —
  came back classified `flake`. Worse, the count carries the opposite evidence
  to the one claimed: a test retried that failed again is _less_ likely to be a
  flake, and a test that is flaky by Playwright's own definition never reaches
  this code at all, because its spec is `ok: true`. `FailureSignal.flakyHistory`
  now makes the Python's stated condition explicit. **Documented deviation.**

- **The ported banks barely match Playwright.** They were tuned on Defects4J and
  BugsInPy — Java and Python phrasing. Playwright says `Timeout 5000ms exceeded`
  where the ported flake patterns want `timed out after 5000 ms` or `wait for`;
  it says `expect(received).toBe(expected)` where the real-defect bank wants
  `AssertionError`. A textbook flake and a clean assertion failure both scored
  zero. `PW_BANKS` adds Playwright-native patterns as a **separate** bank, scored
  independently with the higher score winning — appending to the ported lists
  would have changed every ported score, since scoring is a fraction of bank
  size, and made the two implementations disagree by arithmetic rather than by
  judgement. **Documented deviation.**

- **Evidence is the failure's own words.** It was the matched pattern fragments,
  which on a real failure read `expect(received). · Object.is equality ·
expect(received).toBe` — three pieces of one sentence, none of them the useful
  part, while the message itself said `Expected: 90` and `Received: 100`. That
  string is what gets quoted into a bug report. Which patterns matched is still
  recorded in `matchedPatterns`, where a machine can find it.

Six regression tests now carry real reporter bytes.

### Fixed — triage ran too late to stop anything

The first implementation put triage inside the verifier. The verifier only runs
when the model declares the goal reached — so on a run where the model keeps
repairing, it never runs at all.

Observed on run `20260918T154354Z-1f5d7538` against a live Juice Shop: 33
inferences, four `pw.run_tests`, fifteen rewrites of one spec, **zero triage
events**. The suite reported `4 passed, 1 failed` identically all four times
while the agent rewrote the spec around the one failure. That is exactly the
scenario triage exists for, and triage was structurally unable to see it. A stop
rule that can only speak after the loop has ended is not a stop rule, and the
claim that this turns a 76-inference run into ~10 was false as shipped.

- Triage now runs **after every cycle**, from the loop, not from the verifier.
- `TriagePayload.reportFingerprint` (contract, additive) — a content hash of the
  execution report. Re-triaging an unchanged report is a no-op, so a per-cycle
  call cannot flood the ledger, inflate `attempt`, or make the quarantine check
  compare a report against itself. The loop therefore needs no knowledge of
  which tool produces a report or when.
- `triageAction()` gives the loop a decision in terms it can act on without
  knowing anything about defects: **stop** when nothing was measured; **stop**
  when every remaining failure is a product defect or a known failure, since the
  only route to green from there is to damage the evidence; otherwise **carry
  on**, with the quarantined tests named in the next context.
- `ScriptedVerifier`'s triage script no longer repeats its last entry — past the
  end it returns `undefined`, mirroring an unchanged report.

On the observed run this would have stopped at the second `pw.run_tests`:
roughly 12 inferences instead of 33, with the failing test named as a defect
candidate instead of rewritten fifteen times.

### Fixed — the execution report was written once and never again

`PwTools` persisted `.aqa-report/playwright.json` only when no file was already
there, guarded with `!existsSync(reportAbs)`. The first run a workspace ever did
froze the file; every run after it left the stale copy in place. In
`examples/sandbox` a report from 14 September saying "5 passed, 0 failed" was
still on disk on 18 September while the live suite reported 4 passed, 1 failed —
so triage read a green report, correctly found no failures, and said nothing,
across three suite runs. The comment above that line claimed the write made the
run's raw evidence "as durable as its conclusions"; it made it permanently wrong.

Now always overwrites: that file is the current call's evidence, and anything
already there belongs to a run that is over.

The failure mode is the dangerous kind — not a crash, but silence that reads as
agreement — so the verifier now catches the whole class. `failures-not-triaged`
fires when the suite reports failing tests and triage classified none, whatever
the reason: missing report, stale report, unreadable report. The verifier is the
only place that sees both the suite's own count and what triage made of it.

### Added — a failure that reproduces is not a flake

`flake` means one thing: it would pass if you ran it again. A failure that comes
back with identical evidence after the agent edited the spec and re-ran has
falsified that claim by the definition of the word. No pattern bank can see
this — every bank reads one message in isolation — and neither can the service,
which classifies one failure at a time with no memory of the previous attempt.
Only the run's own history has it.

`applyRepetition()` re-classifies a repeated `flake` as `real-defect` at LOW
confidence. That is not a claim that the product is broken; it is a claim that
the failure has stopped being the agent's to fix by guessing. Quarantine stops
the rewriting, the failure becomes a defect candidate, and a person decides
whether the product or the test is wrong — the decision that actually needs a
human, with bug filing gated on their answer.

Related, and deliberately NOT "fixed": the real-defect pattern
`to(Be|Equal|Contain|Match)\b` does not match `toBeVisible`, `toBeEnabled` or
the rest of Playwright's waiting-assertion family. Widening it was the obvious
move and would have been wrong — `expect(locator).toBeVisible()` timing out means
either the product never rendered the element or the test is looking for the
wrong one, and no regular expression can tell which. That ambiguity is settled by
repetition, not by a pattern. The boundary now carries a comment saying so, since
it reads like an oversight.

### Measured — run 20260918T161031Z-b0686ec0, live Juice Shop

The first end-to-end run with triage working:

|                      | before triage                   | with triage                           |
| -------------------- | ------------------------------- | ------------------------------------- |
| inferences           | 33                              | **19**                                |
| suite runs           | 4                               | 2                                     |
| rewrites of the spec | 15                              | **1**                                 |
| outcome              | budget spent, nothing concluded | `blocked`, one defect candidate named |

The progression is the designed one, and it happened without being scripted:

1. Suite red: 4 passed, 1 failed on AC-1.
2. Triage #1 — `flake` at 0.167 on `expect(locator).toBeVisible() failed`.
   Ambiguous on sight, so the agent is allowed one repair attempt.
3. The agent investigates the live page with the browser tools and rewrites the
   spec once.
4. Suite still 4/1, but the failure has changed shape, so the report fingerprint
   changes and triage runs again.
5. Triage #2 — `real-defect` at 0.4 on
   `expect(page).not.toHaveURL(...) Expected pattern: not /#\/login/`.
   Quarantined, run stops, candidate reported.

### Added — defect candidates become proposed bugs, on approval only

The rule is the operator's: **any Playwright or environment failure is re-run once; if
it fails again it is real, and the user is asked whether to create a defect; if they say
no, it ends there.**

- **Triage no longer ends a run.** Its first verdict in a run is never acted on: it asks
  for one clean re-run of the suite, unchanged, and forbids editing a spec, selector,
  timeout or config value first — an edit makes the two runs incomparable and destroys
  the only evidence separating a flake from a defect. This replaced an immediate stop on
  `environmental`/`infrastructure`, which decided on the operator's behalf that an
  unreachable application could never be worth filing. That is a judgement about the
  product and it belongs to a person.
- **A failure that survives the retry becomes a proposed Bug.**
  `ado.wit_work_item_write` action `create`, `workItemType` "Bug", classified
  `write_record` → the gate asks. Deny is final: the instructions forbid rewording it,
  retrying it, or opening it as another work item type.
- **New governance capability: `ActionDescriptor.requireArgIn`.** Confines an action to
  named argument values — here `workItemType ∈ {Bug}`. A disallowed value is REFUSED,
  not raised to `ask`: a reviewer approving something the manifest never meant to permit
  is answering the wrong question, and their yes would be indistinguishable from a yes to
  the intended case. `update`, `update_batch` and `add_child` stay unlisted, so the agent
  still cannot edit fields on an existing work item — acceptance criteria remain a
  human's to write.
- **Bugs must say what was RULED OUT.** Not what the agent saw — what it checked that
  would have made this _not_ a defect, and what that check said. Confidence follows from
  that paragraph; no named check means "nothing ruled out" and low confidence.
  Prompted by a real proposal that claimed "Confidence: High that this is a product
  defect" while its own repro steps opened "Enter a REGISTERED user's email" — a
  precondition asserted and never tested. A 200 from the login endpoint makes it a
  defect; a 401 makes it a fixture problem and no bug at all, and the two are
  indistinguishable from outside.

**The unchanged retry is instructed, not enforced — deliberately.** Nothing in the gate
stops the agent editing a spec between the failed run and the retry. Decided against on
2026-09-18: the instruction held on the first real run (`20260918T170400Z-4683360d` made
two `pw.run_tests` calls with no `fs.write_file` between them), and enforcement would
cost a gate rule guarding a case that has not happened. The quarantine check still
catches the specific harm. Revisit if a run is observed editing before its retry.

### Measured — run 20260918T170400Z-4683360d, live Juice Shop, deny path

|                      | this morning | now                                         |
| -------------------- | ------------ | ------------------------------------------- |
| inferences           | 33           | **15**                                      |
| suite runs           | 4            | 2 (one is the mandatory retry)              |
| rewrites of the spec | 15           | **0**                                       |
| test cases           | 0            | 4, and **not** re-created on the second run |

The agent re-ran the suite with nothing edited between the two runs, proposed one bug,
had it denied, and wrote: _"per policy, this is the end of the matter and no further bug
is filed."_ It did not reword it or retry under another type.

### Added — contract

- **`triage` event kind**, with `attempt`, `runLevel`, `verdicts[]`,
  `quarantined[]` and optional `disagreements[]`. Its own kind rather than a
  field on `verify`, because triage runs more than once per run (a flake verdict
  means a retry) and because the quarantine check reads back what an earlier
  attempt recorded. A run from before this version has no `triage` line, which is
  the correct answer to "what did triage decide", not a missing field.
- `Verifier.triage?()` — optional, runs before `verify`, and the loop writes its
  result to the ledger. Verifiers do not write to the ledger; the loop does.
- `aqa replay` renders triage in the timeline and adds a **Defect candidates**
  section, or a **Nothing was measured** section when the run was written off.

### Added — the defect analysis service, as an upgrade

- `DEFECT_ANALYSIS_URL` unset (the default) means triage runs entirely
  in-process and **nothing leaves the machine**. Set, failures are POSTed to the
  service and its verdicts win where it answered.
- The service can never fail a run: a timeout, a non-200, a malformed body or an
  out-of-vocabulary category all fall back to the built-in verdict already in
  hand, and the report says the run's verdicts did not all come from one
  classifier.
- Disagreements between the two are **recorded, not resolved** — they are the
  training signal for the service and the drift alarm for the port, and they are
  the one thing two implementations buy that one does not.
- The URL is read from the environment and only from the environment. An
  endpoint the agent could nominate from a work item or a tool result would be
  an exfiltration path with a helpful name.

### Added — tests

- 48 tests for the triage module: the first unit tests for any defect-side code
  in this project. One of them found a real interaction on the day it was
  written (the duration-boost/contagion collision above).

### Fixed

- A backtick inside a template literal in `src/skills/story-to-tests.ts` broke
  the build. Second occurrence of this exact class.

### Docs

- `docs/DESIGN_triage.md` — the design, including the three questions it closed
  and what changed after the first draft got the algorithm wrong.
- `docs/VERSIONS.md` — what is released where, and the release order.
- `docs/ADOPTION.md` — a data-egress section, since this is the first feature
  that can send anything outside the workspace.

### Added (A10 — prompt caching)

- **Cache breakpoints on the tools block and the system prompt.** Both are
  byte-identical on every cycle of a run and are most of what a cycle sends — a
  fix → run → fix cycle costs roughly 14k tokens, the bulk of it the fixed tool
  schemas. Assembling each cycle from the ledger rather than continuing an
  API-side conversation is what makes a run replayable; re-sending that prefix
  every cycle was the price of the property. Caching removes the price without
  touching the property.
- **Contract, additive and optional:** `InferencePayload.usage.cacheReadTokens`
  and `.cacheCreationTokens`, written only when the provider reports prompt-cache
  accounting. Absent is not zero — a zero says the prefix missed, absent says the
  provider does not report caching — and keeping them off the payload otherwise
  is what leaves the golden fixture unchanged.
- `aqa replay` reports cache reads as a share of input, and omits the clause
  entirely when nothing was cached. Counts, not money: the price per token is
  not this project's to assert, and a run report that quotes a figure it cannot
  derive from its own ledger is the kind of claim the verifier exists to stop.
- A test asserts the tools and system bytes are identical across two cycles.
  The saving depends entirely on that, and a change that reordered tools or
  rewrote the system prompt per cycle would fail no other test — it would just
  quietly stop the cache from hitting.

### Fixed (A10 — a model call had no bound)

- **A stalled model request hung a run indefinitely.** Every other wait here is
  bounded — the step and token budgets, `--approval-timeout`, the adapters'
  command timeouts — but the Anthropic call was issued with no timeout and no
  retry bound, so a connection that stopped responding never returned control to
  the loop. Observed on run `20260915T222657Z-73bb1bab`: the ledger's last event
  is a `context` at 22:44:17 and nothing followed it for 26 minutes.
  `DEFAULT_TRANSPORT` now sets a 5-minute timeout and 2 retries, configurable per
  model via `AnthropicModelOptions.transport`.
- The worse half of that defect was evidential rather than operational. A hung
  request writes no event, so the ledger — the one artefact this project relies
  on to explain a run — recorded only that a cycle had been assembled, and the
  reason for the silence was not in it. A timeout turns silence into a recorded
  failure, which is the property that was actually missing.

**Measured** on run `20260915T222657Z-73bb1bab`, 76 inferences: 75 of them hit the
cache — only the first missed, which is the write — and the cached prefix was
exactly 6,282 tokens every time, confirming the tools and system bytes really
are identical across cycles. Input-token-equivalents fell from 1,654,057 to
1,231,592, a **25.5% reduction**.

The shape of the saving matters more than the total. An early cycle sends 3,445
real tokens against 6,282 cached — **57% cheaper**. A late cycle sends 25,974
against the same 6,282 — **17%**. Caching removed the cost that was constant and
left the cost that scales: the message content, which grows with the run's
history and cannot carry a breakpoint while it is assembled as a single string.
Splitting it so the stable sources sit ahead of the growing history is the next
move, and this run is the evidence for it.

Also observed: a **260-second gap** between two inferences, across a suite run,
and the cache still hit — 4.3 minutes against a five-minute window. It survived,
barely. A slower suite would miss, which makes the one-hour TTL a question with
evidence behind it rather than a guess.

## [0.1.2] — 2026-09-15

### Fixed

- **Documentation claimed the ledger was scrubbed of secrets. It is not, by design.** Five places
  across four documents said credentials were "redacted on the way in" and that a ledger could be
  shared without review. `scrub()` is applied to model input and to stderr, and deliberately **not**
  to ledger observations — tool results are stored verbatim because redacted evidence is not
  evidence, a decision the code has always carried in a comment. The docs now state the real
  position: no prompt text, no PAT, but whatever the tools returned. Found by auditing
  `ARCHITECTURE.md` against the source rather than against memory.

### Added

- `ARCHITECTURE.md` §8b — why tools arrive over MCP at all, why both servers are pinned, why the
  Azure DevOps server forced per-action classification, why the browser server is deliberately
  half-used, and why six adapters are in-process.
- A statement of what the `bdd2pw`, `synthdata` and `tcg` adapters actually are. They carry the
  names of separate projects of the author's and none is a dependency: `bdd2pw` is reimplemented
  here, `synthdata` is invoked as a subprocess, `tcg` is a remote service. Enabling `tcg` sends the
  story and its acceptance criteria to `TCG_URL`, which is a data-egress decision and is now named
  as one in `ADOPTION.md`.
- `FUNCTIONAL.md` — "What provides each capability": both MCP servers with their pinned versions and
  all six adapters with their real tool names.
- README — "What it is built on", so the runtime's actual composition is visible without opening
  `TECHNICAL.md`.
- A VS Code extension under `extension/`, versioned and released separately. It answers approvals
  through the existing `--approval file` contract and renders the ledger as a browsable tree. Not
  part of this package: `files` is an allow-list and does not include it.

## [0.1.1] — 2026-09-14

### Fixed (found by the pre-publish tarball check)

- `aqa --version` reported `0.1.0-dev.0`. The version was a string literal in `src/cli.ts`, so
  `npm version` bumped `package.json` and left the CLI reporting the last value anyone typed. It is
  now read from `package.json` at runtime, and a test asserts the two are equal. The test that
  should have caught this matched `/0\.1\.0/`, which `0.1.0-dev.0` satisfies — a substring assertion
  on a version number is not an assertion. Found by installing the tarball into a clean directory,
  which is the only step that exercises the package as a user receives it.
- The `files` allow-list shipped `docs/` wholesale, putting eleven internal `HANDOFF_*.md` notes and
  a 272 kB observed-tool dump into the tarball — more than half its size. The seven user-facing docs
  are now listed individually, so a working note added to `docs/` cannot silently join a release.

### Added

- `docs/ADOPTION.md` — what a team has to change before this is useful, who does it, and in what
  order.

## [0.1.0] — 2026-09-14

First public release. One skill — `story-to-tests` — working end to end against a live Azure DevOps
project and a real application, with the governance gate, ledger, replay and verifier behind it.

Packaging: `publishConfig.access: public` stated explicitly, documentation shipped in the tarball,
and `prepublishOnly` now runs lint as well as typecheck, tests and build.

Everything below is the development history that produced it.

### Added (A0 — scaffold)

- Package scaffold: `@vijaypjavvadi/agentic-qa`, TypeScript strict, tsup (ESM+CJS+d.ts), vitest,
  ESLint flat config, Prettier, MIT, CITATION.cff, SECRETS-CHECKLIST.md, CI matrix (node 18/20 ×
  ubuntu/windows).

### Added (A1 — types, ledger, replay, fixture)

- `src/types.ts`: contract types — 11 event kinds, 5 policy classes, decisions, run status and exit
  codes, config schema, `Skill` and `Verifier` interfaces.
- `src/ledger/ledger.ts`: append-only JSONL `Ledger` (flush per event, resume-safe numbering),
  strict parser with line-numbered `LedgerFormatError`, monotonic/same-run checks.
- `src/ledger/replay.ts`: `renderLine` (stable one-liners for the platform run page),
  `computeStats`, `renderMarkdown`.
- `src/cli.ts`: `aqa replay <path> [--out]`, `--version`, `--help`; `aqa run` stubbed until A2.
- `examples/fixture-ledger/`: 34-event synthetic story→tests→Test Plans run covering every kind,
  `make-fixture.mjs` generator, `emit.mjs` streamer with `--approval file` wait for the platform
  track, README.
- Tests: 27 (ledger, parser, replay, CLI).

### Added (A2 — loop with scripted model and stub tools)

- `src/runtime/loop.ts`: plan → act → observe → verify cycle with stop rules (done / blocked /
  refused-fed-back / budget / error), step and token budgets, one batched approval per cycle,
  refused and denied calls fed back to the model as history, `summary.md` written at `end`.
- Interfaces + test doubles: `ModelClient`/`ScriptedModel`, `ToolClient`/`StubTools`,
  `Approver`/`ScriptedApprover`, `Verifier`/`ScriptedVerifier`, `Clock`/`SteppingClock`,
  `ContextBuilder`/`BasicContextBuilder` (hashes + token estimates only).
- `src/governance/policy.ts`: `Gate` interface and `TableGate` (class from the tool manifest,
  decision from the policy table; unknown or non-allow-listed tools are destructive → refuse).
  Scope checks and argument inspection arrive in A3.
- Fixture is now GENERATED by the loop (`examples/fixture-ledger/scenario.ts`,
  `npm run fixture:make`); the golden test asserts byte equality and CI fails on drift.
  Fixture grew from 34 to 42 events (one `context` event per cycle; one `policy` event per call).
- Tests: 41.

### Added (A3 — gate hardening, approvers, scrub)

- `ScopedGate` (design §7): class raised for destructive tool names and protected branches
  (`main`, `master`, `release`, `production`, `prod`); scope allow-list checks on work item, repo,
  test plan and branch arguments declared via `ToolDescriptor.scopeArgs` (exact / numeric range /
  glob; `"*"` only in sandbox mode); out-of-scope → refuse regardless of the policy table.
- `TerminalApprover` (`--approval terminal`, default No) and `FileApprover` (`--approval file`:
  writes `approvals/<id>.json` with `decision:null`, polls, 30-minute timeout → denied by
  "timeout"). Both injectable for tests.
- `scrub()` local redaction rules (Anthropic/OpenAI/AWS/GitHub keys, bearer tokens, basic-auth
  URLs, PAT/password assignments, ADO PAT shapes, email, IPv4, SSN, card) and `mask()` for logs.
- Fixture regenerated: scenario now uses `ScopedGate`; reasons carry scope notes
  (e.g. "read-only; work item 1 in scope"). Still 42 events, no shape change.
- Tests: 85.

### Added (A4 — real MCP client, config, discovery)

- `src/config.ts`: `loadAgentConfig` (JSON or YAML `ai-quality.config.yaml`, PLAN §0 schema,
  defaults + clear `ConfigError`s), `loadDotEnv` (never overrides existing env), `readRuntimeEnv`
  (ANTHROPIC_API_KEY, AZURE_DEVOPS_ORG_URL/PAT/PROJECT, AQA_MODEL, AQA_SANDBOX, TCG_URL,
  AI_GOVERNANCE_URL, SYNTHDATA_CMD).
- `src/mcp/client.ts`: `McpToolClient` over `@modelcontextprotocol/sdk` (stdio transport, one
  session per server, lazy connect, `listTools` → qualified `ToolDescriptor`s classified via the
  manifest, `callTool` → normalised `{ok,result,artefacts}`, errors never throw), `CompositeTools`
  to merge MCP servers with in-process adapters. SDK imported lazily so tests need no network.
- `src/mcp/manifest.ts`: governance manifest (qualified tool → policy class + scopeArgs). Unknown
  tools are `destructive` → refused. Only `fs.*` is filled in; `ado.*`/`playwright.*` are added in
  A5 from `docs/tools-observed.md`, not from memory.
- `src/mcp/servers.ts`: specs for Microsoft's `@azure-devops/mcp` (PAT via env, never argv) and
  `@playwright/mcp --headless`; versions from `AQA_ADO_MCP_VERSION` / `AQA_PLAYWRIGHT_MCP_VERSION`
  or `latest` until pinned after discovery. `npx.cmd` on Windows.
- `src/mcp/adapters/fs.ts`: workspace-bounded `fs.read_file` / `fs.list_dir` / `fs.write_file`
  (path-escape refused).
- `aqa discover [--servers ado,playwright,fs] [--out docs/tools-observed.md] [--env .env]
[--workspace .]`: connects, lists tools, writes a Markdown + JSON report of real names, schemas
  and classification status, closes servers.
- `aqa run "<request>" --config <file> --dry-run`: loads config + env, connects, prints each tool
  as `class → decision`, makes no model or tool calls. Non-dry-run exits 1 until A7.
- `examples/ai-quality.config.yaml`: the sandbox config (work item 1, `agent/*` branches).
- Dependencies: `@modelcontextprotocol/sdk`, `yaml`.
- Tests: 113.

### Added (A5 — per-action governance, adapters)

- **Per-action classification.** Microsoft's Azure DevOps MCP server multiplexes operations behind
  an `action` argument and mixes reads with writes under one tool name (`wit_backlog` does `list`
  and `reorder`; `wit_work_item_link_write` does `link` and `unlink`). `ToolDescriptor` gained
  `actionArg` + `actions`, `ManifestEntry` the same, and `resolveAction()` resolves a call to one
  operation before the gate classifies it. An action absent from the manifest is refused exactly
  like an unknown tool; a missing `action` argument is refused rather than guessed.
- `DEFAULT_MANIFEST` filled in from `docs/tools-observed.json` (67 tools, 2026-09-12): 13 Azure
  DevOps read actions/tools, 6 write_record actions (test case / suite / plan create, add cases,
  update steps, work item comment), 1 write_branch tool, 6 observational Playwright tools. Every
  name is checked against the recorded schemas by a test — nothing is admitted from memory.
- Gate: destructive-by-name now also inspects the ACTION name, and `unlink` / `remove` joined the
  destructive patterns. Scope arguments may be lists (`ids: [1,2]`) and every element must be in
  scope.
- In-process adapters: `bdd2pw` (Gherkin → Playwright spec skeleton; `Scenario Outline` rows
  expanded; every generated test is `fixme` so an unimplemented skeleton can never report a pass),
  `pw` (runs the suite, parses the JSON reporter, `green` requires zero failed AND zero skipped),
  `tcg` (POSTs to `TCG_URL`, which is the full endpoint), `synthdata` (runs `SYNTHDATA_CMD` with no
  shell). All external I/O is injected, so the suite spawns nothing and makes no requests.
- CLI: `--servers` learned `bdd2pw`, `pw`, `tcg`, `synthdata` (the last two opt-in, requiring
  `TCG_URL` / `SYNTHDATA_CMD`); default is now `ado,playwright,fs,bdd2pw,pw`. `run --dry-run`
  prints one line per classified action with the argument each still needs.
- `examples/sandbox/features/login.feature` — AB#1's four acceptance criteria as a feature file,
  for exercising bdd2pw and pw without touching Azure DevOps.
- Pinned `@azure-devops/mcp@2.10.0` and `@playwright/mcp@0.0.80` (the versions discovery recorded).
- Tests: 144.

### Added (A6 — skill, verifier, context ordering)

- `src/verify/evidence.ts`: reads the ledger into `CallRecord`s by pairing `call` with
  `observation` events. A call with no observation (refused, denied, or cut short) never appears,
  so a refused write can never be mistaken for a completed one.
- `src/verify/story-to-tests.ts`: `StoryToTestsVerifier` decides "done" from six observed facts —
  story read, spec file present on disk, suite run green (zero failed AND zero skipped), cases
  created, every case carrying `testsWorkItemId`, cases in a suite. Each failure is a `Gap` whose
  `evidence` records what WAS seen, distinguishing not-attempted from attempted-and-failed.
  `minCases`, `requireGreenSuite` and `requireSuiteMembership` are configurable.
  `parseWorkItemRef()` pulls "AB#1" / "#1" / "work item 1" out of a request.
- `src/skills/story-to-tests.ts`: the slice-1 skill — instructions (goal, the verifier's checks
  stated as not the model's to decide, method, the `action` calling convention, working rules),
  the 14 tools it may see, and the source tools. Tests assert the instructions name only actions
  the manifest admits and only tools it classifies, so skill and governance cannot drift apart.
- `src/runtime/context.ts`: `OrderedContextBuilder` (design §6) — primary sources ordered ahead of
  step history and trimmed last, newest steps kept when over cap, tool schemas never trimmed, and
  gate feedback never trimmed at any size (dropping it makes the model re-propose refused calls
  until the budget dies). Now the loop's default; `BasicContextBuilder` remains for tests.
- Contract, additive only: `ContextPayload.sections[].dropped` and `ContextPayload.droppedItems`
  (optional, present only when trimming happened); `Skill.sourceTools` (optional). The `context`
  event now reports a `sources` section alongside `history` — the fixture shows sources growing to
  a plateau while history grows, which is the shape the run page should render.
- Fixture regenerated (still 42 events) with `sourceTools` declared.
- Tests: 177.

### Added (A7 — Anthropic model adapter, live runs)

- `src/runtime/anthropic.ts`: `AnthropicModel` over the Messages API. Tool descriptors become
  tool-use definitions; the qualified name `ado.wit_work_item` is mapped to `ado__wit_work_item`
  because the API only accepts `^[a-zA-Z0-9_-]{1,128}$`, and mapped back on the way in, so the
  ledger keeps the qualified name. Each tool's description states its governance class and, for
  multiplexed tools, exactly which `action` values are permitted — the model learns the boundary
  from the tool definition instead of by being refused. A tool name the model invents is dropped
  with a warning rather than passed to the gate.
- `RUNTIME_SYSTEM`: the runtime's own instructions (what a cycle is, what the gate does to a call,
  that the verifier decides done), sent ahead of the skill's. The adapter deliberately does NOT
  keep an API-side conversation with tool_result turns: every cycle is a fresh request assembled
  from the ledger, which is what keeps a run replayable.
- `scrub()` is applied to the system prompt and every message before it leaves the process, and to
  adapter warnings on stderr.
- `aqa run` without `--dry-run` now runs: `--work-item` (or "AB#1" parsed from the request), scope
  checked before a token is spent (out-of-scope exits 3), ledger under `--ledger`, `--approval
terminal|file`, and the loop's status as the exit code. `ToolingDeps.buildModel` injects a model
  for tests.
- Contract, additive: `InferencePayload.note` records the model's own words when it declares the
  goal reached, so the ledger shows the claim beside the verifier's verdict.
- Dependency: `@anthropic-ai/sdk` (lazy-imported; the suite never loads it).
- Fixture regenerated (42 events; context sections now mark sources, inference records the note).
- Tests: 196.

### Added (A8 part 1 — URL scope, browser tools)

- **Contract change (PLAN §0.3):** `agent.scope.urls` — where the agent may point a browser. An
  entry may be an origin (allowing every path under it), a path prefix, or a glob; `"*"` only in
  sandbox mode. Empty means the agent may not browse at all. Existing configs must add the key.
- `matchesUrl()` matches on the parsed origin plus path, so a differing scheme, host or port is out
  of scope and a userinfo prefix (`http://localhost:3100@attacker.example`) cannot sneak through a string
  test. `ScopeArgs.url` carries the argument name; `ScopedGate` checks it before the class table.
- Playwright browser tools classified — **exploration only**. `browser_navigate` (scope-checked),
  `browser_navigate_back`, `browser_snapshot`, `browser_find`, `browser_wait_for`,
  `browser_take_screenshot` and the console/network readers are admitted. Everything that OPERATES
  the page — click, type, fill_form, press_key, select_option, hover, drag, drop, file_upload,
  handle_dialog — stays unclassified, so the only thing that ever interacts with the application
  under test is the suite the agent writes. `browser_evaluate` and `browser_run_code_unsafe` are
  never classified.
- `playwrightServer()` now passes `--allowed-origins` (derived from `agent.scope.urls`) and
  `--isolated`. Microsoft states this flag "does not serve as a security boundary and does not
  affect redirects", so it is a second layer under the gate, not the control. Documented as such.
- The skill may now explore an SPA: `browser_navigate`/`snapshot`/`find`/`screenshot`/
  `console_messages` added, `browser_snapshot` declared a primary source (an SPA's selectors live in
  the DOM, not on disk), and the instructions tell the model to take expected behaviour from the
  acceptance criteria rather than by trying it in the browser.
- Known limitation, stated in code and docs: only navigation carries a URL, so a link the agent
  follows or a redirect is not re-checked by the gate.
- Fixture regenerated: adding `urls` to the scope changes the config hash recorded in the `request`
  event. Still 42 events, no shape change.
- Tests: 209.

### Added (A8 part 2 — first live runs against Azure DevOps and Juice Shop)

Everything here comes from defects observed in real runs, not from review. The ledger of each
failing run is what diagnosed it; the run ids are cited so the evidence can be re-read.

- **Authorization failures are terminal** (`src/runtime/denials.ts`). A call can fail because the
  arguments were wrong — retry — or because the environment will not perform that operation for
  this identity at all, which no argument list fixes. `authorizationFailure()` recognises the
  second kind from a narrow set of phrases; `operationKey()` identifies the operation (tool plus
  multiplexed `action`, so `testplan#list_plans` staying open does not depend on
  `testplan_test_plan_write#create`). The loop closes a refused operation for the rest of the run,
  refuses it **before** the approval batch is assembled, and tells the model plainly that
  retrying cannot help. Observed in run `20260914T015933Z-4a2806d0`: Azure DevOps answered "You
  are not authorized to access this API" four times; the model varied `iteration` and `areaPath`
  between attempts, so the exact-argument repeat memo never fired and the reviewer was asked to
  approve the same dead write three more times.
- **Contract change (PLAN §0.3):** `agent.capabilities` — what the environment CAN do, as distinct
  from what the agent is allowed to do (`policy`) or where it may act (`scope`). One key so far,
  `test_plans` (default `true`). Creating a test _case_ is an ordinary work-item write and needs
  only Basic access; creating a test _plan_ or _suite_ goes through the Test Plans service, which
  needs the Test Plans access level — a paid extension. With `test_plans: false` the plan and
  suite tools are removed from the skill's view, the instructions drop the suite step and say why,
  and the verifier stops requiring suite membership.
- **Contract, additive:** `VerifyPayload.limitations` — checks the verifier did not make, and why.
  A run can be done without being complete, and the difference belongs in the ledger rather than in
  a footnote. `aqa replay` renders them under "Checks not made".
- `ServerSpec.defaultArgs`, merged before gating so the ledger and the policy record the arguments
  actually sent. Fixes "Client does not support form elicitation": the Azure DevOps server asks the
  client for `project` when it is missing, and this client cannot answer.
- No-progress stop rule (`MAX_STALE_CYCLES = 3`): a cycle whose calls were all made before is fed
  back once, then the run ends as blocked. Observed: the same two files read 29 times. A
  successful call that produced artefacts, or that is not a read, clears the memo — re-running the
  suite after editing a spec is the same call with a different meaning, and refusing it stranded
  the agent (observed: the model rewrote the spec 13 times working around the rule).
- The model's own notes are fed back cycle to cycle (`NOTE_WINDOW = 4`). Each cycle is assembled
  from the ledger rather than from an API-side conversation, which is what makes a run replayable —
  but without its own notes the model receives identical input and makes an identical decision.
- Context windows split by role: `SOURCE_CHARS = 16_000` for primary sources, `STEP_CHARS = 2_000`
  for step results. A flat 400-character cap had been starving the agent of the acceptance criteria
  it had just read, so it read the work item again, forever.
- `spawnable()`: on Windows a `.cmd`/`.bat` is run through `ComSpec`, since Node refuses to spawn
  one directly (`EINVAL`).
- Azure DevOps auth: `--authentication envvar` with the PAT in `ADO_MCP_AUTH_TOKEN`, passed through
  the child process environment and never argv. The server's default is interactive browser OAuth,
  which opened a browser window mid-run.
- The skill names the credential variables exactly (`AQA_APP_USER`, `AQA_APP_PASS`) and forbids
  falling back to credentials the model happens to know for the application — observed: it invented
  `AQA_USER_EMAIL`, then signed in as the Juice Shop administrator.
- Budgets raised to 60 steps / 1,500,000 tokens; a fix → run → fix cycle costs roughly 14k tokens,
  most of it the fixed tool schemas.
- Fixture regenerated: `agent.capabilities` changes the config hash in the `request` event. Still
  42 events, no shape change.

### Fixed (A8c — the verifier could never pass on a real ledger)

- **`completedCalls()` now returns the server-qualified tool name.** A `call` event stores `server`
  and `toolName` separately, with the tool name bare (`wit_work_item`); the verifier compared it
  against the qualified spelling everything else uses (`ado.wit_work_item`), matched nothing, and
  reported every check as "never attempted". Observed in run `20260914T032555Z-366ff951`: the story
  was read, the suite ran 5/0/0 green, four cases were created — and the verifier answered
  `story-not-read, suite-not-run, no-test-cases`. An already-qualified name is left alone, so a
  ledger from an older build still reads.
- **The unit fixtures had encoded the wrong shape**, writing the qualified name into a `call` event
  the loop would have written bare. That is why 223 tests were green while the verifier could not
  pass a single check against a real run. The fixture builder now writes what the loop writes.
- **Added an end-to-end test** that runs the real loop and hands its ledger to the real verifier.
  Every other fixture in the suite encodes an assumption about the event shape; this one encodes
  none, and is the test that would have caught this.

### Changed (A8d — the verifier checks state, not effort)

Three findings from the first `done` run (`20260914T034436Z-a69f71a5`), all the same mistake wearing
different clothes: a check that asks "did this run DO the thing" rather than "is the thing TRUE".

- **Check 2 accepts a spec that already exists.** It required an artefact recorded in this run's
  ledger, so a run that found a correct spec in the workspace and simply executed it was told "no
  spec written" and had to rewrite the file to pass. It now counts any spec path the run named —
  written, generated or merely read — that is present on disk. A path named but absent is still a
  gap.
- **Check 4 counts cases the story already had.** It required creation, which is precisely why three
  consecutive runs each filed a fresh set of test cases against AB#1. It now counts cases created
  this run plus those already linked by a `Microsoft.VSTS.Common.TestedBy` relation.
- **New check 4b: it looked before it wrote.** Whether a criterion is already covered is a semantic
  judgement — the create tool exposes no tag and no automated-test-name field to key on, and the
  model rewords every title between runs — so the model decides it and code insists only that the
  existing cases were read first (`wit_work_item get` with `expand: "Relations"`). Creating without
  looking is now a gap.
- The skill reads the story with `expand: "Relations"`, reads any linked cases before writing, and
  is told to create only what is missing, `update_steps` what is stale, and leave the rest alone —
  with "a run that creates nothing is a successful run" stated, because the previous instructions
  implied the opposite.

### Fixed (A8d)

- **Azure DevOps results are fenced text, not objects.** Every ADO result reaches the ledger wrapped
  in the untrusted-content fence that keeps the model from reading it as instruction; `asRecord` saw
  a string and returned undefined, so `createdCaseIds` reported nothing on runs that had created
  five cases. `unfence`/`payloadOf` now parse the body, and `testedByIds` reads a story's tested-by
  links out of it.

### Changed (A8d, continued — the grain of a test case is stated)

- One test case per acceptance criterion, whatever number of Playwright tests that criterion
  needs. AB#1 produced **five** cases on one run and **four** on the next, from the same four
  criteria, because nothing said which unit a case represents: the agent split "empty fields show
  validation messages" into two cases one time and kept it as one the next. A traceability link
  whose granularity changes run to run is not a traceability link. The skill now fixes the case
  grain at the criterion, fixes the test grain at the behaviour, and says explicitly that the two
  counts may differ.

### Added (A8e — the run reports itself from the ledger)

- **`aqa.run_summary`** (`src/mcp/adapters/summary.ts`), a new in-process adapter classed `read`.
  It counts the suite result, the cases created and the cases the story already had, the spec files
  written, and anything the environment prevented — all from the ledger — and returns the markdown
  to post. The skill now calls it and posts the text verbatim.

  This closes the one place where the design's own rule did not hold. Everywhere else the model
  proposes and code decides; the comment written back to the story was the model narrating its own
  work — "5 passed", "no duplicates were introduced" — with nothing checking it. It was accurate
  both times we looked. It was still a claim standing where evidence belongs, and it could drift
  from `aqa replay` without anyone noticing. The agent may still add its own judgement around the
  block, clearly marked as its own; it no longer restates the figures, because it no longer has to.

- **The test naming convention is stated**: a test is named for the criterion it covers, suffixed
  `a`, `b`, `c` when a criterion needs several (`AC-3a`, `AC-3b`); the case keeps the bare id. The
  model invented this convention on one run and might not have repeated it. It has to hold in both
  directions, because stripping the suffix off a failing JUnit test name is how the regression
  pipeline will map a failure back to a requirement.

### Changed (A8e)

- **The Playwright JSON report is kept**, written to `.aqa-report/playwright.json` in the workspace
  and recorded as an artefact. The reporter writes to stdout, which was parsed into a flat summary
  and then discarded — so per-test durations, retries and error stacks, exactly what failure triage
  needs, were never persisted at all. Best-effort: a workspace that cannot be written still returns
  a usable summary.

### Added (A9 — the file-approval contract)

- **`--approval-timeout <seconds>`** on `aqa run`. Contract addition, optional, default 1800. With
  `--approval file` nobody is at a keyboard, and silence past the timeout becomes
  `{ decision: "denied", by: "timeout" }` so an unattended run cannot sit forever holding a browser
  and two MCP servers open. A joint smoke or a CI run wants seconds, not half an hour.
- **Four tests covering the platform's path end to end** — the loop asks, the ledger announces, a
  simulated platform answers by writing the file, the run carries on. They pin the parts the other
  track depends on: approve → `done` with the approver recorded, deny → `blocked` with the call
  never made, silence → `blocked` by `timeout`, and the request file carrying the whole batch.
- **Documented the ordering race**: `approval_requested` is appended to the ledger _before_ the
  approver writes `approvals/<id>.json`, so a platform that stats the file the instant it sees the
  event will sometimes find nothing. "Not there yet" means still arriving. There is a test for the
  ordering, because this is the kind of race that appears once in fifty runs and gets blamed on
  something else.
- `docs/HANDOFF_A9_2026-09-14.md`: the full contract, the four things to get right, the status/exit
  table, and the smoke script.
