---
"attestqa": patch
---

After a re-route to append-only completion, only the scenarios that existed at the re-route are locked; the run can correct the scenarios it adds. Each new design item gets exactly one scenario, and once every new item has one, further feature edits are refused until `bdd2pw.analyze` has run, so the run moves on to analyze and scaffold instead of rewording.
