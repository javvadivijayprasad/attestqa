---
"attestqa": patch
---

The first failure of a suite is now run again unchanged by the runtime itself, before the agent is asked anything. The engine already told the agent to do this ("run it again unchanged") and then refused the run as a repeat of unchanged files, so the advice could never be followed. The second run costs no model turn, happens once per run, and the agent's first view of a failure is of one that came back. A test that fails the first run and passes the unchanged second run is reported to the reviewer as unstable; it no longer blocks the run as a modified test.
