---
"attestqa": patch
---

A story whose acceptance criteria are reworded is now designed again. The story fingerprint, which decides whether an approved design can be reused, read only the criteria's labels (AC-1, AC-2), so editing what a criterion says left the story "unchanged": the earlier design was reused and the run only executed the existing tests. The fingerprint now includes the full wording of the acceptance criteria and the description, for Azure DevOps and Jira. Runs recorded before this release did not keep the wording, so the first run of each story after upgrading asks for its design once more, and the route line says that is the reason.
