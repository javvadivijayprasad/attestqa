---
title: "attestqa — Implementation Plan and Release Schedule"
doc: "AQ-05"
version: "1.4 (for sign-off)"
date: "2026-10-10"
---

# 1. Capacity and cadence

Vijay works on attestqa four to five hours a day, seven days a week: about 31 hours a week, or roughly 135 hours in a month. Claude works alongside as a coworker; the hours below are Vijay's hours, including the time spent reviewing and testing what Claude produces.

Two rules shape the plan:

- **At least one release a month.** The first public release is **v1.0.0** on 15 November 2026, and every month after it brings a new release.
- **Every release ships something a user can try.** No month is spent on invisible groundwork alone. Where a large piece of work spans two months, the first month ships a usable part of it.

Each month's plan uses about 115 of the roughly 135 hours. The remaining 20 or so hours are deliberate slack, for things that take longer than expected, research runs and writing. If a month has spare time, the next month's work starts early; the release date does not move forward.

**Version numbers** follow three levels (decision D22):

| Change | Version step | Example | When |
|---|---|---|---|
| Major release: a new capability that defines a stage of the product | New major number | v1.0.0 → v2.0.0 | Each new test type, and the web version: v1.0.0 web, v2.0.0 API, v3.0.0 web version, v4.0.0 security, v5.0.0 ETL |
| Significant change within that stage: new screens, features, integrations | Middle number | v1.1.0, v1.2.0 … | The monthly releases between majors |
| Minor issue fix | Last number | v1.2.1, v1.2.2 | Whenever needed, between monthly releases; does not count as the month's release |

The version users see is the attestqa release version on GitHub, shared by the desktop app and the release notes. The npm packages inside it keep their own semantic versions: the engine published as `attestqa` on npm is already at 1.x and becomes 2.0.0 in release v1.0.0 because its ledger format changes (AQ-04 §2.2). Each release note lists the package versions it contains.

# 2. A month in practice

Release day is the **15th of each month**. A release cycle runs from the 16th of one month to the 15th of the next.

| Dates in the cycle | What happens |
|---|---|
| 16th–17th | Write-up of the last release (decision records, findings, journal summary, a short public post) and the plan for this one |
| 18th–7th | Build. A typical day: about 3 hours building, 1 hour testing and reviewing, 15–30 minutes on the research journal and findings |
| 8th–12th | Freeze. No new features; finish tests, fix what they find, update the user guide and changelog |
| 13th–15th | Release: checklist in AQ-09 §4; tag on the 15th; npm, GitHub and Zenodo publish from CI |

v1.0.0 has a longer first cycle because development starts on 12 October.

# 3. Release schedule

Hours are estimates of Vijay's time. "Ships" is what a user gets on release day.

## v1.0.0 — 15 Nov 2026 · major release: the engine and CLI (≈140 h over 5 weeks)

| Work | Hours |
|---|---|
| Monorepo set-up, `git subtree` import of agentic-qa, research log live (Phase 0 tasks in AQ-07 and AQ-08) | 15 |
| Publish `attestqa` 1.1.0 and the compatibility shim from the old repository | 3 |
| Engine 2.0: ledger additions, `tool: "attestqa"`, replay tests over the Paper I corpus | 25 |
| Provider conformance suite, `TokenSource`, `registerProvider`, OpenAI-compatible gateway | 20 |
| Tracker interface over the existing Azure DevOps MCP path; Jira adapter | 40 |
| Coverage tags and `aqa coverage`; report completeness (unconditional triage lines, `@bug:<id>`) | 25 |
| `synthdata` used as a package; shared triage fixtures with `pw-triage` | 10 |

**Ships:** `attestqa` 2.0.0 on npm. A tester can point the CLI at a Jira or Azure DevOps story, get governed Playwright tests and a counted report, with Anthropic, OpenAI, Azure OpenAI (key), a gateway or a local model.

## v1.1.0 — 15 Dec 2026 · company sign-in, healing, Selenium import (≈115 h)

| Work | Hours |
|---|---|
| AWS Bedrock provider; Entra ID and AWS SSO token sources | 37 |
| `pw-self-heal` in the heal role, suggest-only, with the test that generated projects never import its run-time fixture | 20 |
| `aqa import selenium` through `sel2pw`, then Attest | 12 |
| Desktop groundwork: client interface, `FakeClient`, Electron main/preload/IPC skeleton | 45 |

**Ships:** company sign-in with no stored keys; locator repairs suggested from the page and approved by a person; Selenium suites converted and attested from the CLI.

## v1.2.0 — 15 Jan 2027 · first Windows app: Attest (≈125 h)

| Work | Hours |
|---|---|
| Attest screen and approval dialog (`@attestqa/ui`) | 45 |
| Worker process, credential vault, schema-validated IPC | 25 |
| Headed Chromium beside the window; ledger question box (first four questions) | 20 |
| Renderer-secrets tests; code signing, installer, auto-update | 35 |

**Ships:** the first signed attestqa for Windows. It runs an existing suite, shows the counted report, and asks for approval when the agent wants to change a test.

## v1.3.0 — 15 Feb 2027 · Requirements and Specify in the app (≈120 h)

| Work | Hours |
|---|---|
| First-run flow with provider round-trip test and site login in the vault | 30 |
| Requirements screen: connect Azure DevOps or Jira, pick a sprint or query, coverage grid | 35 |
| Specify screen: scenarios, approve/edit/reject, generation through `bdd2pw` and `pw-emit`, `user_edit` events | 45 |
| "I have a Selenium suite" entry in the app | 10 |

**Ships:** from a sprint in Azure DevOps or Jira to approved Playwright tests, all inside the app.

## v1.4.0 — 15 Mar 2027 · Explore; web testing complete (≈115 h)

| Work | Hours |
|---|---|
| Web Explore: skill, three refusal rules, site map, open questions, promotion to drafts, rulings | 70 |
| Accessibility and end-to-end tests of the app itself (axe, Playwright for Electron) | 25 |
| User guide and a short demo video | 20 |

**Ships:** the full web-testing product: Explore, Specify and Attest. Exit test: AQ-01 §14, performed by someone other than Vijay using only the user guide.

## v2.0.0 — 15 Apr 2027 · major release: API testing (≈110 h)

| Work | Hours |
|---|---|
| `pw-emit` 1.4 with API, security and ETL output nodes (released from pw-emit's own repository) | 20 |
| `api` adapter, `api_hosts` scope, `statusWidened`, `schemaCheckDropped`, `expectedFieldRemoved` | 35 |
| API in Specify, Attest and the coverage grid; test-type switch live | 25 |
| API targets onboarded; study S2 (cross-model) runs | 30 |

**Ships:** API tests from stories and an OpenAPI file, with weakening refused the same way as web.

## v2.1.0 — 15 May 2027 · API Explore and contracts from traffic (≈100 h)

| Work | Hours |
|---|---|
| API Explore from an OpenAPI file or traffic recorded during web Explore | 25 |
| `usagecontract` as a second API oracle, approved before use | 20 |
| Study S3 (cross-site) runs; hardening from user reports | 55 |

**Ships:** API Explore and contracts derived from real traffic. Exit test: AQ-01 §14 for API.

## v3.0.0 — 15 Jun 2027 · major release: web version of attestqa (≈105 h)

| Work | Hours |
|---|---|
| `@attestqa/server`: REST and live updates, `HttpClient` for the same UI | 55 |
| Company sign-in (OIDC) and roles | 20 |
| Run queue and container workers | 30 |

**Ships:** a self-hosted attestqa server: the same screens in a browser, for one team.

## v3.1.0 — 15 Jul 2027 · MCP and multi-user approvals (≈100 h)

| Work | Hours |
|---|---|
| MCP endpoint (`run_story`, `run_status`, run resources; no approve tool) | 30 |
| Container image and deployment guide | 25 |
| Multi-user approvals, security review of the server | 45 |

**Ships:** IDE agents can start runs; a different person approves in the browser. Exit test: AQ-01 §14 for the web version.

## v4.0.0 — 15 Aug 2027 · major release: security testing (≈105 h)

| Work | Hours |
|---|---|
| Passive checks in Playwright: headers, cookie flags, TLS, CSP, access control with two users | 30 |
| `@attestqa/adapter-zap`: passive scan and spider | 35 |
| ASVS requirement mapping; `findingSuppressed`, `allowListGrown`, `severityLowered`; UI | 40 |

**Ships:** passive security testing on any authorised target, results in the same report.

## v4.1.0 — 15 Sep 2027 · active scanning; ETL groundwork (≈110 h)

| Work | Hours |
|---|---|
| Active scan behind recorded authorisation; ZAP findings as test results; study S4 (security) | 45 |
| `@attestqa/adapter-sql`: read-only statement parser and connections; SQLite, PostgreSQL, SQL Server (built now, released in v5.0.0) | 50 |
| Hardening | 15 |

**Ships:** active scanning for authorised targets, with ZAP findings in the same report. Exit test: AQ-01 §14 for security.

## v5.0.0 — 15 Oct 2027 · major release: ETL testing (≈110 h)

| Work | Hours |
|---|---|
| Mapping-document format; ETL Explore by profiling; `toleranceWidened`, `rowFilterAdded`, `expectedSetToActual` | 50 |
| Reference load built with `synthdata` from the schemas in `E:\Sy`, with seeded faults written down first | 20 |
| ETL in the app; study S4 (ETL) runs | 25 |
| First-year review: documentation, retrospective, roadmap for year two | 15 |

**Ships:** all four test types in the desktop app and the server. Exit test: AQ-01 §14 for ETL.

# 4. Summary

| Release | Date | Headline |
|---|---|---|
| **v1.0.0** | 15 Nov 2026 | **Major:** engine and CLI: Jira/ADO stories to governed tests, any company model |
| v1.1.0 | 15 Dec 2026 | Company sign-in, healing suggestions, Selenium import |
| v1.2.0 | 15 Jan 2027 | First signed Windows app: Attest |
| v1.3.0 | 15 Feb 2027 | Requirements and Specify in the app |
| v1.4.0 | 15 Mar 2027 | Explore; web testing complete |
| **v2.0.0** | 15 Apr 2027 | **Major:** API testing |
| v2.1.0 | 15 May 2027 | API Explore; contracts from traffic |
| **v3.0.0** | 15 Jun 2027 | **Major:** web version of attestqa |
| v3.1.0 | 15 Jul 2027 | MCP and multi-user approvals |
| **v4.0.0** | 15 Aug 2027 | **Major:** security testing |
| v4.1.0 | 15 Sep 2027 | Active scanning |
| **v5.0.0** | 15 Oct 2027 | **Major:** ETL testing; all four types |

Total planned work is about 1,350 hours over twelve months, against about 1,660 hours of capacity (4.5 hours a day), leaving roughly 300 hours of slack across the year. The cycles from mid-December to mid-March are the tightest (86–91% planned), and the first of them includes the holidays; if time is lost there, v1.2.0 ships without signing as a developer preview and signing moves to v1.3.0. A day-by-day planner workbook tracks actual hours against this plan (`Docs/attestqa_Planner.xlsx`).

# 5. Working rules

- Every gate rule gets a test named after the run that produced it, as today.
- No change to engine behaviour without a ledger-replay test showing old runs still produce the same reports, unless a decision record explains it.
- Git is run on Windows by Vijay. Secrets live only in git-ignored `.env` files or the vault, never in chat or the repository.
- External-system writes (tracker state changes, publishing) are done by Vijay; Claude prepares them.
- Each release ends with a decision record, a findings update and a tagged commit.

# 6. When a month goes wrong

A release ships on the 15th with whatever is finished and tested. Unfinished work moves to the next month and the release notes say so; the date does not slip. If a whole month's headline cannot ship, the release becomes a hardening release (fixes, documentation, research runs) and the plan after it moves by one month, recorded in a decision record. A month that loses more than a week to other commitments does the same.
