# Releasing

How to cut a version and publish it. Written so it can be followed without remembering anything.

`attestqa` is a **scoped** package, and `package.json` sets
`publishConfig.access: "public"` explicitly. Current npm defaults a _new_ package to public anyway,
so this line is belt-and-braces rather than load-bearing — it matters if a local `.npmrc`, an
organisation default, or a different registry says otherwise. (Scoped packages defaulting to
restricted was npm's behaviour years ago and is still widely repeated; it is not the current
default.)

---

## Before you start

You need to be logged in, once per machine:

```bash
npm login          # opens a browser; needs your authenticator
npm whoami         # should print your npm username
```

Your npm account must own or be a member of the `@vijaypjavvadi` scope. If `npm whoami` prints a
name but the publish later says **403 Forbidden**, that is a scope-ownership problem, not a
credential one.

---

## 1. Decide the version

Semantic versioning, with one project-specific rule: **anything in the contract surface is a MAJOR
bump.** That list is in [TECHNICAL.md](TECHNICAL.md) — event kinds and payload shapes, CLI flags,
exit codes, the config schema, the approval file format, artefact paths.

| change                                             | bump  |
| -------------------------------------------------- | ----- |
| a new event kind, or a changed payload shape       | MAJOR |
| a removed or renamed CLI flag; a changed exit code | MAJOR |
| a required config key                              | MAJOR |
| a new optional config key, a new skill, a new tool | MINOR |
| a new CLI flag with a default                      | MINOR |
| a bug fix, a doc change, a new test                | PATCH |

An _additive optional_ field on an existing payload — `limitations` on `verify`, say — is a MINOR.
It is worth being strict here: the platform and any future extension build against these shapes, and
a silent change is how you break someone at a distance.

```bash
npm version minor -m "release: v%s"     # bumps package.json, commits, tags
```

Do not hand-edit the version.

---

## 2. Check what will actually ship

```bash
npm run release:check
```

`npm pack --dry-run` prints the exact file list. Read it. You are looking for two things:

- **Everything needed is there** — `dist/`, the seven user-facing files under `docs/`, `README.md`,
  `CHANGELOG.md`, `LICENSE`, `CITATION.cff`, and `examples/fixture-ledger/` (the platform track
  builds against that fixture).
- **Nothing private is there** — no `.env`, no `.aqa/`, no `node_modules`, no `test/`, no
  `examples/sample-project/tests/`.
- **Nothing internal is there** — the `docs/HANDOFF_*.md` notes, `docs/tools-observed.*` and the HTML
  diagrams are working material, not documentation. They are excluded by name.

The `files` allow-list in `package.json` is what controls this. It lists the seven docs individually
rather than the whole `docs/` folder, precisely so that adding a working note to that folder does not
silently add it to the next release. If you add a doc that users should get, add it to the list too.

---

## 3. Prove it works from the tarball

This is the step worth not skipping. It catches the class of bug that only appears once the package
is installed rather than run from the repo: a missing file, a broken `bin` path, a dependency listed
as `dev` that the runtime actually needs.

```bash
npm pack                                  # writes vijaypjavvadi-agentic-qa-<version>.tgz

mkdir /tmp/aqa-check && cd /tmp/aqa-check       # Windows: cd /d C:\temp\aqa-check
npm init -y >/dev/null
npm install /path/to/vijaypjavvadi-agentic-qa-<version>.tgz

npx aqa --version                         # prints the version
npx aqa --help                            # prints usage
npx aqa replay node_modules/attestqa/examples/fixture-ledger
```

That last command renders the checked-in fixture ledger to Markdown using nothing but the installed
package — no network, no model, no Azure DevOps. If it prints a readable report, the package is
sound.

Then delete the scratch directory. Do not commit the `.tgz`.

**On Windows, `cd` alone will not leave the current drive.** `cd C:\temp\aqa-check` from an `E:`
prompt creates nothing and moves nowhere visible — and the `npm init -y` that follows then rewrites
the project's own `package.json`. Use `cd /d`, and check `git status` if you suspect it happened.

---

## 4. Publish

```bash
npm publish
```

`prepublishOnly` runs `typecheck && test && lint && build` first, so a broken tree cannot go out.
That is deliberate friction — an npm version, once published, cannot be replaced, only deprecated.

Verify:

```bash
npm view attestqa version
npm view attestqa
```

---

## 5. Push the tag and cut a GitHub release

```bash
git push && git push --tags
gh release create v<version> --title "v<version>" --notes-file <(sed -n '/## \[<version>\]/,/## \[/p' CHANGELOG.md)
```

Or paste the notes by hand from the CHANGELOG. Keep the release notes and the CHANGELOG section
identical — two versions of the same story diverge immediately.

**Releases are not cosmetic here.** JOSS's 2026 policy counts releases, public issues and pull
requests as evidence that a project is a real, sustained effort rather than a code dump. Each one is
part of the record.

---

## If something goes wrong

| symptom                                         | cause                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `402 Payment Required`                          | the package resolved to restricted — check `publishConfig.access`, `.npmrc`, and any org default |
| `403 Forbidden`                                 | your npm account does not own the `@vijaypjavvadi` scope                                         |
| `EPUBLISHCONFLICT` / "cannot publish over"      | that version already exists; bump and try again                                                  |
| `aqa: command not found` after a global install | the `bin` path in `package.json` does not match the built file                                   |
| the CLI installs but does nothing               | `dist/cli.js` did not get its shebang, or the entry guard did not match `argv[1]`                |

**A published version cannot be unpublished** after 72 hours, and even inside that window
unpublishing a package others may depend on is bad manners. If a release is broken, publish a fixed
PATCH and `npm deprecate` the bad one:

```bash
npm deprecate attestqa@0.1.0 "broken build; use 0.1.1"
```

---

## Product releases and the VS Code extension

From v1.0.0 a **product release** (tag `vX.Y.Z`, ADR-002) ships the engine and the extension
together, from CI. The engine keeps its own version (`attestqa` 2.0.0 in v1.0.0); the extension's
version equals the product release (`attestqa-vscode` 1.0.0), and the release workflow refuses a tag
that does not match it.

**Once, before the first release:**

1. An npm automation token for the account that owns `attestqa`, saved as the repository secret
   `NPM_TOKEN`.
2. A Marketplace token: in Azure DevOps (any organisation), _User settings → Personal access
   tokens_, scope **Marketplace → Manage**, organisation **All accessible organizations**. Save it as
   the secret `VSCE_PAT`. The publisher `vijaypjavvadi` already exists (bdd2pw, sel2pw,
   usagecontract are published under it).

Both secrets were added on 16 Oct 2026. The Marketplace token expires on **30 Nov 2026**:
Azure DevOps stops accepting tokens scoped to all organisations on 1 Dec 2026, so a longer
expiry would not help. An extension release after that needs `vsce publish --azure-credential`
(Microsoft Entra sign-in from the workflow, through workload identity federation) instead of
`VSCE_PAT`; change `release.yml` before the first post-1.0.0 extension release.

The extension uses GitHub Copilot's models through VS Code's Language Model API, so before each
Marketplace release check it still follows GitHub's *Copilot extensibility acceptable development
and use policy*, which VS Code's guide names as a condition of publishing such an extension.

**Each release:**

```
[ ] npx changeset version                 — bumps attestqa from the changesets, writes CHANGELOG
[ ] packages/vscode/package.json version  — set to the product version; CHANGELOG section added
[ ] RELEASE_NOTES.md                      — this release's notes
[ ] commit, push, and run the "release" workflow with dry_run — it must be green
[ ] code --install-extension packages/vscode/attestqa-vscode-<v>.vsix   (from the dry run's artifact) and run one story
[ ] git tag vX.Y.Z && git push --tags     — CI publishes npm, Marketplace and the GitHub release
[ ] npm view attestqa version; the Marketplace page shows the new version
```

The workflow skips the npm publish when that engine version is already on npm, so a product release
that changes only the extension republishes nothing else.

## Checklist

```
[ ] CHANGELOG has a section for this version
[ ] npm version <major|minor|patch>
[ ] npm run release:check       — file list is right
[ ] npm pack + install into a clean dir + aqa replay works
[ ] npm publish
[ ] npm view … version          — matches
[ ] git push && git push --tags
[ ] gh release create
```
