---
"attestqa": minor
---

A run that starts on the execute path now switches to "complete" when the approved test design adds items no scenario covers, so the new scenarios can be written; existing scenarios must stay byte for byte. A known-bug marker (`test.fail(true, "Bug #X …")`) added to a test that is not tagged `@bug:X` is refused when proposed: it turns an unexplained failure into a pass.
