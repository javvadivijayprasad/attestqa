---
"attestqa": major
---

Ledger 2.0. New ledgers are written with `tool: "attestqa"`; ledgers written as "agentic-qa" (every run before the rename, including the Paper I corpus) still load, replay and report exactly as before. Three new event kinds record what people do: `ruling` (a decision about what the software should do, citable by later runs), `user_edit` (a change made through attestqa by a person, never claimable by the agent) and `run_aborted` (written by the host when a run's process dies without an `end`; replay reports such a run as aborted).
