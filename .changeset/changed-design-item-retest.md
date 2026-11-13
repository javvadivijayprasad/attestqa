---
"attestqa": patch
---

When a story changes and the newly approved design gives an existing test a different expected result, the run now updates that test instead of running it unchanged. Before, such an item was reported as "already tested", the old test failed on the earlier expectation, the failure was treated as a moved locator, and nothing was corrected. Now the design tool's result and the approval note name the changed items with what they expected before and expect now; the run may rewrite the scenarios and tests of those items and no others; the suite's first automatic run waits a few turns for those edits; and their failures are no longer sent to the locator healer. Tests of unchanged items stay protected as before.
