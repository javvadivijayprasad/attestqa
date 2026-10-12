---
"attestqa": patch
---

A spec write that wraps a step of a test in a fallback (`try/catch` or `.catch(...)`) is now refused when it is proposed, not only by the verifier at the end of the run. Only a fallback the write introduces is refused; rewriting a test to remove one is still allowed.
