# Toolshop — attestqa evaluation workspace

Practice Software Testing "Toolshop" (testsmith-io/practice-software-testing), run locally with Docker.

Backlog: `research/EVALUATION_PLAN.md` §4. Config: `packages/core/examples/eval/toolshop.config.yaml`.

## Start the application

```
git clone https://github.com/testsmith-io/practice-software-testing
cd practice-software-testing
# .env: SPRINT=sprint5 for authoring and evaluation; sprint5-with-bugs only for seeded-fault runs
docker compose -f docker-compose.yml up -d
docker exec -it pst-laravel-api-1 php artisan migrate:fresh --seed   # also the reset between runs
```

## This workspace

```
npm install
npx playwright test          # runs whatever attestqa has written so far
```

The test account is customer@practicesoftwaretesting.com, or admin@practicesoftwaretesting.com for the admin story (published defaults). It goes in `packages/core/.env.toolshop` (git-ignored; template
`packages/core/examples/eval/env.toolshop.example`) as `AQA_APP_USER` / `AQA_APP_PASS`, never in a file here.

## A run

```
cd packages/core
node dist/cli.js run "Write tests for <story>" --config examples/eval/toolshop.config.yaml \
  --workspace ../../TestRunApplication/toolshop --env .env.toolshop,.env
```

Stories run in the `order` given in the seed file; later stories in an epic add to its feature and spec.
