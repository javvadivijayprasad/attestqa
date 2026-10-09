---
title: "attestqa — Sign-off Sheet"
doc: "AQ-00"
version: "1.6"
date: "2026-10-10"
---

# 1. What is being signed

This sheet covers the design document set for attestqa, prepared before any development begins. Signing it means: the product, its design, and the plan in these documents are agreed as the starting point; development may begin with the v1.0.0 month of AQ-05; and any later change to a decision below is recorded as a decision record in `research/decisions/` rather than made silently.

Each document is identified by the SHA-256 hash of its PDF, so the version signed can always be proven later.

# 2. Changes since version 1.0

**1.6.** The frozen corpus was entered as the first 18 findings and the first lines of the Paper I manuscript were drafted from them. In doing so, an error in these documents was found and corrected: they said the corpus showed six weakening routes and that none reached the suite. The corpus shows five routes, and three weakenings did reach disk before being caught by reading the ledger (AQ-01 §2, AQ-08 H2 and H5).

**1.5.** Paper I is written as the work happens: a living manuscript in the Paper I folder, every result line tied to a finding and its ledger events, lines added the day the finding is logged and joined into paragraphs each month, with a checker for unsupported or unused findings (AQ-08 §6). Decision D27 is new.

**1.4.** Version numbers now follow three levels: a new major number for each product stage (v1.0.0 web testing, v2.0.0 API, v3.0.0 web version, v4.0.0 security, v5.0.0 ETL), the middle number for the monthly releases within a stage, and the last number for minor fixes. The schedule is unchanged; the twelve monthly releases are renumbered v1.0.0 to v5.0.0, and the ETL database adapter now ships with v5.0.0. Decision D22 is reworded; D14 follows it.

**1.3.** The plan is now a monthly release schedule sized to 4–5 hours a day, seven days a week (about 31 hours a week): v1.0.0 on 15 November 2026, then one release on the 15th of every month to v5.0.0 in October 2027, each shipping something usable (AQ-05). Release numbers across all documents follow it. AQ-07 gains a folder-by-folder account of what happens to the existing agentic-qa code. A new document, AQ-09, covers open-source publishing: public repository from the first day, npm with provenance, signed installers, and a Zenodo DOI for every release. Decisions D22 to D26 are new; D14 and D9 use the new release numbers.

**1.2.** attestqa now builds on six packages already published under `@vijaypjavvadi`: bdd2pw and pw-emit for code generation, synthdata for test data, pw-self-heal for locator suggestions (suggest-only, never silent run-time healing), sel2pw for importing Selenium suites, and usagecontract as a second API oracle. They stay in their own repositories and are used as dependencies. pw-triage is kept in step with core triage. The first-run screen gains an "import a Selenium suite" entry. Decision D21 is new; D16 now names pw-emit.

**1.1.** Version 1.1 adds the four test types and requirements from trackers, following the discussion on 9 October 2026. Test type became a second setting beside the mode (web, API, security, ETL), each with its own adapter, oracle source and refusal rules. Jira and Azure DevOps are now explicit requirement sources, behind one read-only tracker interface, and there is a new Requirements screen with a coverage grid. The release order is now web testing, API testing, the web version of attestqa, security testing and ETL testing (agreed: API before the web version). The Attest prototype now shows web and API results together. Hypothesis H5 (cross-type weakening) and study S4 were added. Decisions D14 to D20 are new or changed.

# 3. Documents

| ID | Document | Ver. | File | Pages | SHA-256 | Review |
|---|---|---|---|---|---|---|
| AQ-01 | Product Document | 1.5 | `01_Product.pdf` | 8 | `227fc8f041827b6d0ee4a21f8809a616`<br>`17358692cfcd4c2ac58697846a8682da` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-02 | Design Document and UI Prototype | 1.4 | `02_Design_UI_Prototype.pdf` | 8 | `d4a5a8a4932ae93c38b96904e206a367`<br>`56cab426a76ed4e5009b4e4ad23d9c3f` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-03 | High-Level Design | 1.4 | `03_HLD.pdf` | 10 | `83c24c246b5e3ff79eca3894d6ce1036`<br>`75519290571cb32c2421bc0866edc681` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-04 | Low-Level Design | 1.4 | `04_LLD.pdf` | 10 | `798fe1a96a9739c20359903174f7f15b`<br>`4e362dec0878acae03a27fe16ba6fca8` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-05 | Implementation Plan and Release Schedule | 1.4 | `05_Implementation_Plan.pdf` | 6 | `ccb45f40dce7e50463de8bf1e992a8d7`<br>`af910ca17cf38e5fc12b9b972f0b9c3b` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-06 | Local Test Strategy and Target Applications | 1.4 | `06_Local_Test_Strategy.pdf` | 5 | `061f4a7f17bdbe67472ed6c2579bd7fa`<br>`4ba8182eda30f45ed6f1617f5da6e9db` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-07 | Code Migration and Open-Source Packaging | 1.4 | `07_Migration_and_Packaging.pdf` | 7 | `d4373d7795ca182d16f0ca6f33096b6b`<br>`0240932b57baaa1445f957d819593365` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-08 | Research Logging Plan | 1.6 | `08_Research_Logging_Plan.pdf` | 4 | `5a59556cd9ae2a4caa1ebdf4df3fa170`<br>`c61292361fa4a32358213bd9e7eb80a3` | <span class="box"></span>Approved <span class="box"></span>Changes |
| AQ-09 | Open-Source Release and Publishing | 1.1 | `09_Open_Source_Publishing.pdf` | 3 | `f7fe9552b4a1ea6c7e6e7efeddaccf5e`<br>`198b014f40e485eaa142e534158781e9` | <span class="box"></span>Approved <span class="box"></span>Changes |

# 4. Decisions needing explicit agreement

| # | Decision | Where | Answer |
|---|---|---|---|
| D1 | Working directory `E:\EB1A_Research\Application\attestqa` with `Docs`, `Winapp`, `WebApplication`, `TestRunApplication` as named. | AQ-03 §3 | <span class="box"></span>Agree <span class="box"></span>Change |
| D2 | Add two folders: `packages/` (shared code published to npm) and `research/` (findings, decisions, hypotheses, manifests). | AQ-03 §3 | <span class="box"></span>Agree <span class="box"></span>Change |
| D3 | Rename the existing GitHub repository in place to `attestqa` (keeps redirects and the Zenodo DOI), rather than creating a new one. | AQ-07 §4 | <span class="box"></span>Agree <span class="box"></span>Change |
| D4 | Create the `@attestqa` npm organisation for the scoped packages. | AQ-07 §5 | <span class="box"></span>Agree <span class="box"></span>Change |
| D5 | Store desktop secrets with Electron `safeStorage` (Windows DPAPI) rather than Windows Credential Manager by name. | AQ-04 §4.4 | <span class="box"></span>Agree <span class="box"></span>Change |
| D6 | Sign the installer with Azure Trusted Signing (fallback: OV certificate). Signing is release-blocking. | AQ-03 §7 | <span class="box"></span>Agree <span class="box"></span>Change |
| D7 | Core goes to 2.0.0 at the start of desktop work: ledger `tool` becomes `attestqa`, three event kinds added, 1.x ledgers stay readable. | AQ-04 §2.2 | <span class="box"></span>Agree <span class="box"></span>Change |
| D8 | Second provider for the cross-model study: Azure OpenAI (alternative: OpenAI). | AQ-06 §3 | <span class="box"></span>Agree <span class="box"></span>Change |
| D9 | Park the VS Code extension 0.1.0 until the web version (v3.0–v3.1); no extension work before then. | AQ-07 §1 | <span class="box"></span>Agree <span class="box"></span>Change |
| D10 | Use the target list and rules of engagement in AQ-06; active security scanning only on local Juice Shop. | AQ-06 §4–5 | <span class="box"></span>Agree <span class="box"></span>Change |
| D11 | Freeze hypotheses H1–H5 as written and hash them before any study data is collected. | AQ-08 §3.3 | <span class="box"></span>Agree <span class="box"></span>Change |
| D12 | Explore mode has no oracle and writes drafts only, for every test type; it can never file a bug or report a pass. | AQ-01 §4–5, AQ-04 §2.4, §2.6 | <span class="box"></span>Agree <span class="box"></span>Change |
| D13 | The UI offers no chat with the model; the only text box is answered from the ledger. | AQ-01 §10, AQ-02 §2 | <span class="box"></span>Agree <span class="box"></span>Change |
| D14 | Release order: web testing (v1), API testing (v2), the web version of attestqa with MCP (v3), security testing (v4), ETL testing (v5). | AQ-05 §2–3 | <span class="box"></span>Agree <span class="box"></span>Change |
| D15 | Test type is a second setting beside the mode; all types share the gate, ledger, triage and report, and each adds only an adapter, an oracle source and its own refusal rules. | AQ-01 §5, AQ-03 §5 | <span class="box"></span>Agree <span class="box"></span>Change |
| D16 | All test types are written as `@playwright/test` files, generated through `pw-emit` and run by the same runner; ZAP findings are converted into test results. | AQ-03 §5, §10 | <span class="box"></span>Agree <span class="box"></span>Change |
| D17 | Requirements come from Azure DevOps and Jira through one tracker interface, read-only except bug creation after confirmation; Jira adapter built for v1.0.0. | AQ-01 §6, AQ-04 §2.7 | <span class="box"></span>Agree <span class="box"></span>Change |
| D18 | Coverage is computed from test tags, approvals and results, never by the model; shown on a new Requirements screen. | AQ-02 §4.2, AQ-04 §2.8 | <span class="box"></span>Agree <span class="box"></span>Change |
| D19 | Active security scanning is a destructive action offered only when written authorisation is recorded for the target. | AQ-04 §2.6 | <span class="box"></span>Agree <span class="box"></span>Change |
| D20 | ETL database access is read-only, enforced by a statement parser and read-only connections; ETL targets built from the local synthetic databases. | AQ-04 §2.6, AQ-06 §4.5 | <span class="box"></span>Agree <span class="box"></span>Change |
| D21 | Build on our published packages as dependencies (bdd2pw, pw-emit, synthdata, pw-self-heal, sel2pw, usagecontract), not copies; each stays in its own repository; pw-self-heal is suggest-only in governed runs. | AQ-01 §13, AQ-03 §13, AQ-07 §6 | <span class="box"></span>Agree <span class="box"></span>Change |
| D22 | Versioning: a new major number for each stage (v1.0.0 web, v2.0.0 API, v3.0.0 web version, v4.0.0 security, v5.0.0 ETL); the middle number for significant changes within a stage (the monthly releases); the last number for minor fixes. npm packages keep their own versions, listed in every release note. | AQ-05 §1 | <span class="box"></span>Agree <span class="box"></span>Change |
| D23 | At least one release a month, on the 15th, starting v1.0.0 on 15 Nov 2026; planned at about 115 of ~135 monthly hours (4–5 h/day, 7 days); a late feature moves to next month, the date does not. | AQ-05 §1–3, §6 | <span class="box"></span>Agree <span class="box"></span>Change |
| D24 | The repository is public from the first commit; secrets, private-system ledgers and non-consenting targets are never published. | AQ-09 §1 | <span class="box"></span>Agree <span class="box"></span>Change |
| D25 | Releases are built, signed and published by GitHub Actions on a tag Vijay pushes: npm trusted publishing with provenance, signed installer with checksums and SBOM. | AQ-09 §2–4 | <span class="box"></span>Agree <span class="box"></span>Change |
| D26 | Every release is archived on Zenodo with its own DOI; study datasets get separate DOIs, with hypotheses committed publicly before data collection. | AQ-09 §2, §6 | <span class="box"></span>Agree <span class="box"></span>Change |
| D27 | Paper I is written line by line from findings during development, not at the end; every result line cites a finding id; Paper I2 keeps its own experiment and draws results only from it. | AQ-08 §6 | <span class="box"></span>Agree <span class="box"></span>Change |

# 5. Already agreed in discussion (recorded, no action needed)

The tracker is optional. The ledger stays on disk and is never sent to any attestqa service. The product is open source under MIT, desktop first on Windows. Users bring their own model (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock, an OpenAI-compatible gateway, or local) with their company's sign-in. Generated tests are plain Playwright code in a folder the user owns. The UI is React and TypeScript, shared by desktop and web. Generated test projects live in `TestRunApplication`. Editable Markdown sources are kept beside the PDFs in `Docs/src`. API testing comes before the web version of attestqa.

# 6. Comments and requested changes

<div style="border:1px solid #d5dae3;border-radius:4px;height:150px"></div>

# 7. Signature

<table class="sig">
<tr><th style="width:28%">Role</th><th>Name</th><th style="width:22%">Signature</th><th style="width:18%">Date</th></tr>
<tr><td>Product owner and author</td><td>Vijay Javvadi</td><td></td><td></td></tr>
<tr><td>Outcome</td><td colspan="3"><span class="box"></span>Approved as is &nbsp;&nbsp; <span class="box"></span>Approved with the changes in §6 &nbsp;&nbsp; <span class="box"></span>Not approved — revise and resubmit</td></tr>
</table>
