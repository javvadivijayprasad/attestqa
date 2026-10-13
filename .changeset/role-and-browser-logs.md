---
"attestqa": patch
---

The runtime's own calls at the end of a run (the Jira results comment, held bugs) are judged against the skill's whole toolset, not the active role's — a run that ended with the heal role active had its results post refused as "unknown tool". Playwright's "Browser logs:" block (the full Chrome command line when an installed Chrome is used) is removed from failure messages before they are cut to length, so the locator a stuck action was waiting for reaches triage and heal.
