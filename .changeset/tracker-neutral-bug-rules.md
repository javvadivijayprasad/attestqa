---
"attestqa": patch
---

The rules that judge a proposed bug no longer name Azure DevOps. Each of the six reads one tracker-neutral description of the bug (its title, its steps, its story link and its tags) instead of an Azure DevOps call that a Jira bug was first dressed up as. Nothing a run is told changes: all 626 recorded runs were replayed through the rules before and after (913 tracker calls and proposals, 129 refusals) and every answer is word for word the same. The end-of-run bug settlement and the approval prompt still use the older view and move in their own change.
