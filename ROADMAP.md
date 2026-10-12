# Roadmap

attestqa ships on the **15th of every month**. A release ships with whatever is finished and tested;
unfinished work moves to the next month and the release notes say so. The full plan, with hours and
risks, is `Docs/05_Implementation_Plan.pdf`.

**Version numbers.** The product release (GitHub, release notes) is `v1.0.0`, `v1.1.0` … : a new
major for each kind of testing, a new minor each month, a patch for fixes. The packages inside keep
their own versions — the engine on npm, `attestqa`, goes from 1.1.0 (the old agentic-qa engine) to
**2.0.0** in v1.0.0, because the ledger format changed. Each release note lists the package versions
it contains.

---

## v1.0.0 — 15 November 2026 · web testing: the engine, the CLI and VS Code

From a user story in **Jira or Azure DevOps** to governed Playwright tests.

- Reads the story, epic, sibling stories, sub-tasks, comments and open bugs.
- Proposes a **test design** (functional, security, accessibility, confirmation) that a person
  approves before any test is written.
- Writes Playwright tests with bdd2pw into your own project, one feature file per epic, every
  scenario tagged to its story and design item; adds new stories beside existing ones without
  touching them.
- Runs the suite, triages failures, and repairs broken locators from the page as it was when the
  test failed — with pw-self-heal as an independent second opinion. Nothing is applied that the
  rules have not checked.
- Refuses, in code, any change that would make a failing test pass by weakening it.
- Writes every step to a ledger; `aqa replay` renders it, `aqa coverage` shows each story's design,
  tests and results, `aqa check-rules` re-judges past runs against today's rules.
- Any model your company already uses: Anthropic, OpenAI, Azure OpenAI, a local model, or your own
  gateway.
- **VS Code extension**: run a story, approve the design in the editor, see coverage and runs.

Packages: `attestqa` 2.0.0 (npm), `attestqa-vscode` 1.0.0 (Marketplace).

## v1.1.0 — 15 December 2026 · company sign-in, healing, Selenium import

- Company sign-in for the model: Microsoft Entra ID and AWS SSO, no stored key; AWS Bedrock as a
  provider.
- Locator repairs suggested from the page by pw-self-heal and **approved by a person**, with the
  before/after evidence (in v1.0.0 it ranks alongside attestqa's own repair but decides nothing).
- `aqa import selenium`: convert existing Selenium suites with sel2pw and bring them under the same
  rules.
- Generated test data with synthdata instead of hand-written values (moved from v1.0.0).
- bdd2pw page discovery in the installed Chrome or Edge.

## v1.2.0 — 15 January 2027 · the Windows app, Attest

The first signed Windows app: run stories, approve designs and read results without a terminal.

## v1.3.0 — 15 February 2027 · Requirements and Specify in the app

Review a story's requirements and shape the test design inside the app before approving it.

## v1.4.0 — 15 March 2027 · Explore; web testing complete

Guided exploration of an application to find what the stories do not say.

---

## Later stages

| Release | Date | Headline |
| --- | --- | --- |
| **v2.0.0** | 15 Apr 2027 | **API testing** |
| v2.1.0 | 15 May 2027 | API exploration; contracts from traffic |
| **v3.0.0** | 15 Jun 2027 | **Web version of attestqa** |
| v3.1.0 | 15 Jul 2027 | MCP and multi-user approvals |
| **v4.0.0** | 15 Aug 2027 | **Security testing** |
| v4.1.0 | 15 Sep 2027 | Active scanning |
| **v5.0.0** | 15 Oct 2027 | **ETL testing** — all four kinds of testing |

Dates beyond the next release are a plan, not a promise. Changes to the plan are recorded as
decision records in `research/decisions/`.

## Ideas and requests

Open an issue with the label `idea`. What gets built is decided by what users of the current
release run into — the troubleshooting section of the user guide is mostly made of such cases.
