---
"attestqa": minor
---

New `aqa init`: sets up a Playwright project in one step. It asks for the tracker (Jira or Azure DevOps), the stories the agent may work on and the application's address, then writes a valid `ai-quality.config.yaml`, a `.env` with empty credential lines (never overwritten; an existing one is only checked for missing names, never read for values) and `.gitignore` lines for `.env` and `.aqa/`. Flags (`--tracker`, `--scope`, `--url`, `--dir`, `--force`) replace the questions where there is no terminal.
