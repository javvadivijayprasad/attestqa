# SauceDemo — attestqa evaluation workspace

SauceDemo, a hosted practice site. Nothing to run; one worker and the default delay (targets.yaml).

Backlog: `research/EVALUATION_PLAN.md` §4. Config: `packages/core/examples/eval/saucedemo.config.yaml`.

## Start the application

```
# nothing to start: https://www.saucedemo.com
# the two ui-change stories need a local build of saucelabs/sample-app-web for their second pass
```

## This workspace

```
npm install
npx playwright test          # runs whatever attestqa has written so far
```

The test account is the demo users listed on the site's own login page. It goes in `packages/core/.env.saucedemo` (git-ignored; template
`packages/core/examples/eval/env.saucedemo.example`) as `AQA_APP_USER` / `AQA_APP_PASS`, never in a file here.

## A run

```
cd packages/core
node dist/cli.js run "Write tests for <story>" --config examples/eval/saucedemo.config.yaml \
  --workspace ../../TestRunApplication/saucedemo --env .env.saucedemo,.env
```

Stories run in the `order` given in the seed file; later stories in an epic add to its feature and spec.
