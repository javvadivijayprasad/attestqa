# Changelog

## 1.0.1

- `aqa.envFile` can list several credential files, comma-separated (`.env.toolshop,.env`), as `aqa run --env` takes them. Before, the list was checked as one file name, `--env` was left out, and the run read `.env` alone.

## 1.0.0 — attestqa release v1.0.0 (15 November 2026)

First release as **attestqa** (previously the agentic-qa extension).

- Run a story from **Jira** (`SHOP-12`) as well as Azure DevOps (`123`, `AB#123`).
- The test design approval is shown item by item — coverage, type, technique, conditions,
  expected result, exclusions — instead of a truncated argument list.
- **@attestqa in Copilot Chat**: `@attestqa write tests for SHOP-12` starts the same governed run,
  with progress in the chat and approvals in attestqa's dialog; `/dryrun`, `/coverage`, `/setup`.
- **GitHub Copilot**: run stories on your Copilot plan. The extension relays the engine's model
  calls to VS Code's Language Model API through a private, per-run address; requires VS Code 1.95+.
- New command **Set up this folder** (runs `aqa init`), also offered in the empty Runs view.
- New commands: **Show coverage**, **Check rules on recent runs**, **Open the user guide**.
- New setting `aqa.envFile`; `aqa.workspaceDir` now defaults to the open folder.
- Progress notification shows the CLI's own progress lines.
- The Runs view describes today's ledger events (route, role, triage, refusals, verifier).
- Fixed: starting `aqa.cmd` on Windows failed with `spawn EINVAL` on current Node.js.


The extension and the runtime version independently. This file covers the extension only; the
runtime's own changes are in the repository root `CHANGELOG.md`.

## [0.1.0] — unreleased

First version. Two capabilities, chosen because a terminal does them badly.

### Added

- **Approval dialog** over the runtime's existing `--approval file` contract. Watches
  `<ledgerDir>/runs/*/approvals/*.json` for a record with `decision: null`, shows the whole batch —
  every call and every argument — and writes the answer back as `approved` or `denied` with
  `by: "vscode:<user>"`.
  - Dismissing the dialog denies. So does failing to write the decision, which the run sees as a
    timeout; the extension says so rather than letting you believe you approved something.
  - Approve is never the default button.
  - **Open the request** opens the JSON and leaves the approval pending, with a status bar item to
    re-ask. Reading four arguments properly is worth more than answering quickly.
- **Runs view** listing `.aqa/runs/` newest first with status and event count, expanding to the
  event sequence; clicking an event opens the recorded JSON. Refreshes while a run is writing.
- **Commands**: run a story, dry run, replay, show runtime version.
- **Runtime discovery** — `aqa.executablePath`, then the workspace's `node_modules/.bin`, then
  `PATH`; offers a global install in a visible terminal when nothing is found.
- Exit codes are reported for what they mean: `2` blocked and `3` refused are the governance
  machinery working, not failures, and are reported as warnings rather than errors.

### Deliberately absent

- **No config editor.** `ai-quality.config.yaml` is the team's policy and belongs in the repository
  under review, not behind a settings form that makes it read like a preference.
- **No bundled runtime.** The ledger event shapes are a contract; pinning the runtime to the
  extension's release cycle would force an upgrade on anyone relying on them.
