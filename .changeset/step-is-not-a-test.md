---
"attestqa": patch
---

A `test.step(...)` or `test.describe(...)` is no longer read as a test. Every rule that reads a spec by test (coverage, the weakening and append-only rules, heal, the role choice, the scaffold-overwrite guard) now sees each test's whole body and the right test count.
