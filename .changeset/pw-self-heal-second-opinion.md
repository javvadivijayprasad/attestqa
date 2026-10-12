---
"attestqa": minor
---

`aqa.heal_locator` now also ranks the candidates with pw-self-heal (heuristic mode, suggest-only) and returns its choice as `secondOpinion`, including whether it agrees with attestqa's own ranking. Nothing is applied: the repair is still a spec write the story rules check, and attestqa's own ranking still decides the verdict. Triage now uses pw-self-heal's stale-element class: a page, frame or element torn down mid-action ("Execution context was destroyed…") is a flake with its own explanation, not a real defect at 0.1 confidence.
