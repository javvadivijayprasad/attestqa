# Versions

Three artefacts ship from this repository and they are versioned independently.
This file is the single place that says what is released where, because the
answer has been wrong twice already — once when `aqa --version` printed a
hardcoded `0.1.0-dev.0` that a substring assertion had been happily matching,
and once when a git tag was moved to a commit npm had never seen.

Check this table against reality before every release, with the commands below.

## Current

| Artefact | Name | Version | Published | Source |
| --- | --- | --- | --- | --- |
| Runtime | `attestqa` | **1.0.0** | npm | `package.json` |
| Extension | `vijaypjavvadi.agentic-qa-vscode` | **1.0.0** | VS Code Marketplace | `extension/package.json` |
| Archive | `agentic-qa` | 0.1.2 | Zenodo (DOI) | `CITATION.cff` |

The runtime and the extension are held at the same number deliberately. They are
not technically coupled — the extension reads ledgers the runtime writes and
would keep working across a minor bump — but two numbers that drift apart make
"which version are you on?" a two-part question for no benefit anyone has felt.
When they need to diverge, they will, and this table is where that is recorded.

The Zenodo archive tracks releases rather than every version; it is bumped when
a release is worth citing, which is not the same as every time npm is published.

## What 1.0.0 means here

SemVer, with the contract stated in CHANGELOG.md: the CLI flags, exit codes,
environment variables, config schema, ledger event shapes, approval file mode
and artefact paths. A change to any of those is a major bump.

1.0.0 is a commitment to that contract, not a claim that the software is
finished. It says the ledger event shapes are worth depending on — which they
now are, because the VS Code extension and the platform both read them, and
because Paper I's figures are counted from them. Breaking them silently would
invalidate analysis already done.

Note what this makes expensive: `EVENT_KINDS` is part of the contract, so adding
`triage` in 1.0.0 was the right moment to do it. The next event kind is a major
bump or it is nothing.

## Checking what is actually published

```bash
# npm — what the registry has, and what this working tree claims
npm view attestqa version
node -p "require('./package.json').version"

# the built CLI — catches a stale dist/, which has bitten before
node dist/cli.js --version

# VS Code Marketplace
npx vsce show vijaypjavvadi.agentic-qa-vscode
node -p "require('./extension/package.json').version"

# tags — a tag must point at the commit that was published, not at today's HEAD
git tag -l 'v*' --sort=-v:refname | head -5
git rev-parse v1.0.0
git log --oneline -1 v1.0.0
```

## Release order, and why it is this order

1. `npm run typecheck && npm test && npm run lint` — all three, on a clean tree.
2. `npm run build`, then `node dist/cli.js --version`. A stale `dist/` has
   silently shipped old behaviour once: a build predating its source by thirteen
   minutes made a feature look absent when it was present.
3. `npm run fixture:make` if any ledger event shape changed, then re-run the
   tests. The golden fixture is generated, never hand-edited — a hand-inserted
   event passes the "covers every kind" check and fails the byte-for-byte one,
   which is the suite telling you the fixture is a record of what the loop does.
4. Bump `package.json`, write the CHANGELOG entry, commit.
5. `npm publish --access public`.
6. Tag **the published commit**: `git tag v1.0.0 <that sha>`, then push the tag.
   Tagging HEAD afterwards is how a tag and a release come to describe different
   code.
7. `gh release create v1.0.0` with notes from the CHANGELOG.
8. Extension: bump `extension/package.json`, `npm run package` in `extension/`,
   then `npx vsce publish`.
9. Update the table at the top of this file.

## Windows note

`cd` alone does not change drive on Windows. From an `E:` prompt,
`mkdir C:\tmp\x && cd C:\tmp\x` leaves the shell on `E:` and the next command
runs in the project — which is how `npm init -y` once overwrote this project's
`package.json`. Use `cd /d`.
