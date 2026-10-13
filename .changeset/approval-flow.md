---
"attestqa": minor
---

Three decisions per Jira story, in order. Approving the test design now also posts its test cases to the story's QA sub-task straight away (the prompt says so); new optional `agent.approve_execution: true` makes the first suite run of each run wait for a person, with later re-runs going ahead under that approval; bugs are still put to you after execution. The results comment follows at the end under the design approval. New `Skill.afterApproved` hook for runtime calls covered by an approval already given. Fixed: after an in-place edit (`fs.replace_in_file`), re-reading the changed lines was refused as "nothing has changed", and the rules judged later edits against the file as it was before the edit.
