---
"attestqa": patch
---

When `synthdata.examples` is available and an acceptance criterion states a number range ("aged 18 to 74"), a test design with a boundary-value or equivalence-partitioning item on that criterion is sent back until the tool has been called for that range with the `edge` and `negative` profiles. Before, the skill only asked for the call and the model could skip it. Ranges of text length are not affected, and nothing changes for a project that has not set `SYNTHDATA_CLI`.
