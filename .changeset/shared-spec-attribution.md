---
"attestqa": patch
---

In a spec that several stories share, a run now attributes scenarios, tests and bugs to the right story. Two stories may have scenarios with the same title without one being read with the other's tags. Two bugs under the same acceptance criterion that are about different failing tests are both put to the reviewer; before, the second was dropped as a duplicate, which lost a real defect. A file read by line range that covers the whole file counts as a full view, so the run knows which tests are its own, and a red suite no longer asks the run to finish another story's unimplemented tests. On Jira, a failing test whose bug an earlier run filed, still open and linked to the story, is counted as reported instead of blocking the next run.
