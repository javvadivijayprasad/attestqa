---
"attestqa": patch
---

A test for a bug must be type "confirmation", and the design check now says so in those words. It used to say the item "is type confirmation", which made the agent change the type the wrong way, again and again (AB#1, 50+ submissions). Separately, the run now stops as blocked when the same design problem comes back on 6 submissions in a row, naming the problem, instead of spending the budget.
