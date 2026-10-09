# Contributing to attestqa

Thank you for looking. A few things are different here from most projects, because the point of attestqa is that its results can be trusted.

**The refusal rules are the product.** A change that loosens a rule in `packages/core/src/skills/story-rules.ts` (or any rule that stops the agent weakening a test) needs an argument backed by ledger evidence: the run, the events, and why the refusal was wrong. See `GOVERNANCE.md`.

**Every rule has a test named after the run that produced it.** If you add or change a rule, add the test and name the run in a comment, the way the existing ones do.

**Old ledgers must still replay.** `npm test` runs the replay tests over recorded runs. A change that alters their reports needs a decision record in `research/decisions/`.

**No secrets, ever.** Keys and tokens live in git-ignored `.env` files or the app's vault. Run ledgers are not committed.

How to work: fork, branch, `npm ci`, `npm test`, open a pull request. Add a changeset (`npx changeset`) describing your change in a sentence a user would understand.
