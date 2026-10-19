# Dependencies

Everything attestqa needs, in one place: what you install, what attestqa downloads on its own, the services it talks to, and what the evaluation apps need.

## 1. To install

| What          | Version             | Why                                                                                                          |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Node.js       | 20 or newer         | Runs the engine (`aqa`) and the MCP servers                                                                  |
| npm           | comes with Node     | Installs attestqa and runs `npx` for the MCP servers                                                         |
| Google Chrome | any current version | The agent's browser by default. Set `AQA_BROWSER` to use `msedge`, `firefox`, `webkit` or `chromium` instead |
| Git           | any                 | Only to work from a clone of this repo                                                                       |

To install: `npm install -g attestqa`. Or, from a clone: `npm ci && npm run build`.

## 2. npm packages attestqa depends on (installed with it)

### Our own packages (npm scope `@vijaypjavvadi`)

| Package                       | Version | Used for                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vijaypjavvadi/bdd2pw`       | ^4.6.5  | Turns `.feature` files into Playwright specs and page objects (`bdd2pw.analyze`, `bdd2pw.scaffold`). 4.6.0 or later: it will not empty or shrink a page object a spec still uses, keeps quoted text with `$` and digits (prices) unchanged, and can roll back a scaffold that breaks the type check. 4.6.1: "navigate to page 2" is left unbound instead of opening the home page, and an accessibility step generates the `AxeBuilder` check. 4.6.3: "page 2 is active" checks `aria-current`, the control's class and its parent's class, retrying until the page has updated. 4.6.5: a test with a step it could not bind is marked `test.fixme` (reported skipped, never passed); repeated elements become list fields, so "each product card shows a name" binds; "page 1 is not active" binds |
| `@vijaypjavvadi/pw-self-heal` | ^1.3.0  | Second-opinion ranking when a locator breaks (`aqa.heal_locator`). Suggest-only: it never changes a test at run time                                                                                                                                                                                |

### Third-party packages

| Package                     | Version  | Used for                                                      |
| --------------------------- | -------- | ------------------------------------------------------------- |
| `@anthropic-ai/sdk`         | ^0.125.0 | The Claude model route (direct, or through a company gateway) |
| `@modelcontextprotocol/sdk` | ^1.12.0  | Talking to the MCP tool servers                               |
| `yaml`                      | ^2.5.0   | Reading `ai-quality.config.yaml`                              |

## 3. Downloaded automatically when a run starts

Fetched with `npx` at a pinned version. No separate install is needed, but the machine needs access to the npm registry.

| Server              | Pinned version | Override                     | Needed for                                                                 |
| ------------------- | -------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `@playwright/mcp`   | 0.0.80         | `AQA_PLAYWRIGHT_MCP_VERSION` | Letting the agent look at the application (navigate, snapshot, screenshot) |
| `@azure-devops/mcp` | 2.10.0         | `AQA_ADO_MCP_VERSION`        | Azure DevOps stories only                                                  |

Jira needs no extra server; attestqa talks to Jira's REST API itself.

## 4. Services a run talks to

| Service                    | Needed when                                                                                                                                      | Set in `.env` (never in the config file)                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| A model                    | Always. One of: Anthropic, a Claude company gateway, Azure OpenAI, an OpenAI-compatible gateway, or GitHub Copilot through the VS Code extension | `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, or the variables `aqa init` writes for the chosen route |
| Jira Cloud                 | Jira stories                                                                                                                                     | `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`                                                                                     |
| Azure DevOps               | Azure DevOps stories                                                                                                                             | `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT`                                                             |
| ai-governance sidecar      | Only when `agent.llm_fallback` is set, so bdd2pw can use a model for steps its rules cannot bind                                                 | `AI_GOVERNANCE_URL` (for example `http://127.0.0.1:4900`). Without it, those steps are left as TODO                            |
| The application under test | Always                                                                                                                                           | `AQA_APP_URL`; test accounts in `AQA_APP_USER` / `AQA_APP_PASS`                                                                |

## 5. The Playwright project attestqa writes into

The workspace you point `--workspace` at must have:

- `@playwright/test`, with a `playwright.config.ts` whose `baseURL` reads `AQA_APP_URL`;
- `@axe-core/playwright`, if `accessibility` is one of the test types in scope;
- TypeScript and `@types/node`, so specs type-check.

For a project with no Playwright layer yet, `npm init playwright@latest` creates one; then add `@axe-core/playwright` if you need it.

## 6. VS Code extension (`attestqa-vscode`)

| What             | Version                           | Why                                                              |
| ---------------- | --------------------------------- | ---------------------------------------------------------------- |
| VS Code          | 1.95 or newer                     | Language-model API and chat participants                         |
| The `aqa` engine | as above                          | The extension runs it; it does not bundle it                     |
| GitHub Copilot   | a Copilot subscription, signed in | Only for the Copilot model route and `@attestqa` in Copilot Chat |

## 7. For development (this repo)

| What                                                                                                                              | Where                           |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@changesets/cli`                                                                                                                 | root: versioning and changelogs |
| `typescript`, `tsup`, `tsx`, `vitest`, `eslint`, `typescript-eslint`, `@eslint/js`, `prettier`, `@types/node`, `@playwright/test` | `packages/core`                 |
| `typescript`, `@types/vscode`, `@vscode/vsce`, `@types/node`                                                                      | `packages/vscode`               |

Run `npm test`, `npm run build`, `npm run lint`.

## 8. For the evaluation (`TestRunApplication/`)

| What           | Version                       | Notes                                                                                                           |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Docker Desktop | current                       | Runs the local apps                                                                                             |
| Python 3.12    | for the ai-governance sidecar | Start it with `.venv\Scripts\python.exe -m uvicorn service.app:app --port 4900` from the `ai-governance` folder |

| App                                                    | Tracker                             | How it runs                                                                                                              | Address                                                                    |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| OWASP Juice Shop                                       | Jira (`SCRUM`)                      | `docker run --rm -d -p 3100:3000 --name juice-shop bkimminich/juice-shop`                                                | http://localhost:3100                                                      |
| Toolshop (practice-software-testing, `SPRINT=sprint5`) | Jira (`TOOL`)                       | its `docker-compose.yml`, then `php artisan migrate:fresh --seed`. Its MySQL is moved to host port 3307 if 3306 is taken | UI http://localhost:4200, API http://localhost:8091 (both in `scope.urls`) |
| Restful-Booker Platform                                | Azure DevOps (`attestqa-booker`)    | its `docker compose up -d`                                                                                               | http://localhost:3003                                                      |
| SauceDemo                                              | Azure DevOps (`attestqa-saucedemo`) | hosted practice site, nothing to run                                                                                     | https://www.saucedemo.com                                                  |

Each app's workspace has its own `package.json`: run `npm install` once in `TestRunApplication/<app>`. Step-by-step setup is in `TestRunApplication/DAY1_SETUP.md`.
