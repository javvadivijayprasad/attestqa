# attestqa

*Formerly `@vijaypjavvadi/agentic-qa` (engine 1.x). Version 2.0.0 is the engine inside attestqa
release v1.0.0; the `aqa` command is unchanged.*

[![CI](https://github.com/javvadivijayprasad/attestqa/actions/workflows/ci.yml/badge.svg)](https://github.com/javvadivijayprasad/attestqa/actions/workflows/ci.yml)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22758876.svg)](https://doi.org/10.5281/zenodo.22758876)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**A QA agent that has to show its work.**

A language model chooses the next action. Code decides whether that action is allowed. Code decides
whether the job is finished. Every step — what was proposed, what was permitted, what happened — is
appended to a ledger you can replay offline.

Point it at a user story in **Jira or Azure DevOps**. It reads the story, its epic, sub-tasks,
comments and open bugs, proposes a test design that **you approve**, writes Playwright tests into
your own project, runs them, triages failures and repairs broken locators — and refuses, in code,
any change that would make a failing test pass by weakening it.

```
aqa run "Write tests for SHOP-12" --config ai-quality.config.yaml --workspace ./my-playwright-project
```

```
aqa: route A2 — complete what is missing: the feature file exists but has no scenario tagged @story:SHOP-12
  approve? [y/N/v=verbose] y
aqa: test design approved — 5 item(s); tests are written from it
aqa: suite green — 5 passed, 0 failed, 0 skipped (1 of the passed: known bug reproduced, failing as expected)
aqa: checks passed — the run did what this story needed
```

Also in VS Code: install **attestqa** from the Marketplace (publisher `vijaypjavvadi`).

---

## Why this exists

Most teams write acceptance criteria and then, weeks later, someone turns them into automated tests
from memory. The mapping between requirement and test is maintained by hand, rots quietly, and
nobody can answer "is this story actually tested?" without opening things one at a time.

Handing that job to an AI agent creates a different problem. An agent that can write tests can also
delete a branch, rewrite a requirement, or report success it did not achieve. The interesting
question is not whether a model can write a Playwright test — it can — but whether you can let one
near your issue tracker and still be able to prove, afterwards, exactly what it did and why.

This runtime is an answer to that second question.

## Three ideas

**The model proposes; code disposes.** Every tool call is classified — read, workspace write,
branch write, record write, destructive — and a policy table you own decides: execute, ask a human,
or refuse. A tool nobody classified is refused. The safe default is no.

**The model does not grade itself.** When it believes the work is done it stops and says so. That
claim is written to the ledger and then ignored. Separate code goes back through the record and
checks that specific things were observed to happen: the story was read, a spec exists, the suite
ran green, the cases are linked to the story. Disagreement between the claim and the verdict is the
most informative thing in a failed run.

**The ledger is both the memory and the evidence.** Each cycle is rebuilt from the ledger rather
than from an open conversation with the model, which is what makes a run replayable: `aqa replay`
renders any run with no network and no tool calls, and every number in the report traces to an
event id.

## What it is built on

Tools reach the agent over the **Model Context Protocol**, from three places that are trusted
differently:

- **`@azure-devops/mcp`** (pinned 2.10.0) — work items, test cases, comments. It multiplexes many
  operations behind one tool name and an `action` argument, so it is classified _per action_: an
  action nobody classified is refused like an unknown tool.
- **`@playwright/mcp`** (pinned 0.0.80) — a live browser, for finding real selectors. It also exposes
  click, type, fill and press; those are never classified, which is how the exploration-only rule is
  enforced rather than merely stated.
- **Six in-process adapters** written for this runtime — `fs` (workspace-confined), `bdd2pw` (Gherkin
  → spec), `pw` (runs your suite, keeps the report), `summary` (renders the run report from the
  ledger), and `tcg` / `synthdata` (site-specific, opt-in). Three carry the names of the author's
  separate projects but are not dependencies on them: `bdd2pw` is reimplemented here, `synthdata`
  runs as a subprocess, `tcg` is a remote service — and enabling `tcg` sends story text to it.

Running your Playwright suite is **not** an MCP call — the Playwright server drives a browser, the
`pw` adapter runs your `playwright.config.ts`. The agent explores with the first and tests with the
second.

Three runtime dependencies: the Anthropic SDK, the MCP SDK, a YAML parser. Everything else is Node's
standard library — a runtime whose job is auditability should not itself be a supply chain.

Full inventory in [FUNCTIONAL.md](docs/FUNCTIONAL.md#what-provides-each-capability); wire formats and
event shapes in [TECHNICAL.md](docs/TECHNICAL.md).

## Install

Requires Node 20+. Everything else attestqa uses (packages, services, the evaluation apps) is listed in [DEPENDENCIES.md](https://github.com/javvadivijayprasad/attestqa/blob/main/DEPENDENCIES.md).

```bash
npm install -g attestqa
aqa --version
cd my-playwright-project
aqa init        # four questions; writes ai-quality.config.yaml and a .env to fill in
```

Or run it from a clone:

```bash
git clone https://github.com/javvadivijayprasad/attestqa
cd attestqa && npm ci && npm run build
node dist/cli.js --help
```

## Five-minute start

The full walk-through, for Jira and Azure DevOps, is the [user guide](docs/USAGE.md). In short:

1. **A Playwright project** for the site under test, whose `playwright.config.ts` reads
   `baseURL` from `AQA_APP_URL`. attestqa writes into it and nowhere else.
2. **`.env`** (never committed — `.env.example` lists the names): a model key
   (`ANTHROPIC_API_KEY`, or OpenAI / Azure OpenAI / gateway / local), your tracker
   (`JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN`, or `AZURE_DEVOPS_ORG_URL` +
   `AZURE_DEVOPS_PROJECT` + `AZURE_DEVOPS_PAT`), and a disposable test login
   (`AQA_APP_URL`, `AQA_APP_USER`, `AQA_APP_PASS`).
3. **`ai-quality.config.yaml`** — copy `examples/ai-quality.jira.config.yaml` or
   `examples/ai-quality.config.yaml` and set `scope.work_items` and `scope.urls`.
4. **Check** without spending anything:
   `aqa run "Write tests for SHOP-12" --config ai-quality.config.yaml --workspace ./my-playwright-project --dry-run`
5. **Run** it without `--dry-run`, approve the design when asked, then read the result:

```bash
aqa coverage --workspace ./my-playwright-project   # each story: design, tests, last result
aqa replay .aqa                                    # what happened in the latest run
```

## What it does today

- **Reads** a story from Jira or Azure DevOps, with its epic, sibling stories, sub-tasks, comments
  and the project's open bugs (read-only).
- **Designs** the tests — functional, security, accessibility, confirmation of known bugs — one item
  per test, and waits for a person to approve the design.
- **Writes** Playwright tests with bdd2pw: one feature file per epic, each scenario tagged
  `@story:<id>` and `@design:<Dn>`; a new story is added beside existing ones without touching them.
- **Runs and triages** the suite: environmental, flaky, a locator that matched nothing, a known bug
  reproducing as expected, or a possible defect — from evidence, with a confidence.
- **Repairs** locators from the page as it was when the test failed, with pw-self-heal ranking the
  same candidates as an independent second opinion.
- **Verifies** that the tests match the approved design, and **records** everything in a ledger:
  `aqa replay` renders a run, `aqa coverage` shows each story's design-to-result trace, and
  `aqa check-rules` re-judges past runs against today's rules.
- On Azure DevOps it links test cases to the story and posts a summary counted from the ledger; on
  Jira, where there are no test cases, the tagged scenarios are the record.

## What it will not do

Deliberate limits, not missing features:

- **It cannot operate your application.** It may navigate, snapshot, search and screenshot, to find
  real selectors. Click, type, fill and press are never classified, so they cannot be called. The
  only thing that interacts with your app is the test suite it writes.
- **It cannot edit a work item's fields.** It can create bugs (and, on Azure DevOps, test cases and
  comments), each after you approve. It cannot
  rewrite the acceptance criteria it is being verified against — an agent that can edit its own
  requirements is not auditable.
- **It cannot delete anything.** `destructive` refuses by default and destructive-looking tool names
  are raised to that class regardless of how they are declared.
- **It cannot write outside its workspace.** Every filesystem path resolves under the folder you
  point it at.
- **It does not publish test results to Azure Test Plans.** Creating a test _case_ works on a Basic
  licence; a test _plan_ or _suite_ needs the paid Test Plans access level. Set
  `capabilities.test_plans: false` and the run records what it could not check rather than failing.

## Documentation

| doc                                        | for                                                      |
| ------------------------------------------ | -------------------------------------------------------- |
| [User guide](docs/USAGE.md)                | installing, configuring, running, approving, results, VS Code |
| [Adoption](docs/ADOPTION.md)               | what a team has to change, who does it, in what order    |
| [Roadmap](https://github.com/javvadivijayprasad/attestqa/blob/main/ROADMAP.md) | what ships each month |
| [How a run works](docs/HOW-A-RUN-WORKS.md) | every stage of one real run, in order                    |
| [Functional](docs/FUNCTIONAL.md)           | what it does, capability by capability                   |
| [Architecture](docs/ARCHITECTURE.md)       | the design decisions, and the trade-offs behind them     |
| [Technical](docs/TECHNICAL.md)             | components, contracts, event shapes, extension points    |
| [Releasing](docs/RELEASING.md)             | cutting a version and publishing it                      |
| [CHANGELOG](CHANGELOG.md)                  | every change, with the observed failure that prompted it |

## Status

**Engine 2.0.0, part of attestqa release v1.0.0 (15 November 2026).** Jira and Azure DevOps, any
model your company uses, the CLI and a VS Code extension. Stories run end to end against a live Jira
project and OWASP Juice Shop; the runtime, governance rules, ledger, replay, coverage and verifier
are covered by more than 750 tests, including a golden fixture that fails CI on any drift in the
event shapes. What comes next is in the
[roadmap](https://github.com/javvadivijayprasad/attestqa/blob/main/ROADMAP.md).

The event shapes, CLI flags, exit codes, config schema and approval file format are a contract —
changing any of them is a MAJOR version bump.

## Contributing

Issues and pull requests are welcome, particularly: another issue tracker behind the same skill
interface, another test framework behind the `pw` adapter, and reports of what the governance
defaults get wrong in a real team.

```bash
npm ci
npm run typecheck && npm test && npm run lint && npm run build
npm run fixture:make && git diff --exit-code   # the golden ledger must not drift
```

## Citation

If you use this in published work, cite it with the metadata in
[`CITATION.cff`](CITATION.cff) — GitHub renders a "Cite this repository" button from it, and most
reference managers import it directly.

Vijay Prasad Javvadi, Independent Researcher, Plainsboro, NJ, USA · ORCID
[0009-0004-1192-6906](https://orcid.org/0009-0004-1192-6906).

Archived on Zenodo: [10.5281/zenodo.22758876](https://doi.org/10.5281/zenodo.22758876).

## License

MIT.
