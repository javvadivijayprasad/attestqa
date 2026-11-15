---
"attestqa": patch
---

The tests of a Scenario Outline are recognised as their story's own. Such tests are written once with the row's value in the title (`age ${example.age}`) and reported as "age 75"; a failing one was reported as belonging to another story and was neither repaired nor filed. An in-place edit of a file with Windows line endings no longer makes the run lose its view of that file. A test that fails once and passes when the suite is run again unchanged is reported as unstable even when another test is edited later in the run; before, the run ended blocked for modifying it. A run can no longer write the steps of another story's unfinished (skipped) test, and an in-place edit whose text contains a masked value such as `[IP]` is now checked by the same write rules as any other edit; before, such an edit bypassed them.
