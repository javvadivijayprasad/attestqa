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
2. **Open your Playwright project folder** and run **attestqa: Set up this folder** (also offered
   in the empty **attestqa** view). It asks four questions — Jira or Azure DevOps, which stories
   the agent may work on, where your application runs, and which model your company uses (GitHub
   Copilot; Claude through the company gateway, set up as for Claude Code; an Anthropic key; Azure
   OpenAI; or another gateway) — and writes `ai-quality.config.yaml`
   and a `.env` with empty lines for your keys and test account.
3. **Fill in `.env`**, then run **attestqa: Dry run** to check the setup without spending anything.
4. **Command Palette → attestqa: Run story…** and enter `SHOP-12` (Jira) or `123` (Azure DevOps).
   Progress appears in the notification and the **attestqa** output panel.
5. When the design is ready, a dialog lists it item by item. **Approve**, or close the dialog to
   deny. The status bar shows **attestqa: approval needed** until you answer.

## Commands

| Command | What it does |
| --- | --- |
| **attestqa: Set up this folder** | Runs `aqa init`: writes the config and a `.env` to fill in, after four questions |
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

## In Copilot Chat

Type `@attestqa write tests for SHOP-12` in Copilot Chat. The run is the same as **Run story…**:
the engine does the work, progress appears in the chat, and the approvals come in attestqa's own
dialog — nothing is approved by typing. `@attestqa /dryrun SHOP-12` checks the setup without
spending anything; `@attestqa /coverage` and `@attestqa /setup` open those. When the project is set
up for GitHub Copilot, the run uses the model picked in the chat's model menu.

attestqa does not hand its tools to Copilot's Agent mode: there Copilot would run the loop, and the
rules that stop a test from being weakened would not apply.

## Using your GitHub Copilot plan

Choose **GitHub Copilot** in **Set up this folder** and pick one of the models VS Code offers. The
first time, VS Code asks whether attestqa may use your Copilot models. During a run the extension
relays the engine's model calls to Copilot through a private address on your machine, guarded by a
token made for that run, and logs only which model answered — never the prompt or the reply.
Usage counts against your Copilot plan, and because Copilot reports no token counts, the run
record's token figures are estimates. Copilot runs start from VS Code only.

## Two things it will not do

- **Approve by default.** Closing the dialog denies; there is no "approve all".
- **Touch your credentials.** They stay in `.env` or your environment and reach attestqa through the
  environment, never through the extension.

## Links

[User guide](https://github.com/javvadivijayprasad/attestqa/blob/main/packages/core/docs/USAGE.md) ·
[Roadmap](https://github.com/javvadivijayprasad/attestqa/blob/main/ROADMAP.md) ·
[Issues](https://github.com/javvadivijayprasad/attestqa/issues) · MIT licence
