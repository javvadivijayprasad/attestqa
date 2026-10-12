# attestqa for VS Code

Write Playwright tests from your **Jira or Azure DevOps** stories — and approve what gets tested
before anything is written. This extension is a thin client of the
[attestqa](https://www.npmjs.com/package/attestqa) command line: it starts runs, shows their
progress, puts the approval in front of you, and opens coverage and the run record. Every rule lives
in attestqa itself; the extension adds none and removes none.

## What a run does

You give it a story. attestqa reads the story, its epic, sub-tasks, comments and open bugs, and
proposes a **test design** — one line per test, with what it must observe. **You approve it in a
dialog.** It then writes ordinary Playwright tests into your project, runs them, triages any
failures and repairs broken locators, and refuses — in code — any change that would make a failing
test pass by weakening it. Everything is written to a ledger you can replay. The tests run with
plain `npx playwright test`, without attestqa.

## Get started

1. **Install the CLI** (Node.js 20+): `npm install -g attestqa`. If the extension cannot find
   `aqa`, it offers to install it or to point at an existing one.
2. **Open the folder** that holds your `ai-quality.config.yaml` and `.env`. The
   [user guide](https://github.com/javvadivijayprasad/attestqa/blob/main/packages/core/docs/USAGE.md)
   shows how to write both — about ten minutes, once per application.
3. **Settings → attestqa**: set **Workspace Dir** to your Playwright project (default: the open
   folder) and check **Config File**.
4. **Command Palette → attestqa: Run story…** and enter `SHOP-12` (Jira) or `123` (Azure DevOps).
   Progress appears in the notification and the **attestqa** output panel.
5. When the design is ready, a dialog lists it item by item. **Approve**, or close the dialog to
   deny. The status bar shows **attestqa: approval needed** until you answer.

## Commands

| Command | What it does |
| --- | --- |
| **attestqa: Run story…** | Runs `aqa run` for a Jira key or an Azure DevOps id, with approvals answered in the editor |
| **attestqa: Dry run** | Shows which tools would be allowed, with no model call and nothing spent |
| **attestqa: Answer the pending approval** | Reopens a waiting approval |
| **attestqa: Show coverage** | For each story: the approved design, the test for each item, and its last result |
| **attestqa: Replay the latest run** | The run as Markdown, rendered from the ledger alone |
| **attestqa: Check rules on recent runs** | Re-judges past runs against the current rules, offline |
| **attestqa: Open the user guide** | The full guide in your browser |

The **attestqa** view in the activity bar lists runs and each run's events; click an event to see
it in full.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `aqa.configFile` | `ai-quality.config.yaml` | the config, relative to the open folder |
| `aqa.workspaceDir` | `.` | the Playwright project tests are written into |
| `aqa.envFile` | `.env` | credentials file, passed to `aqa` by name — the extension never reads it |
| `aqa.ledgerDir` | `.aqa` | where run records go |
| `aqa.approvalTimeoutSeconds` | `1800` | an unanswered approval counts as denied after this |
| `aqa.executablePath` | (empty) | a specific `aqa`; empty means `node_modules/.bin`, then `PATH` |

## Two things it will not do

- **Approve by default.** Closing the dialog denies; there is no "approve all".
- **Touch your credentials.** They stay in `.env` or your environment and reach attestqa through the
  environment, never through the extension.

## Links

[User guide](https://github.com/javvadivijayprasad/attestqa/blob/main/packages/core/docs/USAGE.md) ·
[Roadmap](https://github.com/javvadivijayprasad/attestqa/blob/main/ROADMAP.md) ·
[Issues](https://github.com/javvadivijayprasad/attestqa/issues) · MIT licence
