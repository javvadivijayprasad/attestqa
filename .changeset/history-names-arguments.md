---
"attestqa": patch
---

The agent's history now shows each call's key arguments (paths, urls, ids, modes; long text by length only), so two calls of the same tool can be told apart. Without them an agent that had analyzed its new feature file read the result as the old file's and analyzed it again until the run stopped (AB#1). The tag check also now says which tag to change: "(@design:D2) — replace @type:security with @type:functional" instead of "needs @type:functional", which the agent could not act on and rewrote the same tag line 16 times.
