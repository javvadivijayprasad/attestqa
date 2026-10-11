---
"attestqa": minor
---

Takes bdd2pw 4.5.0 (pw-emit 1.4.0). Scaffolds now pass `--spec-name`, so an epic's spec is named after its feature file (`features/epic-scrum-5-…feature` → `tests/epic-scrum-5-….spec.ts`), the path every rule and the verifier already expected. The scaffold result reports where each step's code came from, counted from bdd2pw's `// @bdd2pw lane=rule|llm|todo` provenance comments. The agent's browser and generated suites default to the installed Chrome (`AQA_BROWSER`, `PW_CHANNEL` to change it). The design checker accepts Jira task and bug keys as sources.
