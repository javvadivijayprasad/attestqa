---
"attestqa": patch
---

A test whose page never finished loading is now recognised for what it is. Triage reads every error of the failed attempt (on a timeout, Playwright puts the stuck `page.goto` in a second entry, which was ignored), so the failure is classed as the environment; and when other tests in the same run passed, the application was reachable, so it is treated as a transient and run again rather than writing off the whole run. The progress line after a run with no failing test no longer says "suite is green" when tests with empty TODO steps remain.
