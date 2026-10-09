# attestqa

Governed, open-source end-to-end testing for any website. A model your company already pays for writes and runs ordinary Playwright tests in a folder you own, and attestqa refuses — in code, not in a prompt — to make a failing test pass by weakening it. Every step is written to a ledger you can audit.

Status: **in development.** The design set was approved on 10 October 2026 (`Docs/00_Signoff.pdf`). The first release, v1.0.0, is planned for 15 November 2026.

| Folder | Holds |
|---|---|
| `packages/core` | The governed runtime and the `aqa` CLI, published on npm as `attestqa` (history imported from agentic-qa) |
| `packages/*` | Other shared packages (`@attestqa/ui`, `@attestqa/client`, provider and sign-in plug-ins) as they arrive |
| `Winapp/` | The Windows desktop app (from v1.2.0) |
| `WebApplication/` | The web version, `@attestqa/server` (from v3.0.0) |
| `TestRunApplication/` | One plain Playwright project per site under test, plus `targets.yaml` |
| `Docs/` | Product, design, HLD, LLD, plan, test strategy, packaging and publishing documents (PDF), with sources |
| `research/` | Findings, decisions, hypotheses, run manifest and weekly journal |

Releases: a new major number for each stage (v1 web, v2 API, v3 web version, v4 security, v5 ETL), the middle number for the monthly releases, the last for fixes. Licence: MIT.
