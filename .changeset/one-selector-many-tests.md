---
"attestqa": patch
---

One broken selector shared by several tests is now one repair. `fs.replace_in_file` takes `all: true` to change every occurrence (judged by the rules as the write it amounts to); when `old` is not found, the error names the closest real line and says when the model escaped quotes the file does not have. `aqa.heal_locator` lists the other tests the last run lost to the same selector and says to fix them in one call. Triage recognises `waiting for getByRole(…)` and `element(s) not found` as a locator that matched nothing, not a possible defect at 0.1.
