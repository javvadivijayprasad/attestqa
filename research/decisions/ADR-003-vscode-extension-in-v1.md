# ADR-003 — A thin VS Code extension ships in v1.0.0

Date: 2026-10-12 · Status: accepted · Changes: D9 (sign-off, 10 Oct 2026)

## Context
D9 parked the VS Code extension until the web version (v3.0–v3.1). An extension already exists from
agentic-qa (0.1.x / 1.0.0 as `agentic-qa-vscode`): commands to run a story, a dry run, a runs tree
read from the ledger, and approvals answered in the editor through `--approval file`. Vijay decided
on 12 Oct to publish attestqa on the VS Code Marketplace with the first release, because the
Marketplace is where his other tools (bdd2pw, sel2pw, usagecontract) already reach users.

## Decision
v1.0.0 includes a **thin** extension, `attestqa-vscode`, publisher `vijaypjavvadi`:

- It drives the `aqa` CLI the user installed; it bundles no engine and adds or removes no rules.
- Approvals use the existing file-approval contract, shown as a dialog; closing it denies.
- Commands: run a story (Jira key or Azure DevOps id), dry run, answer the pending approval, show
  coverage, replay a run, check rules on recent runs, show the runtime version; a runs view.
- It lives in `packages/vscode`, versioned with the product release (1.0.0 in v1.0.0), tagged
  `attestqa-vscode@1.0.0` per ADR-002.

Anything beyond that — design editing in the editor, inline results on tests, a webview dashboard —
stays with the web version as D9 planned.

## Consequences
About a week of v1.0.0's slack goes to the extension (moving it, renaming, Jira support, coverage
and check-rules commands, packaging, Marketplace listing). The extension's contract with the engine
is the CLI flags, exit codes, ledger layout and approval file format — already contract surface in
TECHNICAL.md, so a change there is a major engine version.
