---
"attestqa": minor
---

New `aqa coverage --workspace <project> [--ledger .aqa] [--story <id>] [--out <file>] [--json]`. For each story it shows the last approved test design, the scenario and test that implement each design item (matched by `@story` and `@design` tags only), and the last recorded result — passing, known bug reproduced, known bug not reproduced, failing, not run, or no test — plus acceptance criteria with no test and scenarios outside the design. Offline: no model, tracker or browser. Exits 0 when every item is covered and green, 3 otherwise. `storyCoverage` and `renderCoverage` are exported for use as a library.
