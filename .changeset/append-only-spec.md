---
"attestqa": patch
---

After a re-route to append-only completion, the new design item's test is written into the existing spec by hand (scaffold stays refused, since it would regenerate implemented tests). A new rule keeps that safe: every test already in the spec keeps all of its assertions, and each new test carries the @design tag of an item being completed.
