# Working on attestqa

Before changing anything in the engine (`packages/core/src`), read
`packages/core/docs/ENGINE_MAP.md` and follow its fix protocol (§10):

1. Find the stage and its owner (§2).
2. List every rule and loop control acting on that stage (§5–§7).
3. Change or remove a rule before adding one.
4. Replay the real ledgers that showed the problem; write a test from them.
5. Run the rule-interaction tests.
6. Update ENGINE_MAP.md in the same change.

Other standing rules for this repo:

- Secrets live only in git-ignored `.env` files. Never in config files, argv, or chat.
- bdd2pw and pw-self-heal changes go to their own maintainers as handoffs, not edits from here.
- Git commits, pushes, publishing and tracker writes are done by the user.
- Back up a file before editing anything outside the repo: `<name>.before_<what>_<date>.bak`.
