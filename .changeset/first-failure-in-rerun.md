---
"attestqa": patch
---

A test that fails for the first time in the automatic re-run gets one more unchanged run before it is judged. Before, the single re-run was spent on the first failure, a further full run was refused as unchanged, and a suite that failed a different test on a cold start could end the run blocked.
