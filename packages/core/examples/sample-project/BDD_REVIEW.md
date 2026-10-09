# bdd2pw — Conversion Review

> **Source feature:** `E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa\examples\sample-project\features\epic-42-customer-account-access.feature`
> **Target URL:** http://localhost:3100/#/login
> **Generated:** 2026-09-25T14:51:44.886Z

## Summary

0 errors · 18 warnings · 7 info

## Warnings

- [AC-1: Registered user signs in with correct email and password] no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-1: Registered user signs in with correct email and password] no rule matched: "And I find the Password field and enter "[AQA_APP_PASS]""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-1: Registered user signs in with correct email and password] no rule matched: "Then the URL does not contain "/#/login""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-1: Registered user signs in with correct email and password] ambiguous visibility step: no POM field matched "the account menu". Add a locator field to the POM, or hand-edit the spec to point at the right element. (bdd2pw will not synthesise a URL regex from a prose noun — that produced always-failing tests in v3.0.0 and earlier.)
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2: Wrong password shows generic error and keeps user on login page] no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2: Wrong password shows generic error and keeps user on login page] no rule matched: "And I find the Password field and enter "WrongPassword!99""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-3a: Touched email field left empty shows validation message and Log in button is disabled] no rule matched: "Then the Log in button is disabled"
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-3b: Touched password field left empty shows validation message and Log in button is disabled] no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-3b: Touched password field left empty shows validation message and Log in button is disabled] no rule matched: "Then the Log in button is disabled"
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-4: Unregistered email produces same generic error as wrong password] no rule matched: "When I find the Email field and enter "notregistered_qa_9x7z@example.com""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-4: Unregistered email produces same generic error as wrong password] no rule matched: "And I find the Password field and enter "SomePassword123!""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2 / Bug-48: Error message clears after a successful login following a failed attempt] no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2 / Bug-48: Error message clears after a successful login following a failed attempt] no rule matched: "And I find the Password field and enter "WrongPassword!99""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2 / Bug-48: Error message clears after a successful login following a failed attempt] no rule matched: "When I find the Password field and enter "[AQA_APP_PASS]""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2 / Bug-48: Error message clears after a successful login following a failed attempt] no rule matched: "Then the URL does not contain "/#/login""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [AC-2 / Bug-48: Error message clears after a successful login following a failed attempt] no rule matched: "Then the page does not display "Invalid email or password.""
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- [Accessibility — login page passes axe-core WCAG A/AA scan] no rule matched: "Then the page has no axe violations"
  - Suggestion: Add a custom step rule, enable --llm fallback, or hand-edit the spec.
- `E:/EB1A_Research/EB1_Master/06_Authorship/Paper_I_AgenticQA/Experiment/agentic-qa/examples/sample-project/pages/login.page.ts` — DOM DRIFT detected: the page's accessibility tree has changed since the last scaffold. Previous hash 135a082a8a0c… → new hash 1fb6c56103c6…. Any pinned locators may now point at moved or missing elements.
  - Suggestion: Review the diff between the last snapshot and the current one, then re-run the affected specs to confirm behaviour. Pass --fail-on-drift in CI to gate merges on this signal.

## Info

- Parsed feature "Customer account access" — 7 scenario(s) + Background
- `E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa\examples\sample-project\package.json` — package.json already exists — left untouched.
- `E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa\examples\sample-project\playwright.config.ts` — playwright.config.ts already exists — left untouched.
- `E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa\examples\sample-project\tsconfig.json` — tsconfig.json already exists — left untouched.
- `E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa\examples\sample-project\.gitignore` — .gitignore already exists — left untouched.
- Discovered 46 element(s); picked 45 unique locator(s)
- POM decision for LoginPage: AUGMENT (missing fields: loginButton)
