---
"attestqa": patch
---

A run is no longer blocked because page objects of other epics navigate to an absolute address. The check now covers the specs the run touched, the page objects those specs import, and the page objects the run wrote. Other page objects with an absolute address are named in the run's limitations for the reviewer, and are checked in the run of the story whose tests use them.
