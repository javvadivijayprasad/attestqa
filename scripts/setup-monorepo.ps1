# attestqa — create the monorepo (RUNBOOK step C). Run in PowerShell on Windows.
# Stops at the first error. Safe to read before running: it only touches
# E:\EB1A_Research\Application\attestqa and reads the agentic-qa repository.
$ErrorActionPreference = "Stop"
$Mono = "E:\EB1A_Research\Application\attestqa"
$Old  = "E:\EB1A_Research\EB1_Master\06_Authorship\Paper_I_AgenticQA\Experiment\agentic-qa"
$Ref  = "attestqa@1.1.0"

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Step "Checking the agentic-qa repository is committed and tagged $Ref"
Set-Location $Old
if (git status --porcelain) { throw "agentic-qa has uncommitted changes. Finish RUNBOOK step A first." }
git --no-pager rev-parse --verify "refs/tags/$Ref" | Out-Null

Step "Creating the monorepo repository"
Set-Location $Mono
if (Test-Path .git) { throw "$Mono already has a .git folder. Stop and check before re-running." }

Step "Placing GitHub workflow and issue templates (kept in scripts\github because remote tools may not write .github)"
New-Item -ItemType Directory -Force .github | Out-Null
Copy-Item -Recurse -Force scripts\github\* .github\
git init -b main
git add -A
git --no-pager status --short | Select-Object -First 40
git commit -m "attestqa monorepo: approved design set (AQ-00..AQ-09), research log, root scaffold"

Step "Importing the agentic-qa history into packages/core (git subtree, full history)"
git subtree add --prefix=packages/core $Old $Ref -m "Import agentic-qa history into packages/core at $Ref"

Step "Checking that the Paper I commits still resolve"
git --no-pager log -1 --format="%h %s" f2771d4
git --no-pager log -1 --format="%h %s" corpus-2026-10-07 2>$null
if ($LASTEXITCODE -ne 0) { git fetch $Old "refs/tags/*:refs/tags/*"; git --no-pager log -1 --format="%h %s" corpus-2026-10-07 }

Step "Installing workspace dependencies (creates package-lock.json)"
npm install
git add package-lock.json
git commit -m "Workspace lockfile"

Step "Running the core test suite from the monorepo"
npm test --workspace packages/core

Write-Host "`nDone. Next: RUNBOOK step D (push to GitHub)." -ForegroundColor Green
