---
"attestqa": patch
---

A design item is no longer recorded as "not written yet" when another story in the same feature file has a scenario with the same title. The QA record and `aqa coverage` now read each scenario and each test with the tags written above it, instead of looking the tags up by title.
