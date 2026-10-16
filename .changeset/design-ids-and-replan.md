---
"attestqa": patch
---

The design check now keeps a design's numbers in step with the feature file before anyone is asked to approve it. An item that one of the story's existing scenarios already tests must use that scenario's `@design` id; a scenario the story already has but the design leaves out is named; and a number another story owns in the shared epic file is refused with the next free one suggested. An accessibility item that covers the story now matches the story's existing scenario of the same type, instead of being treated as new. When a revised design is approved during an append-only completion, the plan is recalculated from that latest approval.
