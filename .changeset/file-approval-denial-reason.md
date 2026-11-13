---
"attestqa": patch
---

A denial written to an approval file can say why. With `--approval file`, the decision file may now carry an optional `reason` beside `decision: "denied"`, and the agent is told it, exactly as it is told a reason typed at the terminal. Until now the file's reason was dropped: in an end-to-end run a test design was denied three times, each time with a reason written in the file, and the agent was told only "denied" and submitted the same design again until the run stopped. Additive: a file without `reason` behaves as before, a `reason` on an approval is ignored, and nothing else in the approval file changes.
