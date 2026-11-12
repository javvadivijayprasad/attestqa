# Roadmap

attestqa ships on the **15th of every month**. A release ships with whatever is finished and tested;
unfinished work moves to the next month and the release notes say so. The full plan, with hours and
risks, is the frozen `Docs/baseline/05_Implementation_Plan.pdf`.

**Version numbers.** One line, everywhere: the product release (GitHub tag, release notes), the
engine on npm (`attestqa`) and the VS Code extension (`attestqa-vscode`) carry the same number. A new
major for each kind of testing, a new minor for each feature release, a patch for fixes. The 2.x line
is web testing (the engine became 2.0.0 when the ledger format changed); API testing opens 3.x, the
web version 4.x, security 5.x, ETL 6.x. Decided 3 Nov 2026 (ADR-005); the earlier scheme with a
separate product number is withdrawn.

---

## 2.x — web testing

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

### Shipped

- **2.0.0 / 2.0.1** (22 Oct 2026) — the engine, the CLI and the VS Code extension.
- **2.0.2 / 2.0.3** (3 Nov 2026) — the fixes found by the October evaluation of 2.0.1 (108 runs).
- **2.1.0** (5 Nov 2026) — organization-scoped Anthropic keys (`ANTHROPIC_WORKSPACE_ID`), a
  configurable per-call output cap (`agent.budgets.max_output_tokens`), the synthdata generator
  wired into the data-isolation story behind `SYNTHDATA_CMD`, and the rest of the October
  evaluation's fixes. See `packages/core/CHANGELOG.md`.
- **2.2.0** (10 Nov 2026) — company sign-in + Bedrock: keyless sign-in with Microsoft Entra ID or
  AWS SSO, and Amazon Bedrock as a provider. Each is a plug-in the config names, installed only by
  the projects that need it (`@attestqa/auth-azure`, `@attestqa/auth-aws`,
  `@attestqa/provider-bedrock`).

### Planned — one feature per minor, on the 15th of the month

A release ships whatever is finished and tested; unfinished work slips to the next month and the
date does not move. The near-term sequence below is committed; the technical plan for each is in
`research/decisions/` and the release memo. Dates past the next release are a plan, not a promise.

| Release | Target | Feature |
| --- | --- | --- |
| **v2.3.0** | 15 Jan 2027 | **Generated test data (synthdata)** — for a form-field story, the design agent requests boundary and invalid data and bakes it into a Scenario Outline + Examples table; an `aqa seed` subcommand generates application/DB seed data into the workspace (loading stays a project step). Opt-in, off by default. |
| **v2.4.0** | 15 Feb 2027 | **Tracker seam** — one tracker-neutral vocabulary behind the rules, so Jira runs are governed by the same rules as Azure DevOps (today most tracker-write rules name `ado.*` and Jira runs are under-governed). Behaviour-preserving for ADO. |
| **v2.5.0** | 15 Mar 2027 | **Approved locator repairs** — a repair the two rankers agree on, or that a person approves, with the before/after evidence. Off by default. |
| **v2.6.0** | 15 Apr 2027 | **Local web UI** — `aqa serve` runs the engine behind a browser on `127.0.0.1`; nothing leaves the machine. Parity with the VS Code extension. A signed Windows app wraps it later. |
| **v2.7.0** | 15 May 2027 | **Budget reservation** — guarantee the healer a minimum budget slice so a stuck earlier phase cannot starve it. Opt-in. |
| **v2.8.0** | 15 Jun 2027 | **The agent split** — execute, author, implement and defect each become their own agent with their own tools and instructions, as heal already is; the replay corpus is unchanged. Web testing complete. |

Migrating an existing Selenium suite is a separate standalone tool, **sel2pw**
(`npx @vijaypjavvadi/sel2pw convert`), not a subcommand of attestqa: convert with it, then run
attestqa on your next story — route B adds governed tests beside the converted ones.

Guided **exploration** and reviewing requirements **inside the app** remain on the list beyond the
committed sequence; they are not yet scheduled.

---

## Later stages

| Release | Date | Headline |
| --- | --- | --- |
| **v3.0.0** | 15 Jul 2027 | **API testing** |
| v3.1.0 | 15 Aug 2027 | API exploration; contracts from traffic |
| **v4.0.0** | 15 Sep 2027 | **Web version of attestqa** (hosting, accounts, multi-user approvals) |
| v4.1.0 | 15 Oct 2027 | MCP and multi-user approvals |
| **v5.0.0** | 15 Nov 2027 | **Security testing** |
| v5.1.0 | 15 Dec 2027 | Active scanning |
| **v6.0.0** | 15 Jan 2028 | **ETL testing** — all four kinds of testing |

Dates beyond the next release are a plan, not a promise. Changes to the plan are recorded as
decision records in `research/decisions/`.

## Ideas and requests

Open an issue with the label `idea`. What gets built is decided by what users of the current
release run into — the troubleshooting section of the user guide is mostly made of such cases.
