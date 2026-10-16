---
"attestqa": minor
---

GitHub Copilot as a model route: `provider: vscode-copilot`. VS Code lends Copilot's models only to extensions, so the attestqa VS Code extension relays a run's model calls to VS Code's Language Model API through a private 127.0.0.1 address with a per-run token (`AQA_VSCODE_LM_ENDPOINT`, `AQA_VSCODE_LM_TOKEN`). Outside VS Code the route stops at once with an explanation. Copilot reports no usage, so token figures are recorded as estimates (`usage.estimated: true` in the ledger). `aqa init` offers it as option 5.
