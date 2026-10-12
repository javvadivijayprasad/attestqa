---
"attestqa": patch
---

When a test catches its own failure, the verifier now quotes the offending line and says how to remove it, and says a green suite does not close the gap. The terminal shows the whole first sentence of a gap, including what follows a colon, instead of stopping at the colon.
