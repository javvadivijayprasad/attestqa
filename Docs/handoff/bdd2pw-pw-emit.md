# What attestqa needs from bdd2pw and pw-emit

From: attestqa (packages/core, depends on @vijaypjavvadi/bdd2pw ^4.3.2)
Date: 2026-10-11
Target: attestqa v1.0.0 on 15 Nov 2026. Anything below should be released on npm
by about 8 Nov so attestqa can raise its range and test before the freeze.

## Status (2026-10-11)

Shipped: --spec-name (bdd2pw 4.4.0), provenance comments + contract (4.4.1),
fixtures via pw-emit `emitFixtures` (bdd2pw 4.5.0 / pw-emit 1.4.0). attestqa
now depends on bdd2pw ^4.5.0 and passes --spec-name. **Still open: ask 0,
`--browser-channel` (bdd2pw discovery still launches bundled Chromium).**

## New bugs from attestqa run 20261011T222522Z (2026-10-11) — please fix first

A. **Empty locators are emitted, never refused.** Page discovery that cannot
   resolve an element writes `page.locator("")`. In the Juice Shop login page
   object 41 of 53 fields were empty even in the good 2026-09-25 scaffold. An
   empty selector is never valid code: Playwright fails with `Unexpected token ""
   while parsing css selector ""`. Please emit no field (or a `// TODO: unresolved`
   comment) instead, and report the count as a warning on stdout.

B. **A re-scaffold blanks locators that were good.** The scaffold at
   2026-10-11T21:55Z (bdd2pw 4.5.0, most likely with page discovery unable to
   launch a browser) rewrote `pages/login.page.ts` with all 53 locators empty,
   replacing 12 real ones such as
   `this.loginButton = page.getByRole("button", { name: "Login" })`. When
   discovery fails, scaffold should stop with a non-zero exit (as `analyze` does,
   exit 4), not continue and overwrite. On re-scaffold, an existing non-empty
   locator should never be replaced by an empty one.

Repro: Juice Shop on :3100, `npx playwright` browsers NOT installed, then
`bdd2pw scaffold features/epic-scrum-5-customer-account-access.feature --url
http://localhost:3100/#/login --repo . --spec-name epic-scrum-5-customer-account-access`
in TestRunApplication/juice-shop with the 25 Sep page object present.

## Asks, in priority order

0. **Use the browser a team already has (bdd2pw).** Page discovery launches
   Playwright's bundled Chromium (`src/discovery/mcpClient.ts`:
   `chromium.launch({ headless: !opts.headed })`), so every machine needs
   `npx playwright install chromium` first; attestqa's first Jira run
   (20261011T210750Z) stopped on exactly that. Most teams run Chrome. Please add
   `--browser-channel <chrome|msedge|chromium>` (and env `BDD2PW_BROWSER_CHANNEL`),
   default `chrome`, passed as `chromium.launch({ channel, headless })`, falling back
   to bundled Chromium with a clear message when the channel is not installed.
   attestqa already does this for its own browser (`--browser chrome` to
   @playwright/mcp) and for generated suites (`channel: "chrome"`).

1. **Name the spec after the feature file (bdd2pw).** Today the spec stem comes
   from the page object (`src/index.ts` step 9: `login.page.ts` → `tests/login.spec.ts`).
   attestqa keeps one feature file per epic, `features/epic-<id>-<slug>.feature`
   (e.g. `epic-scrum-5-customer-account-access.feature`, `epic-42-customer-account-access.feature`),
   and expects `tests/<same stem>.spec.ts`. Run 20260925T151945Z lost its budget
   looking for the spec under the feature's name. Either default to the feature
   stem, or add `--spec-name <stem>`; attestqa will pass it explicitly either way.
2. **Release bdd2pw 4.4.0** (provenance work, changelog dated 2026-09-26, still
   uncommitted). Please normalise line endings in the same commit
   (`.gitattributes`); the current diff is mostly CRLF churn.
3. **Provenance in a fixed, parseable form (bdd2pw 4.4).** attestqa will count,
   per scenario, how many steps came from a rule, the LLM fallback, or were left
   TODO. Please document the exact comment format (lane, rule id, pack,
   provider/model) as a SemVer-covered contract, and keep it on one line per step.
4. **Fixtures through pw-emit.** pw-emit 1.4.0: `emitFixtures({ selfHealing: "heuristic"|"ml"|"hybrid" })`
   (move `renderPwSelfHealFixtures` out of bdd2pw `src/repo/projectScaffolder.ts`).
   bdd2pw 4.5.0 uses it. After that every file bdd2pw writes comes from pw-emit
   except the legacy `lib/heal.ts`, which is already scheduled for removal in v5.0.

## Contract attestqa relies on today — please do not break

- CLI: `bdd2pw scaffold <feature> --url <url> --repo <dir> [--page <name>] [--pages <list>]
  [--storage-state <path>] [--llm-model <m>] [--llm <provider> --governance-url <url>]`
  and `bdd2pw analyze <feature> --url <url>`. Exit 0 on success, non-zero on failure.
- Output layout: specs in `<repo>/tests`, page objects in `<repo>/pages`.
- **Scenario tags survive into the spec verbatim** as a `// @tag …` comment line
  directly above each `test(...)`. attestqa reads `@story`, `@ac`, `@bug`,
  `@design`, `@type`, `@technique` from those lines to decide which tests belong
  to which story. Tags may now be Jira keys: `@story:SCRUM-8`, `@bug:SCRUM-12`
  (upper case, hyphen) — please keep them byte for byte, no case or slug changes.
- Unbound steps are reported as JSON warnings on stdout, matched by
  `"severity": "warn"|"error", "message": "…"` with messages containing one of:
  `no rule matched`, `could not bind`, `unmatched step`, `ambiguous … step`,
  `no POM field matched`. If the wording changes, tell us and we change the matcher.
- Unimplemented steps stay visible (TODO / `test.fixme`), never silently passing.
- Re-scaffold preserves user blocks (the `[merge] preserved …` behaviour). attestqa
  relies on it so an agent's implemented TODO bodies and `test.fail(...)` markers
  for known bugs are not wiped by a re-scaffold.
- The LLM fallback runs only with `--governance-url` and fails closed without it.
  attestqa never passes `--llm-skip-governance` and has a rule that it is never
  constructed; please keep that flag test-only.

## How attestqa will take the changes

attestqa raises its range only after the release is on npm (AQ-09 §7): bdd2pw
`^4.5.0`, pw-emit transitively. Each release note should list the change and
whether the CLI or stdout format moved.
