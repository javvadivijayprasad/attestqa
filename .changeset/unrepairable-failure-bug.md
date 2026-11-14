---
"attestqa": patch
---

A failing test that cannot be repaired no longer keeps the run in the repair step. When the repair tool finds that the element a test waits for is not on the page, the run returns to its normal role, where it can correct the test or propose a bug. Before, a run that only executes existing tests stayed in the repair step, which cannot propose bugs, and ended blocked with a real defect unreported. The "suite not green" message now names the failing tests that have no bug and says what can be done about each. On Jira, a bug that an open bug linked to the story already records is refused as a duplicate also when its title is worded differently.
