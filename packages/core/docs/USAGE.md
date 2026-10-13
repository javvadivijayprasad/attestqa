# Using attestqa

This guide takes you from nothing installed to a story whose tests are written, run and checked, and
then shows you how to read what happened. It covers the command line (`aqa`) and the VS Code
extension, and both Jira and Azure DevOps.

What attestqa does, in one paragraph: you point it at a user story. It reads the story, its epic,
its sub-tasks, comments and open bugs, and proposes a **test design** — one line per test, saying
what kind of test it is and what it must observe. **You approve the design.** It then writes
ordinary Playwright tests into a folder you own, runs them, triages any failures and repairs broken
locators. Throughout, a governance layer refuses — in code — any change that would make a failing
test pass by weakening it, and every step is written to a ledger you can replay. The tests it leaves
behind run with plain `npx playwright test`, with attestqa uninstalled.

For how it works inside, see [HOW-A-RUN-WORKS.md](HOW-A-RUN-WORKS.md) and
[ARCHITECTURE.md](ARCHITECTURE.md). For the contracts (event shapes, exit codes, config schema), see
[TECHNICAL.md](TECHNICAL.md).

---

## 1. Before you start

| You need                                      | Why                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Node.js 20 or later                           | the runtime                                                                                                                 |
| A Playwright project for the site under test  | where the tests are written; `npx playwright test` must work in it                                                          |
| A model credential                            | Anthropic by default; OpenAI, Azure OpenAI, a local model or your company gateway also work                                 |
| Jira **or** Azure DevOps access               | to read stories; Jira: email + API token (Cloud) or a PAT (Data Center). Azure DevOps: a PAT with Work Items (read & write) |
| The application, running                      | attestqa opens the real pages to find what is on them                                                                       |
| A disposable test account in that application | never a real user, never an admin                                                                                           |
| VS Code 1.85 or later (optional)              | for the extension                                                                                                           |

If you have no Playwright project yet, create one first (`npm init playwright@latest`). attestqa
writes tests into an existing framework; it does not create one for you.

## 2. Install

```bash
npm install -g attestqa
aqa --version
```

For VS Code, install **attestqa** from the Marketplace (publisher `vijaypjavvadi`), or run
`code --install-extension vijaypjavvadi.attestqa-vscode`. The extension drives the `aqa` you just
installed; it does not bundle its own copy. See [section 8](#8-in-vs-code).

---

## 3. Set up a project

Do this once per application under test. Five steps.

### 3.1 The Playwright project

attestqa writes into this folder and nowhere else (it is the `--workspace`). Its
`playwright.config.ts` should read the address and the test login from the environment, so that no
URL or password ever ends up in a test file:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  retries: 0, // a flaky pass is worse than a failure: green is treated as evidence
  use: { baseURL: process.env.AQA_APP_URL },
});
```

Keep `retries: 0`. Add `test-results/`, `playwright-report/`, `.aqa-report/` and `.bdd2pw/` to the
project's `.gitignore`.

If your application shows a cookie banner or a welcome pop-up on first visit, dismiss it with a
`storageState` file in the config rather than in each test (see `TestRunApplication/juice-shop` in
the repository for a worked example).

### 3.2 `.env` — credentials

Create `.env` next to where you run `aqa` (`.env.example` lists every name). It is git-ignored;
never commit it and never paste its values anywhere.

```ini
# The model (one of these, matching agent.model in the config)
ANTHROPIC_API_KEY=...

# Jira Cloud
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...
# Jira Data Center instead: JIRA_PAT=...

# Azure DevOps (if you use it instead of, or as well as, Jira)
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org
AZURE_DEVOPS_PROJECT=your-project
AZURE_DEVOPS_PAT=...

# The application under test — read by playwright.config.ts, never by a test
AQA_APP_URL=http://localhost:3100
AQA_APP_USER=test-user@example.com
AQA_APP_PASS=...
```

A variable already set in your shell wins over `.env`. If authentication fails and `.env` looks
right, look for a stale `ANTHROPIC_API_KEY` in your environment — the startup line says which source
each key came from.

### 3.3 `ai-quality.config.yaml` — what the agent may do, and where

Copy `examples/ai-quality.jira.config.yaml` (Jira) or `examples/ai-quality.config.yaml` (Azure
DevOps) from the package and edit four things:

```yaml
agent:
  model: claude-sonnet-4-6
  test_types: ["functional", "security", "accessibility", "confirmation"]
  scope:
    work_items: ["SHOP-*"] # Jira keys or a glob; Azure DevOps: ids or ranges ("100-199")
    urls: ["http://localhost:3100"] # where it may point a browser; empty = no browsing
    test_plans: [] # Azure DevOps test plans it may write into
    branches_writable: ["agent/*"]
  policy:
    read: execute
    write_workspace: execute # writing tests in the workspace
    write_branch: ask
    write_record: ask # anything written to Jira / Azure DevOps asks you first
    destructive: refuse
```

- **`scope`** says _where_ it may act. A story outside `work_items` is refused before anything is
  spent.
- **`policy`** says _what_ it may do. Leave `write_record: ask` unless you have decided otherwise —
  it is what makes filing a bug wait for you.
- **`test_types`** are the kinds of test every design must cover, or exclude with a reason.
  `accessibility` needs `@axe-core/playwright` in the Playwright project. `confirmation` means
  re-testing a known bug.

No secrets go in this file: it is meant to be committed. A header that looks like a credential
(`Authorization`, `api-key`, `token`…) is refused when the config loads.

### 3.4 Check it — a dry run

```bash
aqa run "Write tests for SHOP-12" --config ai-quality.config.yaml \
  --workspace ./my-playwright-project --dry-run
```

This connects to every tool server, lists each tool with its governance class and what the policy
would decide, and exits. No model call, nothing spent. Do it after every config change.

### 3.5 Jira or Azure DevOps — which one is used

attestqa picks from the story reference: a key like `SHOP-12` means Jira, a number (`AB#123`, `#123`)
means Azure DevOps. `--tracker jira|ado` overrides it. Both work through the same rules; the
differences are listed below.

|                                      | Jira                                                                                   | Azure DevOps                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Credentials                          | `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN`, or `JIRA_PAT`                       | `AZURE_DEVOPS_ORG_URL` + `AZURE_DEVOPS_PROJECT` + `AZURE_DEVOPS_PAT`        |
| Acceptance criteria                  | from the description, or a custom field (`JIRA_AC_FIELD`)                              | the Acceptance Criteria field                                               |
| What attestqa may write              | a new **Bug**, and the story's one **QA sub-task** (see below), each after you approve | Bugs and test cases, after you approve; test plans if your licence has them |
| Where tests are recorded             | a QA sub-task under the story, plus the feature file                                   | linked test cases, plus the feature file                                    |
| Bug states treated as "known broken" | Active, In Progress, Reopened, In Development, In Review, Code Review, Blocked         | Active                                                                      |

attestqa never edits a story's fields, in either tracker.

**The Jira QA sub-task.** Jira has no test-case item, so attestqa keeps one sub-task per story,
named `QA (attestqa): tests for SHOP-12 — …`. Its **description** holds the current test cases (ID,
criterion, type, conditions, expected result, the automated test, and what was excluded and why);
each run adds a **comment** with every case's result. It is created as soon as you approve a test design — **approving the design also posts its test
cases there** — and each run's results are added as a comment at the end. Its description changes
only when the test cases do (a changed design, or a test written for a case). It is the only issue
whose field attestqa ever edits, and it never changes its status — moving it to Done is yours. If your project has no sub-task type, the same record goes onto the
story as a comment.

---

## 4. Run a story

```bash
aqa run "Write tests for SHOP-12" \
  --config ai-quality.config.yaml \
  --workspace ./my-playwright-project
```

Run it from the folder that holds `.env` and the config. **Always pass `--workspace`**: without it
attestqa uses the current folder, and if that folder contains some other Playwright project it will
write there.

### What you will see

Each line starting `aqa:` is a step the runtime took, not something the model claims:

1. **Reading** — the story, its epic, sibling stories, sub-tasks, comments and the project's open
   bugs (read-only).
2. **Route** — what this run will do, decided from what is already on disk:
   - **A** — no feature file for this epic yet: write it.
   - **A2** — complete what is missing (a new story in an existing file, or design items without
     tests). Existing tests for other stories are left exactly as they are.
   - **B** — tests for this story already exist: run them, repair only what is broken.
3. **Test design — your approval.** The design is printed, one item per test (see below). Type `y`
   to approve, anything else to deny, `v` to see it in full.
4. **Writing** — scenarios go into the epic's `.feature` file, tagged `@story:<key>` and
   `@design:<Dn>`; tests are generated with bdd2pw or written beside existing ones.
5. **The suite runs.** Failures are **triaged** — environmental, flaky, a test problem (a locator
   that matched nothing), a known bug reproducing as expected, or a possible defect — and the line
   says which, with the confidence.
6. **Heal** — when a test fails because a locator matched nothing, a separate repair role takes over.
   It may change the locator and nothing else, and it chooses from what was actually on the page
   when the test failed.
7. **Verify** — a check that the run did what the story needed. It ends with `done`, or `blocked`
   with the reasons.

### Approving the design — what to look for

This is the one decision attestqa always leaves to you. Each item reads like:

```
D3  covers AC-2   security / equivalence partitioning
    conditions: wrong password; unregistered email
    expected:   the same "Invalid email or password." message for both
```

Check that every acceptance criterion is covered, that each **expected** is one observable result
(attestqa already refuses "X or Y"), and that the known bugs are either tested (marked to fail until
fixed) or excluded with a reason you accept. The design is the record of what this run promised to
check; the verifier holds the tests to it.

Later approvals — filing a bug, for example — work the same way. Nothing is written to Jira or
Azure DevOps without a `y` from you.

**Approving execution.** With `approve_execution: true` in the config (the Jira example sets it),
the first run of the suite in each run waits for you; re-runs after a repair go ahead under that
approval. With Jira that gives three decisions per story, in order: the test design (which also
posts the test cases to the QA sub-task), the execution, and any bug — bugs are put to you only
after execution has finished, for tests still failing in the final run.

### Approving from a file instead

For runs nobody is watching, `--approval file` writes each request to
`<ledger>/runs/<runId>/approvals/<id>.json` with `"decision": null`. Set `"decision"` to
`"approved"` or `"denied"` (and optionally `"by"`) and save. Silence past `--approval-timeout`
(default 1800 seconds) counts as denied. The VS Code extension uses this mode and shows the request
as a dialog.

### All the flags

```
aqa run "<request>" --config <file>
    [--workspace .]               the Playwright project to write into
    [--ledger .aqa]               where run records go
    [--env .env]                  credentials file
    [--tracker jira|ado]          default: from the story reference
    [--work-item <id>]            override the reference parsed from the request
    [--approval terminal|file]    who answers approvals (default terminal)
    [--approval-timeout <secs>]   file mode only; default 1800
    [--skill story-to-tests|defect-profile]
    [--servers ...]               tool servers to start (default: the tracker's set)
    [--dry-run]
```

`defect-profile` reads the project's closed bugs once and writes a profile that later story runs use
to aim their designs.

---

## 5. Read the result

### Coverage — is each story tested?

```bash
aqa coverage --workspace ./my-playwright-project
aqa coverage --workspace ./my-playwright-project --story SHOP-12 --out coverage.md
```

For every story: the design you last approved, the test that implements each item, and its last
result — passing, known bug reproduced, known bug **not** reproduced (review it), failing, not run,
or no test — plus acceptance criteria with no test. It reads only the ledger and the files on disk:
no model, tracker or browser. Exit code 0 means everything is covered and green, 3 means something
is missing — usable as a CI gate. `--json` gives the same data for other tools.

### Replay — what happened in a run

```bash
aqa replay .aqa                      # the latest run, as Markdown
aqa replay .aqa/runs/<runId>         # a specific run
aqa replay .aqa --out report.md
```

Rendered from the ledger alone. Read the `end` line (status and why), **Verifier gaps** (what was
not achieved, with the evidence) and **Checks not made** (what the environment prevented, which is
not the same as a failure).

### Check-rules — would today's rules decide differently?

```bash
aqa check-rules .aqa/runs/<runId> --config ai-quality.config.yaml --workspace ./my-playwright-project
```

Re-judges every proposal a past run made against the rules as they are now, offline, and reports
any decision that would change and whether the run's end point leaves a way forward. Useful after
upgrading attestqa, and when a run ended `blocked` and you want to know whether an upgrade fixes it.
Exit 2 means a rule deadlock was found.

### Exit codes

| Code | Status  | Meaning                                                            |
| ---- | ------- | ------------------------------------------------------------------ |
| 0    | done    | the verifier found no gaps                                         |
| 1    | error   | attestqa itself failed (config, credentials, a crash)              |
| 2    | blocked | gaps remain, an approval was denied, or it stopped making progress |
| 3    | refused | out of scope — nothing was spent                                   |
| 4    | budget  | the step or token budget ran out                                   |

---

## 6. What attestqa refuses

These are enforced by code at the moment a change is proposed, not by instructions to the model:

- removing or loosening an assertion in an existing test, or deleting a test;
- making a known bug's test pass by removing its expected-failure marker;
- a test that catches its own failure (`try/catch`, `.catch(() => {})`) and carries on;
- rewording another story's scenarios in a shared feature file;
- regenerating a spec that already holds working tests;
- writing a masked value (`[EMAIL]`, `[TOKEN]`…) into a file;
- editing a story's fields in Jira or Azure DevOps, or writing anything there without your approval;
- changing the project's Playwright config or `package.json`;
- browsing outside `scope.urls`, or reading work items outside `scope.work_items`.

When something is refused, the reason is shown to the agent and recorded in the ledger, so you can
see what it tried.

---

## 7. Cost

A story typically costs well under a dollar of model usage; a blocked run costs more than a
successful one because each cycle re-reads the context. To spend less: lower `budgets.steps`, keep
`scope.work_items` narrow, and use `--dry-run` after config changes.

---

## 8. In VS Code

The extension runs the same `aqa` with the same rules; it adds no rules of its own and removes none.

1. Install **attestqa** from the Marketplace and open the folder that holds your config and `.env`.
2. Set **attestqa: Workspace Dir** to your Playwright project (default `.`) and check
   **attestqa: Config File**.
3. Command palette → **attestqa: Run story…** → enter `SHOP-12` (Jira) or `123` (Azure DevOps).
   Output streams to the **attestqa** output panel.
4. When the design is ready, a dialog shows it item by item. **Approve** or **Deny**. Closing the
   dialog denies. **attestqa: Answer the pending approval** reopens it.
5. **attestqa: Show coverage** opens the coverage report; **attestqa: Replay a run** opens a run as
   Markdown; **attestqa: Check rules on recent runs** runs check-rules. The **attestqa** view in the
   activity bar lists runs and their events.

If `aqa` is not found, the extension offers to install it or to point at an existing one
(`attestqa.executablePath`).

---

## 9. Troubleshooting

Every entry here happened during development.

**It wrote tests into the wrong project.** `--workspace` was missing, so the current folder was
used. Remove what it created (`git status` shows it) and run again with `--workspace`.

**`401 authentication_error` and `.env` looks right.** A stale key in your shell is shadowing the
file. The startup line names the source of each key.

**Every test fails on a button or link that is clearly on the page.** The accessible name differs
from the visible text — Juice Shop's button shows "Log in" and is named "Login". The heal step finds
this from the page snapshot and fixes every test that used the same locator in one change. Name
your controls (`aria-label`, `data-testid`) and this stops happening.

**A known bug's test "passed".** In the per-test list it now shows as _fails as expected — known
bug reproduced_. A known bug that really stopped reproducing shows as _known bug NOT reproduced_ and
is raised for you to review; the expected-failure marker is never removed automatically.

**The design keeps being refused before you see it.** The refusal says why: a test type in
`test_types` with no item and no exclusion, an expected result with "or", or an open bug neither
tested nor excluded. The agent fixes these itself; if it cannot, the reason is in the ledger.

**`bdd2pw scaffold could not read the application's pages (exit 4)`.** The application is not
running at the configured URL, or the browser bdd2pw uses is not installed
(`npx playwright install chromium`). Nothing was written.

**`blocked: no progress`.** The same calls were proposed three cycles running. Replay the run and
read the last few observations; then run `aqa check-rules` on it — if a newer attestqa would decide
differently, upgrading fixes it.

**A browser window asks you to sign in to Azure DevOps.** The PAT is not reaching the server; check
`AZURE_DEVOPS_PAT` is set and non-empty.

**`You are not authorized to access this API` creating a test plan.** Your Azure DevOps account has
no Test Plans access level (a licence, not a permission). Set `capabilities.test_plans: false`.

**`Playwright produced no JSON report`.** The suite did not run: check `npx playwright test` works
by hand in the workspace.

---

## 10. In CI

```bash
aqa run "Write tests for SHOP-12" --config ai-quality.config.yaml \
  --workspace ./my-playwright-project --approval file --approval-timeout 300
aqa coverage --workspace ./my-playwright-project --out coverage.md
```

Nothing answers approvals in a pipeline, so the design approval times out and the run ends blocked
— which is the safe outcome. Design and approve interactively; in CI, run the suite with
`npx playwright test` and gate on `aqa coverage`. Never set `AQA_SANDBOX=1` in CI; it widens the URL
scope.

Archive `.aqa/runs/<runId>/` as a build artefact. It holds no API keys or tokens, but tool results
are stored as evidence, so it contains whatever your systems returned during the run: keep it
inside your organisation.

---

## 11. Security, in short

Credentials live only in `.env` or your shell, reach tool servers through the environment (never
the command line), and never appear in the ledger. Values that look like e-mail addresses, IPs or
tokens are masked before the model sees them. The model never receives a tool that can edit a
story. See [SECURITY.md](https://github.com/javvadivijayprasad/attestqa/blob/main/SECURITY.md) and
[ADOPTION.md](ADOPTION.md).
