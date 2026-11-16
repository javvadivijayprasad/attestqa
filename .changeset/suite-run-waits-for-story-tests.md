---
"attestqa": patch
---

The runtime no longer runs the suite before a story has any test of its own. When a new story is added to an epic file that other stories already have tests in, the suite used to run the moment the design was approved: a run of the other stories' tests, repeated when one of them failed, before anything was written for this story. The agent could then take a neighbour's tests for its own and report the story done. The first run now waits until the approved design items have tests, or until the agent says it has finished.
