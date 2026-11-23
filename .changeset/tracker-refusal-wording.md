---
"attestqa": patch
---

Two refusals now speak to a Jira run in Jira's words. A bug proposed without its story link was told to add `parentId`, an argument `jira.create_bug` does not have; it is now told to add `storyKey: "TOOL-6"`. A bug refused as a duplicate named the existing one as "#TOOL-83"; it is now "TOOL-83", in the refusal and in the run report (which still reads the older form from earlier run records). Nothing changes for Azure DevOps, and no bug is refused or allowed that was not before. The roadmap and the release plan are corrected to say what the tracker audit found: Jira bugs were already held to the same rules.
