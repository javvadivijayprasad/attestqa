---
"attestqa": minor
---

Jira stories run end to end. Set `JIRA_BASE_URL` with `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud) or `JIRA_PAT` (Data Center) in `.env`, and `aqa run "Write tests for SHOP-12"` reads the story from Jira (`--tracker jira|ado` overrides the guess). The agent sees the four Jira tools instead of the Azure DevOps ones; Jira keeps no test cases, so none are asked for and the feature file's `@story` tags are the record; the run report stays with the run. Every bug rule — held to the end of the run, asked about on its own, refused while the environment was down, refused as a duplicate — now applies to `jira.create_bug` through one shared view of a proposed bug. Fixed: story facts read back from the ledger turned a Jira key into NaN.
