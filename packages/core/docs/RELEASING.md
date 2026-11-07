# Releasing

One version number, one workflow, one tag — on a release branch, merged to `main` after it ships.
Written so it can be followed without remembering anything.

A release is the tag `vX.Y.Z`. It ships `attestqa` to npm, `attestqa-vscode` to the VS Code
Marketplace and a GitHub release (which Zenodo archives), all from `.github/workflows/release.yml`.
The tag, `packages/core/package.json` and `packages/vscode/package.json` must carry the same number
(ADR-005); the workflow refuses a tag that does not match both. Both bump together — the two packages
are `fixed` in `.changeset/config.json`, so `changeset version` sets both from the changesets.

What is currently published, and what each bump means, is in [VERSIONS.md](VERSIONS.md) — the single
version-of-record.

## The branch model (ADR-006)

```
main ──●─────────────────────────────────────●──   always the last released, stable state
        \                                    /
         release/X.Y.Z ──●────●────●────────●       the next version; integration branch
                          \   /\   /
                           feat/… fix/…               one branch per feature or bug fix
```

- **`main`** is the last released version. Protected; nothing is pushed to it directly.
- **`release/X.Y.Z`** is cut from `main` and is where the next version is built. Protected (the same
  required checks as `main`); pushing to it runs `check` on Windows and Ubuntu.
- **`feat/<name>` / `fix/<name>`** are cut from the release branch, one per change, and merged back
  into it by PR once green. Record the change as a changeset (`npx changeset`) on the branch.
- When the release branch is green and holds everything the version should have, **release from it**
  (below): tag, publish, verify.
- **After** the publish succeeds, open a PR **release → `main`** and merge it, so `main` becomes the
  released state. Then cut the next `release/X.Y+1.0` from `main`.

## Releasing from the release branch

From the repository root (`E:\EB1A_Research\Application\attestqa`), on `release/X.Y.Z`:

```
npm run preflight                      1. exactly what CI checks: format, lint, typecheck, build, test
npm run version-packages               2. one command: `changeset version` bumps BOTH packages and
                                          writes the CHANGELOGs, then stamps CITATION.cff version +
                                          date. Nothing is edited by hand.
# add by name, never `git add -A` (screenshots and local workspaces sit beside the package):
git add packages/core/package.json packages/core/CHANGELOG.md \
        packages/vscode/package.json packages/vscode/CHANGELOG.md \
        CITATION.cff .changeset
git commit -m "release: attestqa X.Y.Z"
git push                               3. CI runs the checks on the release branch (Windows + Ubuntu)
git tag vX.Y.Z && git push origin vX.Y.Z   4. only after step 3 is green: CI publishes npm,
                                          Marketplace, GitHub release
```

The GitHub release body is this version's own section of `packages/core/CHANGELOG.md`, taken by the
workflow — there is no hand-written release-notes file.

Then: `npm view attestqa version`, the Marketplace page shows the new version, the GitHub release
exists, and Zenodo has minted a DOI for it. **The one by-hand step left:** add that version DOI to
`CITATION.cff` under `identifiers` (the concept DOI and the README badge never change — the concept
DOI resolves to the latest version). Finally, open the PR **release → `main`** and merge.

## Rules that save a release

- **Run `preflight` before every commit you intend to release.** It is the same list CI runs, in the
  same order. If it is green here it is green there. In particular `format:check` is part of it: the
  code must be formatted with the package's own Prettier (`npm run format` at the root). Do not run a
  bare `npx prettier` — the root resolves an older Prettier 2 pulled in by another dependency, and it
  formats differently.
- **A tag is only pushed after the commit it points at is green** on the release branch. If the tag
  has to move, delete it on both sides first: `git tag -d vX.Y.Z; git push origin :refs/tags/vX.Y.Z`.
- **Re-running a failed release is always safe.** Every publish step checks first and skips if that
  version is already out ("already on npm - skipping", and the same for the Marketplace and the
  GitHub release). So when a run fails at step N, fix the cause and *Re-run failed jobs*; steps
  before N do not repeat their side effects.
- **A published npm version cannot be replaced.** If a release is broken, publish a fixed PATCH and
  `npm deprecate attestqa@X.Y.Z "broken; use X.Y.Z+1"`.
- `npm version` and hand-edited version fields are not used; `npm run version-packages` is.

## Credentials (set once, never in the repo)

- **npm: trusted publishing, no token.** On npmjs.com, package `attestqa` → Settings → Trusted
  Publisher → GitHub Actions: owner `javvadivijayprasad`, repository `attestqa`, workflow
  `release.yml`, environment blank. The workflow then publishes through OIDC with provenance. No
  `NPM_TOKEN` secret, no one-time password. (A token that needs a one-time password cannot publish
  from CI: that was the EOTP failure of 3 Nov 2026.)
- **Marketplace: trusted publishing, no token.** On marketplace.visualstudio.com/manage, publisher
  `vijaypjavvadi` (owner account vijay@vijayjavvadiresearch.ai) → *Trusted Publishing* → Create:
  GitHub owner `javvadivijayprasad`, repository `attestqa`, workflow `release.yml`. The workflow
  runs `vsce publish --oidc` (vsce 4.1+), which exchanges the job's GitHub OIDC token for a
  short-lived Marketplace credential. No `VSCE_PAT`, and the 1 Dec 2026 retirement of
  all-organisations PATs does not apply. (The PAT route failed on 3 Nov 2026 with "Access Denied …
  /vijaypjavvadi/attestqa-vscode" because the token had been made under a different Microsoft
  account than the publisher owner.)
- **GitHub release:** the workflow's own token; nothing to set.

If a publish step fails on credentials, the manual fallback is the same command from the package
folder (`npm publish --access public` in `packages/core` with your own login; `npx @vscode/vsce
publish --no-dependencies` in `packages/vscode` after `npx @vscode/vsce login vijaypjavvadi` with a
PAT of the owner account, scope Marketplace → Manage), then *Re-run failed jobs* so the remaining
steps complete.

## The plug-in packages (`@attestqa/*`)

The provider and sign-in plug-ins — `@attestqa/provider-bedrock`, `@attestqa/auth-aws`,
`@attestqa/auth-azure` — ship from the same workflow but **version independently** of the engine:
they are not in the `fixed` set in `.changeset/config.json`, so `changeset version` bumps each only
when a changeset names it, and the tag-match check ignores them. The *Plug-in packages* steps in
`release.yml` publish each one idempotently (skip if that version is already on npm), so a release
only ships the ones whose version moved.

Two one-time steps per **new** package, before its first release:

1. **First publish by hand.** npm trusted publishing cannot be configured for a name that does not
   exist yet, so create it once from the package folder with your own npm login:
   `cd packages/<pkg> && npm publish --access public`.
2. **Then add its Trusted Publisher** on npmjs.com (package `@attestqa/<pkg>` → Settings → Trusted
   Publisher → GitHub Actions: owner `javvadivijayprasad`, repository `attestqa`, workflow
   `release.yml`).

After that, CI publishes every later version through OIDC, exactly like the engine — no token.

## Version bumps

Semantic versioning, with one project rule: anything in the contract surface
([TECHNICAL.md](TECHNICAL.md) — event kinds and payloads, CLI flags, exit codes, config schema,
approval file format, artefact paths) is a MAJOR. A new optional key, skill, tool or flag with a
default is a MINOR. Fixes, docs and tests are a PATCH. Record each change as a changeset
(`npx changeset`) on its feature branch when it is made, not at release time.

## Before the first Marketplace release of a version

The extension uses GitHub Copilot's models through VS Code's Language Model API; check it still
follows GitHub's *Copilot extensibility acceptable development and use policy*, which VS Code's
publishing guide names as a condition.
