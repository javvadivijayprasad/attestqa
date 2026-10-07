# Azure DevOps cleanup — what to change, and the evidence for it

Compiled from all 56 run ledgers on 7 October 2026. Every bug id below was read back
from the `create` call's own observation in the ledger, so these are the records the
runtime actually made, not a reconstruction.

**I could not do this myself:** `dev.azure.com` is not reachable from the desktop
workspace (`curl` returns 000 — it is outside the egress allowlist), and your PAT stays
in the local `.env`. So this is the list; the clicks are yours.

---

## Every bug this runtime has filed

| id | Title | Verdict |
| --- | --- | --- |
| #73 | AC-1b: Logout does not redirect to login page — user stays on home page | **duplicate** of #87 |
| #74 | Login page form elements are missing accessible labels (WCAG 2.1 AA) | verify — see §4 |
| #79 | Logout button not accessible in account menu dropdown after sign-in | **not a defect** — §3 |
| #80 | Logout flow page has WCAG A/AA violations: color-contrast and label | verify — see §4 |
| #81 | Logout option in account menu dropdown is not accessible after sign-in | **not a defect** — §3 |
| #82 | Logout option in account menu dropdown is not reachable after sign-in | **not a defect** — §3 |
| #83 | AC Story-c: After logout, navigating to /#/profile does not redirect to login | **keep open** — real, reproduced |
| #84 | Accessibility: Logout flow has WCAG A/AA violations detected by axe-core | verify — see §4 |
| #85 | Story-a: Logout redirects to home page instead of login page | **duplicate** of #87 |
| #86 | Logout does not redirect to the login page — lands on home page instead | **duplicate** of #87 |
| #87 | AC Story-a: Logout redirects to home page (/#/) instead of login page (/#/login) | **keep open** — real, reproduced |

Two corrections to what I said last week: **#83 is the protected-route bug, not the
logout-redirect one** — so Story-c does already have its own record, and the open
question about it is closed. And the logout-redirect defect has **four** records, not
three.

---

## 1. Post the product-owner ruling on AB#44

`story_context` reads the story's comments and filters out the runtime's own run
reports, so a human comment lands in context as a first-class source the design can
cite. Suggested text:

> **Product owner ruling — logout destination.** Logging out must return the user to
> the login page (`/#/login`). Landing on the home page (`/#/`) is a defect, not an
> acceptable alternative, and this holds regardless of how the application currently
> behaves. Any test asserting the logout destination should cite this ruling as its
> source.

Why it matters beyond tidiness: the agent's closing note on `20260928T100221Z` objected,
correctly, that *"the source for the `/#/login` redirect expectation is not in the story
description."* The preflight tells it to use only what is written down, so every run
re-derives a decision that nobody has written down. This ends that, and it closes the
largest hole named in `WEAKENING.md` §7 — an expectation with no recorded origin.

## 2. Close the duplicate logout-redirect bugs

Keep **#87** (clearest title). Close **#73**, **#85**, **#86** as duplicates of it.

One defect, filed once per run that met it, because bugs this runtime files are withheld
from its own context on purpose. `duplicateBug` now refuses a fifth; it cannot
retroactively merge the four.

## 3. Close #79, #81, #82 — the control was there the whole time

These say the Logout menu item is not accessible or not reachable after sign-in. It was
on screen in every one of those runs. The selector was wrong, and
`20260923T235843Z` filed four bugs about it across four attempts without ever reading
the page.

That is what `aqa.heal_locator` and the `unhealedLocator` rule were built for, and the
proof is in the later ledgers: the same menu item is found by
`getByRole("menuitem", { name: "Logout" })` and the logout flow's other tests all pass,
which they could not do without clicking it.

Close as **not a defect** (test defect), not as duplicates — the distinction is the
point. Agent-filed, unconfirmed, and wrong.

## 4. Do NOT close #80 / #84 yet — the passing test is suspect

This is a new finding and it changes the advice I gave last week.

The logout accessibility test failed in **31** consecutive runs and has passed in the
**22** since. The application did not change. What changed is the scan's scope, rewritten
by the agent in `20260925T192122Z`:

| Run | `.include(...)` | Result |
| --- | --- | --- |
| …174149Z | `mat-toolbar` | failed |
| …184615Z | `#navbarAccount` | failed |
| **…192122Z onward** | `app-header, mat-menu, .mat-menu-panel, .cdk-overlay-container` | **passed** |

A scoped axe scan is legitimate — scanning a whole storefront reports violations from
unrelated components, and design item D12 asks for the navigation and overlay area. But
`.include()` with selectors that match no element scans nothing and reports zero
violations. Juice Shop is Angular Material: `mat-menu` is not a DOM element at runtime,
and the header component is `app-navbar` rather than `app-header`. If
`.mat-menu-panel` is also wrong for this Material version, the scan sees an empty set
and the test passes vacuously.

**Check before closing anything.** One line in that test, temporarily:

```ts
const scoped = page.locator("app-header, mat-menu, .mat-menu-panel, .cdk-overlay-container");
console.log("axe scope matched", await scoped.count(), "node(s)");
```

- Matches 0 → the pass is meaningless, #80 and #84 stay open, and the test needs a real
  scope.
- Matches several → the pass is real and both bugs can be verified and closed.

Either way the test should assert it:

```ts
expect(await scoped.count(), "the axe scope matched no elements — the scan would be vacuous")
  .toBeGreaterThan(0);
```

A scan that scanned nothing is not a pass. #74 deserves the same check, since the login
page's scan is scoped to `app-login`.

## 5. Bug #48 — close it

Its expected-to-fail test has passed in **30 runs**, including all eight of the most
recent. `test.fail(...)` is still on it, so each pass reaches the report as "did not
reproduce" rather than disappearing into the green — which is the arrangement working as
designed.

Close #48, and drop the `test.fail` marker in the same change so the test becomes an
ordinary regression test. Leaving the marker on a fixed bug means a future regression
reads as an expected failure.

---

## What this adds to the weakening corpus

§4 is a **sixth route to a weaker test, and the guards do not cover it**: narrowing an
assertion's *scope* rather than its claim. `assertionsOf` sees `toEqual([])` before and
after and finds nothing lost, because nothing was lost — the assertion is identical and
the thing being asserted about got smaller. It was introduced in the same run that was
arguing about the logout defect, and it turned 31 red runs green.

Worth adding to `WEAKENING.md` §2 as **Narrow**, and worth a rule: an accessibility
assertion whose scope selector changed in the same write that made the test pass should
be refused, or at minimum recorded as a change of intent requiring approval. The cheap
and durable version is the one above — make the test prove its scope matched something.
