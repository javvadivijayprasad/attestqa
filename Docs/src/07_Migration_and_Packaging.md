---
title: "attestqa — Code Migration and Open-Source Packaging"
doc: "AQ-07"
version: "1.4 (for sign-off)"
date: "2026-10-10"
---

# 1. Starting point

| Asset | Location today | State |
|---|---|---|
| agentic-qa runtime (renamed attestqa, 1.1.0 prepared) | `06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa` | Frozen for Paper I at `f2771d4`, tag `corpus-2026-10-07`; rename and provider seam uncommitted on top |
| Compatibility shim | `...\Experiment\agentic-qa-shim` | Prepared, not published |
| Juice Shop test project | `...\Experiment\juiceshop-e2e` | Working; `global-setup.ts` handles fresh containers |
| Weakening study | `06_Authorship\Paper_I2_WeakeningStudy\Experiment\weakening-study` | Corpus analysis |
| VS Code extension 0.1.0 | `agentic-qa\extension` | Exists; role in the new product to be decided (D9) |
| bdd2pw 4.4.0 | `Application\bdd2pw` | Published separately; used as a dependency |
| pw-emit 1.3.0 | `Application\pw-emit` | Published; to be used directly for all test types |
| sel2pw 2.0.9 | `Application\Converter` | Published; to be used for Selenium import |
| pw-self-heal 1.2.1 | `Application\PlaywrightExtentions\pw-self-heal` | Published; to be used by the heal role, suggest-only |
| usagecontract 1.6.1 | `Application\ContractingTesting\usagecontract` | Published; to be used for API contracts (v2.1) |
| synthdata | npm `@vijaypjavvadi/synthdata` (synthkit engine in `E:\Sy`) | Published; to replace the `SYNTHDATA_CMD` shell-out |
| pw-triage, pw-select, pw-perf | `Application\pw-extensions` | Published; pw-triage kept in step with core triage; the others not used yet |

# 2. Principle

The Paper I repository is evidence. It is not moved, rewritten or cleaned up. Everything new happens in the new monorepo, which carries the old history so every commit hash in the paper still resolves there too.

# 3. What happens to each part of the existing agentic-qa code

The runtime is about 17,900 lines of TypeScript in 55 files under `src/`, with 39 test files. Almost all of it carries over unchanged, because it is the part that makes results trustworthy and is what Paper I describes. The table says, folder by folder, whether the code is kept as it is, changed, or wrapped by something new, and in which release.

| Existing code | What it does | In attestqa | Release |
|---|---|---|---|
| `src/runtime/loop.ts`, `model.ts`, `context.ts`, `tools.ts`, `clock.ts` | The governed loop: one model turn, gate, approval, tool call, observation | **Kept as is.** Hosted by the CLI, the desktop worker and the server worker alike | v1.0 |
| `src/runtime/anthropic.ts`, `openai.ts`, `provider.ts` | Model clients and the provider seam built in October | **Kept, extended:** `TokenSource`, `registerProvider`, gateway; Bedrock as a plug-in | v1.0–v1.1 |
| `src/runtime/approval.ts`, `approvers.ts`, `render-approval.ts`, `denials.ts` | Approval requests, the terminal approver, denial counting | **Kept;** a new approver answers from the desktop UI or the server, alongside the terminal one | v1.2 |
| `src/runtime/rerun.ts` | Which runs count as full runs; when a rerun is stale | **Kept as is** | v1.0 |
| `src/governance/policy.ts`, `scrub.ts` | ScopedGate policy classes; secret scrubbing | **Kept as is;** new tools get their policy classes here | v1.0 |
| `src/skills/story-rules.ts` | The refusal chain (`writeOnExecutePath`, `weakensAQuarantinedTest`, `editorialOnly`, `duplicateBug`, …) | **Kept as is.** New rules for explore, API, security and ETL are added after it, never by editing it | v1.0 onward |
| `src/skills/story-to-tests.ts`, `story-context.ts` | Story-to-tests skill; reading the story, comments and linked bugs | **Kept;** `story-context` reads through the new tracker interface instead of calling Azure DevOps tools directly | v1.0 |
| `src/skills/defect-profile.ts`, `src/defects/taxonomy.ts` | Defect history and taxonomy | **Kept** | v1.0 |
| `src/route/route.ts`, `src/agents/roles.ts` | Route decided in code (P0/A/A′/B); roles such as heal | **Kept as is** | v1.0 |
| `src/heal/locator.ts`, `src/mcp/adapters/heal.ts` | Locator repair derived from the page | **Kept;** `pw-self-heal` adds ranked candidates as suggestions | v1.1 |
| `src/triage/*` | Failure classification, settling, the triage step and report | **Kept;** shares a fixture set with `pw-triage` so both give the same verdict | v1.0 |
| `src/verify/*` | Verifiers for each skill, evidence checks | **Kept as is** | v1.0 |
| `src/ledger/ledger.ts`, `replay.ts` | Append-only ledger and replay | **Changed once:** the 2.0 envelope (`tool: "attestqa"`, three new event kinds), still reading every 1.x ledger | v1.0 |
| `src/design/test-design.ts`, `src/framework/survey.ts` | Story facts and test design; detecting the framework already in a repository | **Kept;** the survey also detects Selenium projects for `sel2pw` | v1.0–v1.1 |
| `src/mcp/adapters/fs.ts`, `pw.ts`, `process.ts`, `summary.ts` | File, Playwright and process adapters; the counted report | **Kept;** the report gains a per-test-type split | v1.0, v2.0 |
| `src/mcp/adapters/bdd2pw.ts` | Calls bdd2pw to scaffold tests | **Kept;** later routed through `pw-emit` for non-web types | v1.0, v2.0 |
| `src/mcp/adapters/synthdata.ts` | Runs a data-generation command | **Changed:** calls the `synthdata` package; the command form stays as a fallback | v1.0 |
| `src/mcp/adapters/tcg.ts`, `defect-profile.ts`, `test-design.ts` | Optional links to the TestForge services | **Kept as optional adapters,** off unless configured | v1.0 |
| `src/mcp/client.ts`, `discover.ts`, `manifest.ts`, `servers.ts` | MCP client, server discovery, pinned servers (including Microsoft's Azure DevOps MCP server) | **Kept;** the Azure DevOps path is wrapped by the tracker interface, Jira added beside it | v1.0 |
| `src/config.ts`, `src/types.ts` | Config schema and shared types | **Extended:** `mode`, `kind`, tracker, contracts, security and ETL blocks | v1.0 onward |
| `src/cli.ts`, `src/index.ts` | The `aqa` CLI and library entry point | **Kept,** with new commands (`coverage`, `import selenium`) | v1.0–v1.1 |
| `test/` (39 files) | Unit and rule tests, many named after the run that produced them | **Kept and run on every commit;** the corpus replay test is added on top | v1.0 |
| `examples/fixture-ledger/` | A recorded run used in tests | **Kept** as the first replay fixture | v1.0 |
| `extension/` (VS Code 0.1.0) | Early VS Code extension | **Parked** until the web version (decision D9) | — |

What is new, rather than carried over: the desktop app (`Winapp`), the review screens (`packages/ui`, `packages/client`), the server (`WebApplication`), the tracker interface with Jira, the explore skill, and the API, security and ETL adapters and rules. None of them change the loop, the gate or the refusal chain; they plug into them.

# 4. Steps

**Step 1 — Finish and publish 1.1.0 from the old repository.** Vijay commits the rename and provider seam on Windows after `npm test` and `npm run build` pass, tags `v1.1.0`, publishes `attestqa`, then publishes the shim as `@vijaypjavvadi/agentic-qa@1.1.0` (it depends on `attestqa ^1.1.0` and re-exports it), then runs `npm deprecate @vijaypjavvadi/agentic-qa@"<1.1.0" "renamed to attestqa"`. Existing installs keep working and download counts on the old name stay where they are.

**Step 2 — Create the monorepo.** At `E:\EB1A_Research\Application\attestqa`:

```
git init
git subtree add --prefix=packages/core ^
  E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa v1.1.0
```

`subtree` (rather than copying files) keeps the full history, so `git log packages/core` shows every commit back to the first, and `f2771d4` can still be checked out.

**Step 3 — Move the Juice Shop project.** Copy `juiceshop-e2e` to `TestRunApplication/juice-shop` (copy, not move; the original stays with Paper I). Its `.env` is recreated by hand and never copied through any tool.

**Step 4 — Split what does not belong in core.** Bedrock, Entra and AWS SSO go into their own packages so core stays dependency-light. The OpenAI-compatible adapter stays in core because it needs nothing beyond `fetch`.

**Step 5 — Core 2.0.** Ledger additions and the `tool` literal change (AQ-04 §2.2). Replay tests prove 1.x ledgers still produce identical reports.

**Step 6 — Point the GitHub repository.** Rename the existing GitHub repository in place to `attestqa` (GitHub redirects the old URL; the Zenodo DOI concept record keeps resolving) and push the monorepo to it, or create a fresh `attestqa` repository and archive the old one with a pointer. Decision D3.

**Step 7 — Retire the old repository from active work.** After the monorepo publishes core 2.0, the old repository's README gets a banner: "Frozen as the Paper I artefact. Development continues at …". No further commits there except corrections the paper needs.

# 5. Packages and release channels

| Package | Folder | First version | Channel | Depends on |
|---|---|---|---|---|
| `attestqa` | `packages/core` | 1.1.0 (old repo), then 2.0.0 (monorepo) | npm | — |
| `@vijaypjavvadi/agentic-qa` | old shim folder | 1.1.0, final | npm, deprecated | `attestqa` |
| `@attestqa/client` | `packages/client` | 0.1.0 | npm | `attestqa` types |
| `@attestqa/ui` | `packages/ui` | 0.1.0 | npm | `@attestqa/client`, React |
| `@attestqa/provider-bedrock` | `packages/provider-bedrock` | 0.1.0 | npm | `attestqa`, AWS SDK Bedrock runtime |
| `@attestqa/auth-azure` | `packages/auth-azure` | 0.1.0 | npm | `@azure/identity` |
| `@attestqa/auth-aws` | `packages/auth-aws` | 0.1.0 | npm | AWS SDK credential providers |
| `@attestqa/tracker-jira` | `packages/tracker-jira` | 0.1.0 | npm | `attestqa` |
| `@attestqa/adapter-zap` | `packages/adapter-zap` | with v4.0 (security testing) | npm | `attestqa`; OWASP ZAP installed separately |
| `@attestqa/adapter-sql` | `packages/adapter-sql` | with v5.0 (ETL testing) | npm | `attestqa`; database drivers as optional peers |
| `@attestqa/server` | `WebApplication` | with v3.0.0 | npm + container image | core, client |
| attestqa for Windows | `Winapp` | 0.1.0 | GitHub Releases (signed NSIS) | all of the above |

Versioning: semantic versioning per package, with Changesets managing release notes across the workspace. Each npm publish uses npm provenance from GitHub Actions so anyone can check a package was built from the public source.

# 6. Our existing packages stay where they are

The six packages attestqa builds on are not moved into the monorepo. Each keeps its repository, version history, DOI and users, and attestqa depends on its published version. When attestqa needs something new from one of them (for example the new IR nodes in `pw-emit` 1.4), the change is made and released in that package's own repository first, then attestqa raises its version range. This keeps each package's papers and download history intact and means a fix in, say, `pw-self-heal` reaches its existing users as well as attestqa's.

# 7. Open-source housekeeping

MIT licence in every package. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (how to report a vulnerability privately). `CITATION.cff` at the root citing Paper I and the software DOI. Issue templates for bug, provider request, and new target site. A `GOVERNANCE.md` that says plainly what the refusal rules are and that pull requests weakening them will not be merged without a ledger-backed argument.

# 8. What could go wrong

| Risk | Mitigation |
|---|---|
| `@attestqa` scope taken | Check and create the npm organisation in the first month, before v1.0.0 (D4); fallback `@attestqa-dev` or unscoped names |
| Subtree import loses tags | Push tags explicitly; verify `git show f2771d4` in the monorepo before continuing |
| Shim and core versions drift | Shim pins `attestqa ^1.1.0`; it is final and never republished |
| A change in one of our packages breaks attestqa | attestqa pins major versions and runs its replay tests against each new minor release before raising the range |
| Paper reviewers cite the old URL | GitHub redirect plus the archived banner; the DOI is the citation anyway |
