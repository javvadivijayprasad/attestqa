# ADR-008, appendix — the plan, release by release

Date: 2026-11-12 · Status: accepted (plan; nothing built) · Belongs to
`ADR-008-project-document-retrieval.md`

This appendix records what was discussed and agreed for each release on 12 Nov 2026, in more
detail than the decision record. Each release still gets its own design when its turn comes, and
a release ships whatever is finished and tested on its date. `ROADMAP.md` is the short form.

| Release | Date | Feature |
| --- | --- | --- |
| 2.3.0 | 15 Jan 2027 | Generated test data |
| 2.4.0 | 15 Feb 2027 | Document search, citation check, evaluation, dashboard |
| 2.5.0 | 15 Mar 2027 | Tracker seam |
| 2.6.0 | 15 Apr 2027 | Approved locator repairs |
| between | | Vector search plug-in, on its own version |
| 2.7.0 | 15 May 2027 | Retrospective memory |
| 2.8.0 | 15 Jun 2027 | Local web UI; responsive-layout and cross-browser kinds of test |
| 2.9.0 | 15 Jul 2027 | Budget reservation; editing settings from the UI |
| 2.10.0 | 15 Aug 2027 | The agent split |
| 2.11.0 | 15 Sep 2027 | Visual check |
| 2.12.0 | 15 Oct 2027 | Performance smoke |
| 2.13.0 | 15 Nov 2027 | Guided exploration and requirements review |
| 3.0.0 to 6.0.0 | 15 Dec 2027 to 15 Jun 2028 | API testing, web version, security testing, data and ETL testing |

## 2.3.0: generated test data (15 Jan 2027)

**State on 12 Nov 2026.** The first half is built and merged into `release/2.3.0`: the
`synthdata.examples` tool, which produces boundary values and invalid rows for a form field and
has the agent write them as one Scenario Outline with an Examples table. It was checked by unit
tests, a real run of the generator, and a real build of an outline. A full run on a real story has
not been done yet.

**Still to do.** The end-to-end run on a form-field story, then the `aqa seed` command, which
generates application seed data into the workspace. Loading that data into an application stays a
project step. The release is not versioned or tagged until both are done.

**Agreed.** `aqa seed` stays in 2.3.0.

## 2.4.0: document search with its evaluation (15 Feb 2027)

**The problem today.** A story says "a phone number shorter than the allowed length is rejected"
and does not give the length. The agent has to take it from the page or from memory.

**What it does.** The project names its document folder once. During a run the agent searches
those documents, finds the sentence that states the rule, and uses its values in the test design.
The approval shows the file, the heading and the quoted sentence. The engine checks in code that
the sentence really is in that document; a made-up citation is refused.

**What is in it.** A document index built by a command; one read-only search tool; the citation
check; an evaluation command; a dashboard page; gold sets for the three evaluation apps.

**What is not in it.** Vector search, any embedding model, memory across runs, PDF and Word
files, a judge model switched on by default, and any change to the contract.

**How it is proven.** The search questions run in CI at no cost. The stories run five times each
with search off and on. An instruction planted in a document must be ignored. The existing run
records are replayed to show no old run is judged differently.

**Agreed.** The six parts above, with the dashboard the first to move if the month runs short;
Markdown and plain text only; 60 to 100 questions and 12 to 15 stories, roughly $455 to $570 per
full pass; the pass bars in the decision record; gold sets drafted and then checked by the
maintainer.

## 2.5.0: tracker seam (15 Mar 2027)

**The problem today.** The rules that stop bad tracker writes were written for Azure DevOps.
About 12 of the 13 name Azure DevOps tools directly. A duplicate or unlinked bug is refused on
Azure DevOps and goes through on Jira.

**What it does.** One neutral vocabulary (story, criterion, test case, bug, comment) that both
trackers map onto. Every rule is rewritten once against it. It is done in two steps: first rewire
with no change in behaviour, proven by replaying the existing run records and getting the same
refusals word for word; then switch the rules on for Jira.

**What a user notices.** Azure DevOps users: nothing. Jira users: some writes that used to pass
are refused, with the same messages Azure DevOps users see.

**What is not in it.** No new tracker.

**Why it stays here.** It closes a gap for people using the product today, so new features move
it back by one month only.

## 2.6.0: approved locator repairs (15 Apr 2027)

**The problem today.** When a locator changes, attestqa works out a replacement and applies it. A
second tool gives its own opinion as a suggestion only. No person is asked or shown the evidence.

**What it does.** A repair becomes a decision a person can approve, with the old and new locator,
what each of the two rankers picked, their scores, whether they agree, and which other tests fail
on the same locator.

**The setting.** `off` (default, as today); `on-disagreement` (asks only when the rankers disagree
or confidence is low); `always`.

**What is not in it.** No change to how repairs are found. The second tool is not edited from this
repository.

**Why it comes before memory.** These approvals and denials are the facts memory learns from.

## Between 2.6.0 and 2.7.0: the vector search plug-in

Built as its own package on its own version, the way the Bedrock plug-in is. It stores vectors in
a plain file in the workspace and searches them exactly; there is no vector database, because
searching 5,000 passages took 6 ms on the maintainer's machine. The first embedding option uses
the Bedrock sign-in from 2.2.0, and a local model covers offline use. The core change that loads
it ships in 2.7.0.

## 2.7.0: retrospective memory (15 May 2027)

**The problem today.** Every run starts from nothing. A test that passed six times and failed
three times with no code change is flaky, but today's run treats its failure as a possible defect
and spends steps and money finding that out again.

**What it does.** A rebuild command turns the past run records into a small list of facts, and a
second command shows which runs a fact came from. A read-only recall tool lets a run look a fact
up; the lookup is recorded like any other tool call.

**The facts in this release.** A test is flaky (it passed and failed at the same code version).
Which tests belong to which story (the scenarios existed after a green run). A repair worked (the
repaired test ran green and the repair was approved).

**With the plug-in installed.** A run can look up similar past failures and what was decided about
them, shown as a suggestion with evidence that never decides an outcome; and document search gains
a combined keyword-and-vector mode.

**Safety rules.** The agent cannot write a fact. Everything can be rebuilt from the run records.
Facts lose weight when the code they were learned against changes. Off by default.

**What is not in it.** Failure history feeding triage, and past decisions feeding the bug flow.

**How it is proven.** The evaluation command runs the same stories with memory off and on and
reports whether steps, cost and wrong bug reports go down.

## 2.8.0: local web UI, and two new kinds of test (15 Jun 2027)

**The problem today.** attestqa is used from the terminal or the VS Code extension. A tester or
product owner who does not use VS Code has no comfortable way to start a run and approve a design.

**What it does.** `aqa serve` opens attestqa in the browser on the same machine, at `127.0.0.1`
only. Nothing is hosted and nothing leaves the machine. It follows the same flow as the extension.

**The seven screens** (reviewed as a mock-up with sample data): New run, Run and approval, Runs, Coverage,
Evaluation, Memory, Settings. The page updates live as the run writes its record; a waiting
approval shows a count in the menu; from any value, test or score the evidence is one click away.

**Kinds of test on the New run screen.** Tick boxes, pre-filled from the project's config:
functional, negative and validation, accessibility, security, responsive layout, cross-browser.
Known bugs on the story are always included. Kinds that belong to a later stage are shown as
unavailable: visual check, performance smoke, API, security scanning, data and ETL.

**Two new kinds in the engine.** Responsive layout: the story's tests at phone, tablet and desktop
widths, with the design saying which widths matter and why. Cross-browser: the same tests in the
Chromium, Firefox and WebKit engines, reported per browser.

**The dashboard graphs.** Headline tiles for each measure; a story-by-story comparison of search
off and on; a five-runs consistency grid; a bar chart of where search found the answer; results by
kind of question; a trend across versions; cost against success. Every figure shows its likely
range and number of runs, and colour is never the only signal.

**What is not in it.** Hosting, accounts and several people approving together (the 4.x stage); a
Windows desktop app.

**Agreed.** The dashboard page and the memory page are included; the two new kinds are included.
If the month runs short, the UI ships first and the kinds follow in 2.9.0.

## 2.9.0: budget reservation, and settings in the UI (15 Jul 2027)

**The problem today.** A run has one budget of steps and tokens. If an early stage gets stuck it
spends everything and the later stages never get a turn. In October one run proposed the same bug
18 times and had nothing left to repair a broken locator.

**What it does.** One optional setting keeps a number of steps and tokens for the repair stage.
With 120 steps and 15 kept, the other stages can use at most 105; the repair stage still has its
15. If no repair is needed they are not used. The default is zero, which is today's behaviour.

**In the UI.** The reserve is shown on the Settings and New run screens, and the end of a run
shows how the budget was split. Settings also become editable from the browser: a change is
written to the project's config file and shown before saving, and keys and passwords are never
handled there.

**What it does not do.** It does not make a run cheaper or fix the cause of a stuck stage. Limits
for every stage and a cheaper model for repairs wait for 2.10.0.

**How it is proven.** A starved run from October is replayed with a reserve and the repair stage
gets its turn; with the reserve at zero the existing run records replay exactly as before.

## 2.10.0: the agent split (15 Aug 2027)

**The problem today.** One agent does almost everything, carrying one long set of instructions
and the full tool list on every step. Only the repair step is separate.

**What it does.** Each stage becomes its own agent with only its own instructions and tools:
author (reads the story and designs), implement (writes and builds the tests), execute (runs them
and works out failures), repair (as today), defect (proposes and files bugs). The engine chooses
which agent runs next from the run record; the model never chooses its own role.

**What comes with it.** A separate budget per stage, and a cheaper model for simple stages.

**What a user notices.** Lower cost per run, fewer wrong-stage actions, and the stage bar showing
which agent is working. The rules do not change.

**How it is proven.** The existing run records are replayed and must give the same refusals.

## 2.11.0 to 2.13.0: three more kinds of work (Sep to Nov 2027)

- **2.11.0, visual check.** A page is compared with an approved screenshot. A person approves the
  first image and any intended change.
- **2.12.0, performance smoke.** A page must load and respond within a stated time. The time must
  come from the story or a document; "loads fast" is not testable.
- **2.13.0, guided exploration and requirements review.** The agent explores the application and
  proposes test ideas for a person to accept, and reviews a story for gaps before any test is
  designed. Web testing is complete with this release.

A rule for all of them: a kind of test is a feature, not a label. Each needs its own rules for a
valid design item, a required source, and a check that the test does what the kind claims.

## 3.0.0 to 6.0.0: the later stages

These were not discussed in detail on 12 Nov 2026; only their dates moved.

| Release | Date | Stage |
| --- | --- | --- |
| 3.0.0 | 15 Dec 2027 | API testing |
| 3.1.0 | 15 Jan 2028 | API exploration; contracts from traffic |
| 4.0.0 | 15 Feb 2028 | Web version of attestqa: hosting, accounts, several people approving |
| 4.1.0 | 15 Mar 2028 | MCP and multi-user approvals |
| 5.0.0 | 15 Apr 2028 | Security testing |
| 5.1.0 | 15 May 2028 | Active scanning |
| 6.0.0 | 15 Jun 2028 | Data and ETL testing |

Putting API testing ahead of 2.11.0 to 2.13.0 was offered as an alternative and not taken.

## Considered and left out

| Idea | Why not |
| --- | --- |
| A vector database | Unnecessary at the size of a project's documents |
| Knowledge-graph retrieval | Built for very large document sets |
| Fine-tuning a model | Costly and tied to one provider |
| Agents debating each other | Multiplies cost; the agent split gives an independent check more cheaply |
| Caching answers by similarity | Returns a stored answer for a question that only looks the same |
| Export to the OpenTelemetry format for AI traces | Those conventions were not yet stable in 2026 |

## End-to-end testing before every release

**Decided by the maintainer on 12 Nov 2026:** every release is tested end to end, against both
trackers and all three applications, before it moves forward.

**Proposed set, awaiting the maintainer's go-ahead:** two stories per application, one that
exercises the release's new feature and one unchanged story to show nothing broke.

| Application | Tracker | Feature story for 2.3.0 | Unchanged story |
| --- | --- | --- | --- |
| Booker | Azure DevOps | Visitor is told what is wrong with the contact form | Visitor sees the B&B and its rooms |
| SauceDemo | Azure DevOps | Customer gives their details at checkout | Customer signs in with a valid user |
| Toolshop | Jira | New customer registers an account | Customer signs in and signs out |

A run passes when it completes with no verifier gaps, the suite is green or a failure is a
justified known bug, the feature shows in the design and the feature file, and a replay against
the rules gives no surprises. Six runs cost about $23 at October's average.
