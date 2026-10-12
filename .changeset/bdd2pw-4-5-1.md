---
"attestqa": patch
---

Requires bdd2pw 4.5.2 (4.5.1's fixes plus HTTP-worker support for them), which no longer writes `page.locator("")` or blanks a page object it cannot read. When bdd2pw cannot reach the application's pages (exit 4), the tool result now says so plainly (`cause: "discovery-failed"`) and tells the agent to fix the environment rather than the feature file.
