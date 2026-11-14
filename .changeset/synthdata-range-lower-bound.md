---
"attestqa": patch
---

`synthdata.examples` now says when the invalid value below a range's minimum is missing from its rows. synthdata 1.4.0 returns only the value above the maximum (75 for "18 to 74", never 17), and the tool's description had promised both. The answer names the column and, for whole numbers, the missing value, so the agent adds it to the design and the Examples table.
