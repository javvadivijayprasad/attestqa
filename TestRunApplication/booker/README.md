# Restful-Booker Platform — attestqa evaluation workspace

Restful-Booker Platform (mwinteringham/restful-booker-platform), run locally.

Backlog: `research/EVALUATION_PLAN.md` §4. Config: `packages/core/examples/eval/booker.config.yaml`.

## Start the application

```
git clone https://github.com/mwinteringham/restful-booker-platform
cd restful-booker-platform
docker compose up -d     # check the repo's docker-compose.yml on the day
# guest site and /admin at http://localhost:3003; confirm how data resets between runs
```

## This workspace

```
npm install
npx playwright test          # runs whatever attestqa has written so far
```

The test account is admin (published default). It goes in `packages/core/.env.booker` (git-ignored; template
`packages/core/examples/eval/env.booker.example`) as `AQA_APP_USER` / `AQA_APP_PASS`, never in a file here.

## A run

```
cd packages/core
node dist/cli.js run "Write tests for <story>" --config examples/eval/booker.config.yaml \
  --workspace ../../TestRunApplication/booker --env .env.booker,.env
```

Stories run in the `order` given in the seed file; later stories in an epic add to its feature and spec.
