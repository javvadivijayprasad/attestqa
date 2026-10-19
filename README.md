# attestqa

Governed, open-source end-to-end testing for any website. A model your company already pays for writes and runs ordinary Playwright tests in a folder you own, and attestqa refuses — in code, not in a prompt — to make a failing test pass by weakening it. Every step is written to a ledger you can audit.

Status: **first release, v1.0.0, on 15 November 2026** (`attestqa` 2.0.0 on npm, the attestqa
extension on the VS Code Marketplace). The design set was approved on 10 October 2026
(`Docs/00_Signoff.pdf`).

## Start here

- **[User guide](packages/core/docs/USAGE.md)** — install, set up a project, run a story from Jira or
  Azure DevOps, approve the design, read coverage and the ledger, use it from VS Code.
- **[Roadmap](ROADMAP.md)** — what ships each month, and the later stages (API, web version,
  security, ETL).
- **Try it:** `npm install -g attestqa`, then `aqa init` in your Playwright project (section 3 of the user guide).
- **[Dependencies](DEPENDENCIES.md)** — what attestqa needs: Node, packages, the services it talks to, and the evaluation apps.

| Folder | Holds |
|---|---|
| `packages/core` | The governed runtime and the `aqa` CLI, published on npm as `attestqa` (history imported from agentic-qa) |
| `packages/vscode` | The VS Code extension, `attestqa-vscode` on the Marketplace — a thin client of the `aqa` CLI |
| `packages/*` | Other shared packages (`@attestqa/ui`, `@attestqa/client`, provider and sign-in plug-ins) as they arrive |
| `Winapp/` | The Windows desktop app (from v1.2.0) |
| `WebApplication/` | The web version, `@attestqa/server` (from v3.0.0) |
| `TestRunApplication/` | One plain Playwright project per site under test, plus `targets.yaml` |
| `Docs/` | Product, design, HLD, LLD, plan, test strategy, packaging and publishing documents (PDF), with sources |
| `research/` | Findings, decisions, hypotheses, run manifest and weekly journal |

Releases: a new major number for each stage (v1 web, v2 API, v3 web version, v4 security, v5 ETL), the middle number for the monthly releases, the last for fixes. Licence: MIT.
