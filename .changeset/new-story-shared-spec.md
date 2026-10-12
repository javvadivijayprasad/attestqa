---
"attestqa": patch
---

A new story whose tests go into a spec other stories' tests already fill no longer deadlocks. The route records `sharedSpec` when the epic's spec already has implemented tests; scaffolding stays refused (it would regenerate those tests), and the new story's tests are written by hand beside them — each tagged `@story:<id>` and `@design:<Dn>` — while every existing test keeps its assertions. The scaffold refusal now says that writing by hand is the next step.
