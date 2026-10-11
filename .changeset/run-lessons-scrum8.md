---
"attestqa": minor
---

Lessons from the first Jira runs (SCRUM-8 on Juice Shop). Triage now decides two kinds of failure that never reached the product instead of guessing: a failure inside a `beforeEach`/`beforeAll` hook is environmental (nothing in the test body ran), and an invalid selector is the test's fault and is no longer upgraded to a "defect candidate" just because it repeats. The live line no longer presents the no-pattern default as a product defect ("matched no known failure pattern — held for you as possible defects, at low confidence"). Test-design coverage only counts a scenario as testing an item when it is the same type of test, so a security item is not reported "already tested" by a functional scenario on the same criterion.
