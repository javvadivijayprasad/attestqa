---
"attestqa": minor
---

Story ids can be Jira keys. `@story:SHOP-12` tags, epic file names (`epic-shop-1-checkout.feature`), bug and task references and the shared-file rules all accept a Jira key beside an Azure DevOps number; Azure DevOps ids behave exactly as before. New `gatherJiraStoryContext` reads a Jira story, its epic and sibling stories, sub-tasks, comments and open bugs into the same facts the Azure DevOps reader produces, leaving out the runtime's own run reports and Bugs.
