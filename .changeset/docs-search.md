---
"attestqa": minor
---

The agent can search the project's own documents during test design. With `agent.knowledge.paths` set and `docs` added to `--servers`, a new read-only tool, `docs.search`, returns up to five passages from the index `aqa index` built, each with its file, heading, line range, the date the file was last changed and an id. The agent is told to search when a criterion names a rule without its value, to use the story's value when the story states one, to name the passage in the item's source (`doc:<passage id>`), and to say "not found in the project documents" when no document has it. Every search and its result are recorded in the ledger like any other call. The index is never rebuilt by a run: when the documents have changed since it was built, the result says so. Without `docs` in `--servers`, a run and its prompt are unchanged. The check that a cited passage holds the quoted value follows in the next change.
