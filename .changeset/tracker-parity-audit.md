---
"attestqa": patch
---

An audit of the tracker rules, as a test. Every rule that judges a bug is given the same situation as an Azure DevOps call and as a Jira call, and the test records what each run is told. It shows that the six bug rules already refuse a Jira bug where they refuse an Azure DevOps one, and names three gaps for the next changes: one refusal tells a Jira run to pass `parentId` (the Jira argument is `storyKey`), one writes a Jira key as "#TOOL-83", and the defect-profile skill reads Azure DevOps only. `ENGINE_MAP.md` records this. No change to the package's behaviour.
