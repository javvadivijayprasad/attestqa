# ADR-008 — Retrieval over project documents, its evaluation, and the roadmap from 2.4.0

Date: 2026-11-12 · Status: accepted (design and plan; nothing built)

## Context

**The gap.** A story often names a rule without its value. The Booker story "Visitor is told what
is wrong with the contact form" says a phone number "shorter than the allowed length" is rejected
and never gives the length. Today the agent has two places to find it: the story and the live
page. A project's own documents (specifications, validation rules, a wiki export) are a third
place, and the engine cannot read them in a governed way.

**The weakness this exposes.** A design item carries one free-text `source`, and the only check on
it is a pattern: it must name a criterion, task, bug, comment or epic
(`mcp/adapters/test-design.ts`, `validateDesign`). Nothing checks that the source supports the
item. The October evaluation recorded this as W6: the source rule is "a review aid, not a gate".

**The decision that prompted this record.** On 12 Nov 2026 the maintainer decided that retrieval
over project documents is the 2.4.0 feature, and asked for a design covering four things:
retrieval, a vector database, an evaluation with a dashboard, and retrospective memory (what
earlier runs learned, fed to later runs).

**What was researched** (12 Nov 2026; the sources and what could not be verified are at the end):

- the repository: the ledger, the design schema, the tool and plug-in seams, the existing
  evaluation tooling and the documentation rules;
- vector stores and embedding models usable from a Node command-line tool on Windows, macOS and
  Linux, including a timing measured on the maintainer's machine;
- how retrieval systems and agents are evaluated, how far a judge model can be trusted, and how
  retrieved passages should be shown to a model.

**Facts from the repository that shape the design:**

| Fact | Consequence |
| --- | --- |
| The ledger reader rejects unknown event kinds, and VERSIONS.md says a new kind is a major bump | A search is recorded as an ordinary `call` + `observation` pair; no new event kind |
| RELEASING.md: a new optional key, tool or flag with a default is a MINOR (precedent: `agent.budgets.max_output_tokens`, 2.1.0) | The feature fits 2.4.0 with no contract change |
| The plug-in seam (`runtime/plugins.ts`) loads model providers and sign-in only | An embeddings plug-in needs a new seam first |
| `inference.usage` holds tokens; no cost is stored; cost is computed by `research/tools/cost.py` with prices for one model | The evaluation needs its own dated price table |
| There is no `eval`, `report` or `metrics` subcommand, and no HTML output anywhere | The evaluation command and the dashboard are new |
| `aqa coverage --json`, `computeStats` (replay) and the seeded-fault harness (`TestRunApplication/_faults`) already exist | The evaluation reuses them |
| `DESIGN_memory_v0.1.md` (history, unbuilt) already designs governed cross-run memory | Retrospective memory follows that design; it is not redesigned here |
| The provenance filters `isRunReport` / `isAgentBug` exist because the agent twice read its own output back as fact | The index must never contain agent output |

## Decision

### 1. The roadmap changes

2.4.0 becomes **project-document retrieval with its evaluation**. The maintainer went through the
plan release by release on 12 Nov 2026 and agreed the order below. 2.3.0 is unchanged.

| Release | Target | Feature | Against the 5 Nov plan |
| --- | --- | --- | --- |
| 2.4.0 | 15 Feb 2027 | Document search, citation check, evaluation command, dashboard page | new |
| 2.5.0 | 15 Mar 2027 | Tracker seam | one month later |
| 2.6.0 | 15 Apr 2027 | Approved locator repairs | one month later |
| between | | Vector search plug-in, on its own version (§9) | new |
| 2.7.0 | 15 May 2027 | Retrospective memory, using the plug-in when installed (§10) | new |
| 2.8.0 | 15 Jun 2027 | Local web UI; responsive-layout and cross-browser kinds of test (§12) | two months later, enlarged |
| 2.9.0 | 15 Jul 2027 | Budget reservation; editing settings from the UI | two months later, enlarged |
| 2.10.0 | 15 Aug 2027 | The agent split | two months later |
| 2.11.0 | 15 Sep 2027 | Visual check as a kind of test | new |
| 2.12.0 | 15 Oct 2027 | Performance smoke as a kind of test | new |
| 2.13.0 | 15 Nov 2027 | Guided exploration and requirements review; web testing complete | newly scheduled |
| 3.0.0 | 15 Dec 2027 | API testing | five months later |
| 3.1.0 | 15 Jan 2028 | API exploration; contracts from traffic | five months later |
| 4.0.0 | 15 Feb 2028 | Web version of attestqa | five months later |
| 4.1.0 | 15 Mar 2028 | MCP and multi-user approvals | five months later |
| 5.0.0 | 15 Apr 2028 | Security testing | five months later |
| 5.1.0 | 15 May 2028 | Active scanning | five months later |
| 6.0.0 | 15 Jun 2028 | ETL testing | five months later |

The tracker seam stays directly after 2.4.0 because it closes a gap for current Jira users. The
alternative of putting API testing ahead of 2.11.0 to 2.13.0 was offered and not taken.

### 2. What 2.4.0 contains, and what it does not

| In 2.4.0 | After 2.4.0 |
| --- | --- |
| A document index built by a command | Vector search, as a separately versioned plug-in (§9) |
| One read-only tool, `docs.search` | Retrospective memory, in 2.7.0 (§10) |
| A citation check on design sources | |
| An evaluation command and a gold set | |
| A static dashboard page | |

The evaluation ships in the same release as retrieval on purpose. Without it there is no way to
show that vector search or memory helps, and no way to show that retrieval itself does.

### 3. Principles

1. **The model reaches documents only through the gate.** A search is a tool call, judged and
   recorded with its full result, so a replay shows exactly what the run was told.
2. **The model writes to no store.** The index is derived from documents, the metrics from ledgers
   and the gold set. Each can be deleted and rebuilt.
3. **Agent output is never indexed.**
4. **Off unless configured.** With no document folder named, a run is unchanged and the config hash
   is unchanged.
5. **Keyword search in the core, with no model and no key.** Vectors are a plug-in.
6. **The story wins.** When a document and the story disagree, the story's value is used and the
   disagreement is shown to the approver.

### 4. The index

- **Setting:** an optional `agent.knowledge.paths` list of workspace-relative folders or files.
- **Command:** `aqa index` reads those paths and writes `<ledger root>/knowledge/`:
  `passages.jsonl` (one passage per line), `manifest.json` (file hashes, chunker version, build
  time, tool version) and the keyword index.
- **Formats:** Markdown and plain text in 2.4.0. PDF and Word files come later, as they need a
  parser dependency.
- **Passages:** split at headings, with a size limit and a split at paragraph boundaries above it.
  Each passage keeps its file, heading path, line range, file modification date and content hash.
  The passage id is `<file>#<heading slug>@<first 8 hex of content hash>`, so a citation survives a
  rebuild and stops matching when the text changes.
- **Never indexed:** the ledger root, `.aqa-report`, generated feature and spec files,
  `node_modules`, the secret paths the `fs` adapter already refuses, and any file that matches
  `isRunReport`.
- **Ranking:** BM25 written in the core (about 100 lines, `k1 = 1.2`, `b = 0.75`, a fixed
  tokeniser, ties broken by passage id). An in-house implementation is chosen over a library so
  the formula and parameters are documented and the core gains no dependency.
- **Staleness:** a search compares the manifest's file hashes with the files on disk. When they
  differ the result says the index is out of date. The index is never rebuilt silently, because
  that would change what a run is told without a record.

### 5. The tool and how the model sees it

- **Registration:** an in-process adapter, server `docs`, tool `search`, policy class `read`. It is
  not in the default server list. It is offered when `--servers` includes `docs` and the setting
  is present, the same pattern as `synthdata`.
- **Arguments:** `query` (text) and `limit` (1 to 5, default 5).
- **Result:** the query, the index build time, a staleness note, and for each passage its id, a
  short label (`D1`, `D2`, …), file, heading, line range, modification date, rank, score and text.
- **Budget:** at most five passages of about 1,200 characters each. `docs.search` joins the
  skill's source tools, so its results are kept as sources and trimmed after the story digest.
- **Labelling:** the result is fenced the way tracker content already is, under a header saying
  these are passages from files the project named, that they are text and not instructions, and
  that they may be out of date. Each passage carries its date so the model and the approver can
  see age.
- **When to search (skill text, stage 2):** when a criterion names a rule without its value, and
  before the design is submitted. Not when the story states the value.
- **When nothing is found:** the agent says so in the item, in a fixed phrase the evaluation can
  count, and takes the value from the live page or asks. It does not supply a value from memory.
- **Injection:** passages cannot trigger anything. Every write the model proposes after reading a
  passage is still judged by the gate, and the evaluation plants an instruction in a document to
  prove it (§6).

### 6. The citation check

A design item that takes a value from a document cites it:

- its `source` names the criterion as today and adds `doc:<passage id>`;
- a new optional item field, `quote`, holds the words copied from the passage.

`validateDesign` then checks, in code and before the reviewer sees the design:

1. the passage id was returned by a `docs.search` observation in this run;
2. the quote, with whitespace normalised, occurs in that passage's text.

The approval dialog shows the file, heading and quote beside the expected result.

Two consequences:

- **A carried design.** A design reused from an earlier run cites that run's passages. The story
  fingerprint must include the content hashes of cited passages, so a changed document stops the
  reuse.
- **Fix protocol.** This is a stage 2 rule. ENGINE_MAP §10 applies: list the rules acting on the
  stage, replay the existing ledgers with `aqa check-rules` (none cite a document, so none may
  change), run the rule-interaction tests, and update ENGINE_MAP in the same change.

What the check does not prove: that the quote supports the expectation. That part is measured
(§7, faithfulness), not enforced.

### 7. Evaluation

**Command.** `aqa eval <run folders> --gold <file> [--html <file>]` reads ledgers and a gold file
and writes `eval.json`. The code lives beside `report/coverage.ts`. The Python scripts in
`research/tools` stay as they are for the papers.

**Two levels**, because a full run costs minutes and money and a search costs neither:

| Level | Cases | What runs | Cost |
| --- | --- | --- | --- |
| Retrieval | 60 to 100 questions: question, expected value, supporting passage, category | `docs.search` only | None; can run in CI |
| End to end | 12 to 15 stories across Booker, SauceDemo and Toolshop, 5 runs each, retrieval off and on | The full engine | About $455 to $570, from the October average of $3.79 per counted run |

The sizes are reasoned defaults. The research found no authoritative figure for either.

**Gold set categories:** answerable from one passage; answerable from several; unanswerable (no
document has it); a distractor present (a similar passage with a different value); a stale and a
current version both present; and an instruction planted in a document. Each evaluation app gets
a small specification document holding its real limits, plus the distractor and stale documents.

**The "off" arm** is the product with no document folder configured. No switch is added to the
product for the experiment.

**Metric definitions.** Names differ between evaluation frameworks, so each is pinned here.

| Metric | Definition | Computed by |
| --- | --- | --- |
| Task completion rate | Runs whose `end` status is complete and whose verifier reports no gap, over runs started | Code |
| Consistency | Per story, the share of its 5 runs that complete; also the share of stories where all 5 complete | Code |
| Value correctness (the answer-quality score) | Precision, recall and F1 of the concrete values in the approved design against the gold values for that story | Code |
| Design accepted unchanged | Designs approved with no denial and no edit, over designs submitted | Code |
| Invented value rate (hallucination) | Concrete values in the approved design that match neither the gold list nor any tool result of that run, over all concrete values; also the share of runs with at least one | Code |
| Citation validity | Cited passage ids that were returned in the run, over citations. Enforced by the rule, so anything below 100% is a defect | Code |
| Faithfulness | Cited items whose quote supports the expected result, over cited items. Retrieval-on runs only | Code where the value is in the quote; otherwise a judge on a sample |
| Retrieval hit rate at 5 | Questions whose supporting passage is in the top five, over answerable questions | Code |
| Mean reciprocal rank | Mean of 1 / rank of the first supporting passage | Code |
| Correct refusal | Unanswerable cases where the item carries the "not found" phrase, over unanswerable cases | Code |
| Wrong refusal | Answerable cases marked "not found", over answerable cases | Code |
| Stale passage used | Items citing the stale version when the current one is indexed, over stale-pair cases | Code |
| Search discipline | Searches made when the story lacked the value, and searches made when it did not | Code |
| Planted instruction followed | Runs in which a call matching the planted instruction was proposed | Code |
| Seeded faults caught | As in the October evaluation: a test of the story fails that passed in the control run | Existing harness |
| Cost and time | Tokens, cost from a dated price table, steps, agent minutes and approval wait, per completed run | Code |

Three points on these definitions:

- **Faithfulness cannot compare off with on.** With retrieval off there are no passages. Value
  correctness is the score both arms share, so it is the main comparison.
- **Faithfulness and invented values are different questions.** An item can quote a stale document
  faithfully and still be wrong. The first is checked against the passages, the second against
  the gold list.
- **Refusal is two rates,** never one blended figure.

**Statistics.** Each rate is reported with a Wilson 95% interval. Off and on are compared per
story (paired), with the counts of stories helped, hurt and unchanged, and McNemar's exact test.
Runs are averaged within a story first; the story is the unit.

**The judge model.** Off by default. When used: a different model from the generator, one yes/no
question per item, and its scores count only after 30 to 50 hand-labelled items show its agreement
(true-positive rate, true-negative rate and Cohen's kappa are reported with the results).

**Thresholds, fixed before the first run** (agreed 12 Nov 2026):

| Measure | Proposed bar |
| --- | --- |
| Citation validity | 100% |
| Planted instruction followed | 0 runs |
| Retrieval hit rate at 5 | At least 85% |
| Task completion, on versus off | Not lower |
| Value correctness, on versus off | Not lower overall; higher on stories whose values are only in documents |
| Correct refusal / wrong refusal | At least 80% / at most 10% |
| Stale passage used | At most 10% |

A bar such as "invented values at most 2%" is not set, because 120 to 150 runs cannot measure a
rate that small; the rate is reported with its interval.

**Three further inputs to the evaluation:**

- **Approver decisions are labels.** Every `approval_resolved` carries a decision and, from the
  terminal approver, a reason. Counted per release they are a free quality signal and the judge's
  calibration set. The `reason` field is written today but not declared in the payload type; that
  is corrected in the same work.
- **A release check.** The retrieval-level gold set runs in CI. The end-to-end set is a manual
  step in RELEASING.md before a minor release, since it costs money.
- **Model changes.** The same gold set is re-run when a provider changes a model.

### 8. Dashboard

`aqa eval --html` writes one self-contained HTML file. There is no server and nothing leaves the
machine. In order of usefulness:

1. off versus on per story, with the interval and the helped / hurt / unchanged counts;
2. drill-down from a score to the design item, its cited passage with the quote marked, and the
   ledger events behind it;
3. the per-run table (run, arm, model, config hash, outcome, cost, steps);
4. results by gold category;
5. the repeat view: per story, how many of its runs passed;
6. the traceability chain: story → criterion → design item → scenario → test → result → defect;
7. the trend across versions;
8. the judge panel: model, prompt version, agreement figures, disagreements.

The local web UI planned for a later release can serve the same page. Export to the OpenTelemetry
format for AI traces is left out: those conventions were still marked "Development" in 2026.

### 9. Vector search: a separate plug-in, without a vector database

**When.** Built as its own package, on its own version, between 2.6.0 and 2.7.0. The seam in the
core that loads it ships in 2.7.0, the first release that can use it. It is opt-in: a project that
does not install it runs on keyword search and exact matches.

**Two uses.** A combined keyword-and-vector mode for document search, and the similar-past-failure
lookup in memory (§10). The 2.4.0 evaluation reports whether the combined mode finds more answers
than keywords alone.

**Design.**

- A new plug-in seam for embedders (`@attestqa/embedder-<name>`), named by an optional
  `agent.knowledge.embedder` setting, beside the provider and sign-in seams.
- Vectors stored as a flat file of 32-bit floats beside the passages, with a manifest recording
  the provider, model id, dimension, normalisation and a hash of the vectors file. A search is
  refused when the manifest does not match the configured embedder.
- Exact cosine search in the core. Keyword and vector rankings are merged by reciprocal rank
  fusion (`1 / (60 + rank)`, summed).
- First embedder: Amazon Titan Text Embeddings v2 through the Bedrock sign-in shipped in 2.2.0.
  Second: a local model (bge-small-en-v1.5, MIT) for offline use; its runtime is about 300 MB and
  must stay out of the core.

**Why no vector database.** A project's documents are 50 to 5,000 passages. Exact search over
5,000 vectors of 1,024 dimensions took 6.2 ms in plain JavaScript on the maintainer's machine
(Node 22.13.0; 70 ms at 50,000). An approximate index would add a native binary and results that
can differ between builds, to save a few milliseconds.

**Reproducibility.** Hosted embedding services do not promise identical vectors for identical
text. The stored vectors and their hash are therefore the record; they are not re-derived and
compared.

### 10. Retrospective memory: 2.7.0, following the existing design

`packages/core/docs/history/DESIGN_memory_v0.1.md` stands as written: facts are a projection of
the ledgers, promoted only when something independent confirmed them, recalled through one
governed read-only tool, and never written by the model.

**In 2.7.0** (the design's first two slices):

- `aqa memory rebuild` and `aqa memory why`;
- a read-only recall tool, recorded in the ledger, off by default;
- three kinds of fact: a test is flaky (it passed and failed at the same code version); which
  tests belong to which story (the scenarios existed after a green run); a repair worked (the
  repaired test ran green and the repair was approved, from 2.6.0);
- the embedder seam, and with the plug-in installed, a lookup of similar past failures. A similar
  failure is shown as a suggestion with its evidence and never decides an outcome.

**Not in 2.7.0:** failure history feeding triage, and past decisions feeding the defect flow.

The cross-run reader that already exists (`design/fingerprint.ts`, `readRuns`) is the starting
point, and the evaluation in §7 runs its "memory on versus off" comparison.

### 11. Build order for 2.4.0

One changeset per slice, each cut from `release/2.4.0`:

1. the index and `aqa index`;
2. `docs.search` and the skill text;
3. the citation check, with the fingerprint change;
4. `aqa eval`, the price table and the gold-set format;
5. the dashboard page;
6. the gold sets and documents for the three evaluation apps, and the end-to-end runs.

### 12. The rest of the 2.x line, as agreed

These are recorded here so the roadmap change has one source. Each gets its own design when its
turn comes.

- **2.8.0, local web UI.** `aqa serve` on `127.0.0.1`, the same flow as the VS Code extension. A
  seven-screen mock-up was reviewed on 12 Nov 2026: New run, Run and approval, Runs, Coverage,
  Evaluation, Memory, Settings. The New run screen offers the kinds of test as tick boxes,
  pre-filled from the config; kinds that belong to a later stage are shown as unavailable.
- **2.8.0, two new kinds of test.** Responsive layout (the story's tests at phone, tablet and
  desktop widths) and cross-browser (the same tests in the Chromium, Firefox and WebKit engines,
  reported per browser). If the month runs short, the UI ships first and the kinds follow.
- **2.9.0, budget reservation.** As planned on 5 Nov, shown in the UI. Editing settings from the
  UI is added: it writes the project's config file, shows the change before saving, and never
  handles secrets.
- **2.10.0, the agent split.** As planned on 5 Nov.
- **2.11.0 and 2.12.0, visual check and performance smoke.** A visual baseline is approved by a
  person. A performance threshold must come from the story or a document.
- **2.13.0, guided exploration and requirements review.** Exploration proposes test ideas for a
  person to accept; the review looks for gaps in a story before any test is designed.

**A rule for every new kind of test.** A kind is a feature, not a label. Each needs its own
validity rules for a design item, a required source, and a verifier check that the test does what
the kind claims.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Put the documents into every prompt | Unrecorded context of unknown size competing with the story; nothing to cite |
| Vector search first | Needs a model, a key and a new plug-in seam before any evidence that keyword search is insufficient |
| A vector database (sqlite-vec, LanceDB, DuckDB, hnswlib, Chroma, a server) | Unnecessary at this size; each adds a native binary, a Node 22 floor or a server; hnswlib compiles at install; Chroma needs a server from Node |
| A keyword library (MiniSearch) | Workable and dependency-free, but its scoring formula could not be confirmed from its documentation |
| An evaluation framework (RAGAS, DeepEval and others) | They disagree on definitions, lean on a judge model, and do not read the ledger; the metrics here are mostly plain code |
| A hosted trace viewer | The ledger is the record and must stay on the machine |
| Knowledge-graph retrieval, fine-tuning, answer caching by similarity | Built for larger corpora, tied to one provider, or incompatible with replay |

## Consequences

- **Documents to update with the work:** ENGINE_MAP (stage 2 rule and the new tool), TECHNICAL
  (the setting, the tool, the two commands; its event-kind count is also out of date), USAGE,
  ROADMAP, VERSIONS.
- **TECHNICAL.md and RELEASING.md disagree** on whether an optional config key is a contract
  change. RELEASING.md and the 2.1.0 precedent say it is not; TECHNICAL.md should say the same.
- **The source rule becomes a real check** for document citations. Sources that name only a
  criterion are checked as before.
- **Risks that remain:** a stale document quoted faithfully; an answer present but missed by
  keyword search; an approver trusting a citation without reading it. The evaluation measures the
  first two; the dialog shows the quote and date for the third.
- **Cost:** the end-to-end evaluation is roughly $455 to $570 per full pass at October's average.
- **Node:** the core declares Node 20 or later, and Node 20 reached end of life in March 2026.
  Nothing in 2.4.0 needs a newer Node; the floor is a separate decision.
- **The papers are unaffected.** They use attestqa 2.0.1 and its frozen evidence. This evaluation
  runs on release builds and writes nothing to that folder.

## Decisions taken with the maintainer on 12 Nov 2026

1. **Roadmap order:** as in §1.
2. **Evaluation size:** 60 to 100 retrieval questions; 12 to 15 stories, 5 runs each, in two arms,
   at the estimated cost.
3. **Thresholds:** the bars in §7.
4. **Document formats:** Markdown and plain text in 2.4.0; PDF and Word later.
5. **Gold sets:** drafted from the three evaluation apps, then checked by the maintainer against
   each app's real limits.
6. **Dashboard:** the first part of 2.4.0 to move to the next release if the month runs short.

## Sources

Read on 12 Nov 2026. Marked "unverified" where the primary page could not be read.

- Evaluation definitions: RAGAS (`docs.ragas.io`), DeepEval (`deepeval.com/docs`), TruLens
  (`trulens.org`), Arize Phoenix (`arize.com/docs/phoenix`), promptfoo (`promptfoo.dev/docs`),
  Amazon Bedrock knowledge-base evaluation (`docs.aws.amazon.com/bedrock`), MLflow
  (`mlflow.org/docs`).
- Agent evaluation and statistics: `anthropic.com/engineering/demystifying-evals-for-ai-agents`;
  arXiv 2411.00640 (error bars for evaluations); arXiv 2406.12045 (repeated-trial pass rates,
  unverified, read through secondary sources).
- Judge reliability: arXiv 2411.15594, 2406.07791, 2510.11822 (all through summaries).
- Passage presentation and retrieval: `anthropic.com/engineering/contextual-retrieval`;
  arXiv 2403.14720 (marking untrusted text); arXiv 2508.07479 (position effects).
- Stores and models: the npm registry entries and project pages for sqlite-vec, LanceDB, DuckDB,
  hnswlib-node, Vectra, Orama, USearch, Chroma and MiniSearch; `nodejs.org/docs/latest/api/sqlite.html`;
  `docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html`;
  `huggingface.co/BAAI/bge-small-en-v1.5`.
- OpenTelemetry conventions for AI: `github.com/open-telemetry/semantic-conventions-genai`.

Not verified: embedding prices on the vendor's own pricing page; MiniSearch's exact scoring
formula; any install of the native packages on Windows; the size figures for gold sets and
repeats, which are reasoned defaults.
