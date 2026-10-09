# Starting the v1.0.0 cycle — what Vijay runs

Git and publishing are run by you on Windows. Each step says how to check it worked. Use `git --no-pager` so git does not open a pager.

## A. Release the engine as attestqa 1.1.0 from the old repository

In PowerShell:

    cd E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa
    npm test
    npm run build
    git add -A
    git commit -m "attestqa 1.1.0: renamed from agentic-qa; model provider seam (anthropic, openai, azure-openai, local)"
    git tag attestqa@1.1.0
    git push origin main --tags
    npm publish --access public

Check: `npm view attestqa version` prints 1.1.0.

The tag is `attestqa@1.1.0`, not `v1.1.0`, on purpose: `v1.x.y` tags are reserved for product releases (v1.0.0 on 15 November), and the engine keeps its own version line (decision D22, ADR-002).

Then the compatibility shim and the deprecation:

    cd ..\agentic-qa-shim
    npm publish --access public
    npm deprecate @vijaypjavvadi/agentic-qa@"<1.1.0" "Renamed to attestqa. Install attestqa instead."

Check: `npm view @vijaypjavvadi/agentic-qa version` prints 1.1.0, and installing an old version shows the deprecation message.

If `npm test` fails, stop and send me the output. Nothing is published until it passes.

## B. Rename the GitHub repository (decision D3)

In the browser: github.com/javvadivijayprasad/agentic-qa → Settings → Repository name → `attestqa` → Rename. GitHub keeps redirecting the old URL, and the Zenodo concept DOI keeps resolving.

Then point the old local copy at the new name:

    cd E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa
    git remote set-url origin https://github.com/javvadivijayprasad/attestqa.git

## C. Create the monorepo

    powershell -ExecutionPolicy Bypass -File E:\EB1A_Research\Application\attestqa\scripts\setup-monorepo.ps1

It checks step A is done, creates the repository, imports the agentic-qa history into `packages\core` with its full history, confirms `f2771d4` still resolves, installs dependencies and runs the core tests. It stops at the first error.

## D. Push the monorepo to GitHub

    cd E:\EB1A_Research\Application\attestqa
    git remote add origin https://github.com/javvadivijayprasad/attestqa.git
    git fetch origin
    git merge-base --is-ancestor origin/main main; if ($LASTEXITCODE -eq 0) { "fast-forward: safe to push" } else { "STOP: not a fast-forward" }
    git push origin main

It is a fast-forward because the monorepo contains the old history as an ancestor, so nothing on GitHub is rewritten. If the check prints STOP, do not push; send me the output.

## E. After pushing

- Repository settings: protect `main` (require the `ci` check), turn on Dependabot, CodeQL and secret scanning with push protection, and enable Discussions (AQ-09 §5).
- Check the `ci` workflow ran green on both Windows and Linux.
- Tell me, and I will log the step in the journal and start the engine 2.0 work.
