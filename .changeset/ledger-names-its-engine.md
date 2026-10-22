---
"attestqa": patch
---

Every run's ledger now records what produced it, in its first (request) event: the attestqa version, the git commit the engine was built from ("+dirty" if its source had uncommitted changes) and the bdd2pw version. `aqa --version` shows the commit too, and the research run manifest reads both. A run of an unreleased or older build is identifiable from its ledger alone, instead of from the bug it happens to hit.
