---
"attestqa": minor
---

Jira stories get one QA sub-task (ADR-004): its description holds the current test cases from the approved design, and each run adds a comment with every case's result — composed from the ledger and the test files, posted by the runtime at the end of the run after your approval (`jira.record_qa`). The description is rewritten only when the approved design changes; attestqa edits no other field of any issue, and skips its own QA sub-task when reading the story. Projects without a sub-task type get the record as a comment on the story.
