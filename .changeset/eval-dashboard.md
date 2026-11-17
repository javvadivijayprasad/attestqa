---
"attestqa": minor
---

`aqa eval --html <file>` writes the evaluation as one page: the agreed bars, each story with the search off and on, the search's own results by kind of question, a table of every run, and under each run its design items with the passage each cites and the quoted words marked. It is a single self-contained file that fetches nothing, so it opens from disk and nothing about the project leaves the machine. `eval.json` now also holds, per run, the design items and the passages they cite.
