---
"attestqa": patch
---

Heal names the failing locator on a test timeout (the stuck action is read from Playwright's later error entry, not only the first "Test timeout" line) and matches accessible names ignoring spacing, case and punctuation, so a click waiting on "Log in" is pointed at the button named "Login". A Jira bug In Progress now counts as known broken, so its confirmation test is expected to fail, as an Azure DevOps Active bug's is.
