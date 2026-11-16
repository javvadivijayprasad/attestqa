---
"attestqa": minor
---

`aqa index` builds a search index of the project's own documents. Name the folders or files in a new optional setting, `agent.knowledge.paths`, and the command cuts their Markdown and plain-text files into passages at the headings and writes the index to `<ledger>/knowledge/`, with a manifest of what it read. Ranking is by keyword (BM25), in the package itself: no model, no key, and nothing leaves the machine. Run reports, failure snapshots, credential files and `node_modules` are never indexed, and the index is never rebuilt by itself. This is the first part of document search (ADR-008): in this change the index is only built, and a run is the same with or without the setting. A config that does not use the setting keeps its config hash.
