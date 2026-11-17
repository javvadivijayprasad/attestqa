---
"attestqa": patch
---

`aqa eval` scores the values in a design more truly. A value the design item quotes from a project document now counts as held. The names, email addresses and sample values a test types in are no longer counted as wrong or invented values: only what the design asserts about the application is. A design that holds none of the expected values scores 0 instead of having no score, so its story stays in the comparison of search off against on.
