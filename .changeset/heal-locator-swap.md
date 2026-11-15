---
"attestqa": patch
---

A repair can no longer point an assertion at a different element to make a test pass. On a run that only executes existing tests, a failing check that a product name is displayed was changed into a check that an unrelated, always-present checkbox is visible, and the suite was reported green. Moving an assertion to another locator is now allowed only when the new locator still names the same text, label or accessible name. Two causes behind it are also fixed: on files with Windows (CRLF) line endings a multi-line edit was not checked by the write rules at all, and a run that reused its design without reading any file could not tell its own tests from another story's, so it tried to repair tests that were not its own.
