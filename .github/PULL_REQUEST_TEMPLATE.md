## What this changes

<!-- One or two sentences a user would understand. Link the issue: Closes #123 -->

## Why

<!-- The problem this solves. If it came from a run, name the run id. -->

## Checklist

- [ ] The branch was cut from the current `release/X.Y.Z` branch and this pull request targets it (ADR-006).
- [ ] `npm run preflight` passes at the repo root (it is exactly what CI runs).
- [ ] A changeset is added (`npx changeset`), or this change does not touch a published package.
- [ ] No secrets: keys and tokens stay in git-ignored `.env` files, and no run ledger is committed.
- [ ] Docs are updated if behaviour or config changed (`packages/core/docs/USAGE.md`, `TECHNICAL.md`).

## If this touches the engine (`packages/core/src`)

- [ ] I followed the fix protocol in `packages/core/docs/ENGINE_MAP.md` (section 10) and updated ENGINE_MAP.md in this change.
- [ ] A rule that was added or changed has a test named after the run that produced it.
- [ ] A rule that was loosened comes with ledger evidence: the run, the events, and why the refusal was wrong (see `GOVERNANCE.md`).
- [ ] Old ledgers still replay (`npm test`). If their reports changed, a decision record is added in `research/decisions/`.
