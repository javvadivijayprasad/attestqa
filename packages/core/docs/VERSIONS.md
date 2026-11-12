# Versions

The runtime, the extension and the archive ship from this repository on one version line
(ADR-005); the `@attestqa/*` plug-ins ship from it too and are versioned independently.
This file is the single place that says what is released where, because the
answer has been wrong twice already — once when `aqa --version` printed a
hardcoded `0.1.0-dev.0` that a substring assertion had been happily matching,
and once when a git tag was moved to a commit npm had never seen.

Check this table against reality before every release, with the commands below.

## Current

| Artefact | Name | Version | Published | Source |
| --- | --- | --- | --- | --- |
| Runtime | `attestqa` | **2.2.0** (on npm 10 Nov 2026) | npm | `packages/core/package.json` |
| Extension | `attestqa-vscode` | **2.2.0** (on the Marketplace 10 Nov 2026) | VS Code Marketplace | `packages/vscode/package.json` |
| Plug-ins | `@attestqa/provider-bedrock`, `@attestqa/auth-aws`, `@attestqa/auth-azure` | **0.1.0** each (on npm 10 Nov 2026); versioned independently | npm | `packages/<plug-in>/package.json` |
| Archive | `attestqa` | every release; cite the concept DOI (see `CITATION.cff`) | Zenodo (GitHub release integration) | `CITATION.cff` |

The next version is built on `release/2.3.0` (ADR-006); nothing is published until its tag. The
forward plan is in [ROADMAP.md](../../../ROADMAP.md).

One version line (ADR-005, 3 Nov 2026): the product release tag, the runtime and the extension carry the
same number. They are not technically coupled — the extension reads ledgers the runtime writes — but two
numbers that drift apart make "which version are you on?" a two-part question for no benefit.

The Zenodo archive is created automatically for every GitHub release (the integration is on), so every
release is citable. `CITATION.cff` carries the *concept* DOI, which always resolves to the latest
version, so only `version` and `date-released` change per release (`packages/core/CITATION.cff` is
the copy that ships in the npm package and must say the same). A paper that needs a fixed version
cites that version's own DOI from its Zenodo page (2.0.1: 10.5281/zenodo.23897787, cited by the
SoftwareX article; 2.0.2: 10.5281/zenodo.23932981; 2.1.0: 10.5281/zenodo.23979481; 2.2.0: 10.5281/zenodo.24116301).

## What 2.0.x means here

SemVer, with the contract stated in CHANGELOG.md: the CLI flags, exit codes,
environment variables, config schema, ledger event shapes, approval file mode
and artefact paths. A change to any of those is a major bump.

2.0.0 was a commitment to that contract, not a claim that the software is
finished. It says the ledger event shapes are worth depending on — which they
now are, because the VS Code extension and the platform both read them, and
because Paper I's figures are counted from them. Breaking them silently would
invalidate analysis already done.

Note what this makes expensive: `EVENT_KINDS` is part of the contract, so adding
`triage` in 2.0.0 was the right moment to do it. The next event kind is a major
bump or it is nothing.

## Checking what is actually published

```bash
# npm — what the registry has, and what this working tree claims
npm view attestqa version
node -p "require('./package.json').version"

# the built CLI — catches a stale dist/, which has bitten before
node dist/cli.js --version

# VS Code Marketplace
npx vsce show vijaypjavvadi.attestqa-vscode
node -p "require('./packages/vscode/package.json').version"

# tags — a tag must point at the commit that was published, not at today's HEAD
git tag -l 'v*' --sort=-v:refname | head -5
git rev-parse v2.0.2
git log --oneline -1 v2.0.2
```

## Release order

The release runbook is [RELEASING.md](RELEASING.md): one tag, one token-free workflow
(`npm run preflight` → `changeset version` → commit → tag `vX.Y.Z` → CI publishes npm, the VS Code
Marketplace and the GitHub release, which Zenodo archives). This file is only the version-of-record;
it does not restate the steps. After a release, update the table at the top of this file and put the
new Zenodo DOI into `CITATION.cff`.

## Windows note

`cd` alone does not change drive on Windows. From an `E:` prompt,
`mkdir C:\tmp\x && cd C:\tmp\x` leaves the shell on `E:` and the next command
runs in the project — which is how `npm init -y` once overwrote this project's
`package.json`. Use `cd /d`.
