---
"attestqa": minor
---

New `aqa check-rules <run-dir>... --config <file>`: replays each recorded run's proposals through today's rules offline (no model, no tools, no network), lists every decision that would now differ, and probes the run's end point for a rule deadlock (no way left to write a missing design item's test); exits 2 on a deadlock. Fixed the deadlock it found: after a re-route from the execute path to completion, "write the feature first" and the verifier's hand-written-spec check no longer apply — the new test is written by hand beside the existing ones, as the scaffold guard asks.
