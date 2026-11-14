---
"attestqa": patch
---

A run no longer changes another story's failing test. In a shared epic spec, a run for one story narrowed the accessibility scan of another story's failing test until it passed, hiding the violation the scan had reported. A run was already kept off other stories' passing tests; it is now kept off their failing tests too, and such a failure stays in the report as that story's.
