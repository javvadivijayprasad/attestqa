---
"attestqa": minor
---

Seed data for the application. A new command, `aqa seed --schema <schema.sql>`, turns the project's `CREATE TABLE` statements into rows for every table and writes them into a folder in the workspace: one CSV per table, and on request an INSERT script, a Postgres or MySQL script, or a SQLite file, with a `seed.json` recording what was made. It runs the synthdata CLI set as `SYNTHDATA_CLI` in its `auto` mode, so no model is called and the same seed gives the same rows. The command only writes files: loading them into an application or a database stays a step of the project. It is separate from `aqa run` and does nothing unless `SYNTHDATA_CLI` is set.
