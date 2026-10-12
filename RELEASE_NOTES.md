# attestqa v1.0.0 — 15 November 2026

The first public release of attestqa: governed, open-source end-to-end testing for web
applications. Point it at a user story in **Jira or Azure DevOps**; approve the test design it
proposes; get ordinary Playwright tests in a folder you own — written, run, triaged and repaired
under rules that refuse, in code, to make a failing test pass by weakening it. Every step is in a
ledger you can replay.

## Install

```bash
npm install -g attestqa        # the engine and the aqa command (Node.js 20+)
```

VS Code: install **attestqa** from the Marketplace (publisher `vijaypjavvadi`), or the `.vsix`
attached to this release.

Then follow the [user guide](packages/core/docs/USAGE.md) — about ten minutes to set up a project.

## In this release

- Jira and Azure DevOps stories, read with their epic, sub-tasks, comments and open bugs.
- A test design — functional, security, accessibility, confirmation — approved by a person before
  any test is written.
- Playwright tests generated with bdd2pw into your own project, tagged to story and design item;
  new stories added beside existing ones without touching them.
- Failure triage, and locator repair from the page as it was at the failure, with pw-self-heal as a
  second opinion.
- `aqa coverage`, `aqa replay` and `aqa check-rules` — all offline, from the ledger and your files.
- Anthropic, OpenAI, Azure OpenAI, a local model or your company gateway.
- A VS Code extension: run a story, approve the design in the editor, see coverage and runs.

## Packages

| Package | Version |
| --- | --- |
| `attestqa` (npm) | 2.0.0 |
| `attestqa-vscode` (Marketplace) | 1.0.0 |
| bdd2pw / pw-emit / pw-self-heal (dependencies) | 4.5.2 / 1.4.0 / 1.2.2 |

`attestqa` 2.0.0 replaces the 1.x engine published from agentic-qa; the ledger format changed. What
comes next is in the [roadmap](ROADMAP.md).
