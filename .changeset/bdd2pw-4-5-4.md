---
"attestqa": patch
---

Requires bdd2pw 4.5.4, which no longer rewrites an existing Page Object on a re-scaffold when it cannot read the Page Object's locators back. On 4.5.2, a run that scaffolded a story could empty a shared Page Object that other specs still used.
