---
"attestqa": patch
---

The Jira QA sub-task's description now gives each test case in BDD form: the Gherkin scenario its test is generated from (with the feature's Background), under a summary table of ID, criterion, type and scenario. A case whose scenario is not written yet shows its conditions and expected result until the next refresh. Cloud renders the scenarios as code blocks; Data Center as `{noformat}`.
