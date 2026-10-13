# ADR-004 — One QA sub-task per Jira story: test cases in the description, results in comments

Date: 2026-10-13 · Status: accepted

## Context
Jira has no test-case item. Most teams do not have Xray or Zephyr, and record tests by hand on a QA
sub-task under the story. Until now attestqa wrote nothing to Jira but a Bug, so a reader of the
story saw no tests at all; the record lived only in the repository and the ledger.

## Decision
For each Jira story, attestqa keeps **one** sub-task, summary `QA (attestqa): tests for <KEY> — …`,
labels `attestqa-qa` and `agentic-qa`:

- **Description** — the current test cases from the approved design: ID, criterion covered, type and
  technique, conditions, expected result, the automated test, and the exclusions with their reasons.
  It ends with `attestqa design <hash>`.
- **Comments** — one per run: the run id and status, each case's result (passed, failed, known bug
  reproduced or not, not run, no test), uncovered criteria, known bugs.

Created as soon as a person approves a test design — that approval covers posting its test cases,
and the prompt says so — and found again by label under that story and nowhere else. Each run's
results are posted at the end under the same approval. The description is rewritten only when its
content changes (the design, or the test automating a case).

With `agent.approve_execution: true`, the order a person sees is: approve the design (test cases
posted), approve execution (first suite run; re-runs go ahead), approve each bug (after execution,
for tests still failing). Results follow as a comment.

It is posted by the **runtime** (`jira.record_qa`, mode `cases` after the design approval, `results`
at the end), composed from the ledger and the files — never by the agent, whose proposal of the tool
is refused. It passes the gate as `write_record`; it is not put to the reviewer a second time
because the design approval it follows names it.

## The exception, stated plainly
"attestqa never edits a field in Jira" becomes: **it edits one field — the description — of one
issue — the QA sub-task it created for that story — and nothing else.** No story field, no other
issue's field, no status transition, no assignment, no deletion. The adapter enforces it: the issue
must carry the label, have the story as parent, and the summary must carry the prefix.

attestqa's own QA sub-task is skipped when reading the story, so a run never reads yesterday's test
cases as today's requirements.

## Consequences
The tests and their results are visible in Jira where the team works. If a project has no sub-task
type, the record is posted as a comment on the story instead, and the result says so. Xray/Zephyr
integration stays on the roadmap for teams that have them.
