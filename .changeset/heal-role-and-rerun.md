---
"attestqa": patch
---

The heal role is chosen for a "test that catches its own failure" only when the catch is in that test's own body, not anywhere in the spec (a `beforeEach` that dismisses a pop-up with `.catch(() => {})` no longer pulls every failing test into a five-tool heal). An edited `.feature` file no longer triggers an automatic suite run on its own: nothing executes differently until `bdd2pw.scaffold` regenerates the spec, and a scaffold now counts as a change.
