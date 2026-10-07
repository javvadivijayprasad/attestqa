# Changelog

All notable changes to this project will be documented in this file. Format: Keep a Changelog;
versioning: SemVer. Any change to the contract (PLAN §0: CLI flags, exit codes, env vars,
config schema, ledger event shapes, approval file mode, artefact paths) is a MAJOR bump.

## [Unreleased]

## [1.0.0] - 2026-09-18

First version under the stated contract. `EVENT_KINDS`, the ledger event shapes,
the CLI flags, the exit codes and the artefact paths are now things to depend on,
because the VS Code extension and the platform read them and Paper I's figures
are counted from them. Adding an event kind after this is a major bump.

### Added — failure triage

- **`src/triage/`: what kind of red this was.** A run that goes red gets its
  failures classified before anything decides what to do about them. Five
  categories, ported from `defect_analysis/engine/classifier.py`:
  `infrastructure`, `environmental`, `flake`, `real-defect`, `expected-failure`.
- **The port is a mirror, not a rewrite.** Each pattern keeps its Python source
  text and is compiled at load, so divergence between the two implementations is
  a string comparison rather than behaviour nobody noticed changing. The
  algorithm is scored, not first-match: each bank scores as the fraction of its
  patterns that matched, and the precedence order only breaks ties. A
  reimplementation that walked the precedence list would have been a different
  classifier wearing the same category names.
- **Contagion.** `environmental` and `infrastructure` invalidate every other
  result in the run: if the application was not serving, nothing was measured,
  and a `real-defect` verdict elsewhere in that run is not evidence of anything.
  The other three categories say something about one test and nothing about any
  other. This distinction is agentic-qa's, not the service's — a dashboard never
  has to decide what a verdict implies about its neighbours; a loop does.
- **Contagion requires evidence.** A failure over a minute long with no
  recognisable error reaches `infrastructure` on the duration boost alone. That
  is faithful to the Python and harmless there. Here it would write off a whole
  run, so the run-level verdict additionally requires that a pattern actually
  matched. A stopwatch is not grounds for the strongest claim triage can make.
- **Quarantine.** A test triaged `real-defect` may not be edited, and the rule is
  enforced by a check rather than an instruction: the failing test and its exact
  error are recorded, and a later attempt where it no longer fails the same way
  raises `quarantined-test-modified`. "It passes now" and "the assertion was
  relaxed" look identical from inside the run, and only one of them is good news.
- **The suite always runs to completion.** Triage never stops execution; what it
  can stop is the agent's edit-and-rerun loop. Twenty-nine other results cost
  nothing extra to collect and are worth having.
- **New gaps:** `sut-unavailable`, `harness-unusable`, `product-defect-suspected`
  (one per candidate), `quarantined-test-modified`. `suite-not-green` is
  suppressed when triage produced a more specific gap — it restates the exit code
  where the others name the fix.

### Changed — what running the real reporter showed

The unit tests above used Playwright JSON that I wrote by hand. Running the
actual reporter against a deliberately broken suite produced three verdicts and
all three were wrong, for reasons no synthetic fixture would have contained.

- **ANSI colour codes.** Playwright writes assertion diffs coloured, so a real
  `toBe` failure arrives as `Error: \u001b[2mexpect(\u001b[22m...`. The escape
  sequences sit between the words the patterns look for, and the evidence string
  a human reads came out as garbage. Messages and stacks are now stripped before
  matching.

- **The retry boost fired on every failure.** classifier.py nudges toward
  `flake` when `retries > 0`, and its comment says it means "retries WITH A
  SUBSEQUENT PASS HISTORY" — but the code only checks the count. Under
  Playwright, `retries: 1` in the config makes every failing spec report one
  retry regardless: the real report showed `results: failed,failed` on all three
  failures. At +0.25 that boost outscores most pattern banks, so a plain
  `connect ECONNREFUSED` — an outage, the most consequential verdict there is —
  came back classified `flake`. Worse, the count carries the opposite evidence
  to the one claimed: a test retried that failed again is *less* likely to be a
  flake, and a test that is flaky by Playwright's own definition never reaches
  this code at all, because its spec is `ok: true`. `FailureSignal.flakyHistory`
  now makes the Python's stated condition explicit. **Documented deviation.**

- **The ported banks barely match Playwright.** They were tuned on Defects4J and
  BugsInPy — Java and Python phrasing. Playwright says `Timeout 5000ms exceeded`
  where the ported flake patterns want `timed out after 5000 ms` or `wait for`;
  it says `expect(received).toBe(expected)` where the real-defect bank wants
  `AssertionError`. A textbook flake and a clean assertion failure both scored
  zero. `PW_BANKS` adds Playwright-native patterns as a **separate** bank, scored
  independently with the higher score winning — appending to the ported lists
  would have changed every ported score, since scoring is a fraction of bank
  size, and made the two implementations disagree by arithmetic rather than by
  judgement. **Documented deviation.**

- **Evidence is the failure's own words.** It was the matched pattern fragments,
  which on a real failure read `expect(received). · Object.is equality ·
  expect(received).toBe` — three pieces of one sentence, none of them the useful
  part, while the message itself said `Expected: 90` and `Received: 100`. That
  string is what gets quoted into a bug report. Which patterns matched is still
  recorded in `matchedPatterns`, where a machine can find it.

Six regression tests now carry real reporter bytes.

### Fixed — triage ran too late to stop anything

The first implementation put triage inside the verifier. The verifier only runs
when the model declares the goal reached — so on a run where the model keeps
repairing, it never runs at all.

Observed on run `20260918T154354Z-1f5d7538` against a live Juice Shop: 33
inferences, four `pw.run_tests`, fifteen rewrites of one spec, **zero triage
events**. The suite reported `4 passed, 1 failed` identically all four times
while the agent rewrote the spec around the one failure. That is exactly the
scenario triage exists for, and triage was structurally unable to see it. A stop
rule that can only speak after the loop has ended is not a stop rule, and the
claim that this turns a 76-inference run into ~10 was false as shipped.

- Triage now runs **after every cycle**, from the loop, not from the verifier.
- `TriagePayload.reportFingerprint` (contract, additive) — a content hash of the
  execution report. Re-triaging an unchanged report is a no-op, so a per-cycle
  call cannot flood the ledger, inflate `attempt`, or make the quarantine check
  compare a report against itself. The loop therefore needs no knowledge of
  which tool produces a report or when.
- `triageAction()` gives the loop a decision in terms it can act on without
  knowing anything about defects: **stop** when nothing was measured; **stop**
  when every remaining failure is a product defect or a known failure, since the
  only route to green from there is to damage the evidence; otherwise **carry
  on**, with the quarantined tests named in the next context.
- `ScriptedVerifier`'s triage script no longer repeats its last entry — past the
  end it returns `undefined`, mirroring an unchanged report.

On the observed run this would have stopped at the second `pw.run_tests`:
roughly 12 inferences instead of 33, with the failing test named as a defect
candidate instead of rewritten fifteen times.

### Fixed — the execution report was written once and never again

`PwTools` persisted `.aqa-report/playwright.json` only when no file was already
there, guarded with `!existsSync(reportAbs)`. The first run a workspace ever did
froze the file; every run after it left the stale copy in place. In
`examples/sandbox` a report from 14 September saying "5 passed, 0 failed" was
still on disk on 18 September while the live suite reported 4 passed, 1 failed —
so triage read a green report, correctly found no failures, and said nothing,
across three suite runs. The comment above that line claimed the write made the
run's raw evidence "as durable as its conclusions"; it made it permanently wrong.

Now always overwrites: that file is the current call's evidence, and anything
already there belongs to a run that is over.

The failure mode is the dangerous kind — not a crash, but silence that reads as
agreement — so the verifier now catches the whole class. `failures-not-triaged`
fires when the suite reports failing tests and triage classified none, whatever
the reason: missing report, stale report, unreadable report. The verifier is the
only place that sees both the suite's own count and what triage made of it.

### Added — a failure that reproduces is not a flake

`flake` means one thing: it would pass if you ran it again. A failure that comes
back with identical evidence after the agent edited the spec and re-ran has
falsified that claim by the definition of the word. No pattern bank can see
this — every bank reads one message in isolation — and neither can the service,
which classifies one failure at a time with no memory of the previous attempt.
Only the run's own history has it.

`applyRepetition()` re-classifies a repeated `flake` as `real-defect` at LOW
confidence. That is not a claim that the product is broken; it is a claim that
the failure has stopped being the agent's to fix by guessing. Quarantine stops
the rewriting, the failure becomes a defect candidate, and a person decides
whether the product or the test is wrong — the decision that actually needs a
human, with bug filing gated on their answer.

Related, and deliberately NOT "fixed": the real-defect pattern
`to(Be|Equal|Contain|Match)\b` does not match `toBeVisible`, `toBeEnabled` or
the rest of Playwright's waiting-assertion family. Widening it was the obvious
move and would have been wrong — `expect(locator).toBeVisible()` timing out means
either the product never rendered the element or the test is looking for the
wrong one, and no regular expression can tell which. That ambiguity is settled by
repetition, not by a pattern. The boundary now carries a comment saying so, since
it reads like an oversight.

### Measured — run 20260918T161031Z-b0686ec0, live Juice Shop

The first end-to-end run with triage working:

| | before triage | with triage |
| --- | --- | --- |
| inferences | 33 | **19** |
| suite runs | 4 | 2 |
| rewrites of the spec | 15 | **1** |
| outcome | budget spent, nothing concluded | `blocked`, one defect candidate named |

The progression is the designed one, and it happened without being scripted:

1. Suite red: 4 passed, 1 failed on AC-1.
2. Triage #1 — `flake` at 0.167 on `expect(locator).toBeVisible() failed`.
   Ambiguous on sight, so the agent is allowed one repair attempt.
3. The agent investigates the live page with the browser tools and rewrites the
   spec once.
4. Suite still 4/1, but the failure has changed shape, so the report fingerprint
   changes and triage runs again.
5. Triage #2 — `real-defect` at 0.4 on
   `expect(page).not.toHaveURL(...) Expected pattern: not /#\/login/`.
   Quarantined, run stops, candidate reported.

### Added — defect candidates become proposed bugs, on approval only

The rule is the operator's: **any Playwright or environment failure is re-run once; if
it fails again it is real, and the user is asked whether to create a defect; if they say
no, it ends there.**

- **Triage no longer ends a run.** Its first verdict in a run is never acted on: it asks
  for one clean re-run of the suite, unchanged, and forbids editing a spec, selector,
  timeout or config value first — an edit makes the two runs incomparable and destroys
  the only evidence separating a flake from a defect. This replaced an immediate stop on
  `environmental`/`infrastructure`, which decided on the operator's behalf that an
  unreachable application could never be worth filing. That is a judgement about the
  product and it belongs to a person.
- **A failure that survives the retry becomes a proposed Bug.**
  `ado.wit_work_item_write` action `create`, `workItemType` "Bug", classified
  `write_record` → the gate asks. Deny is final: the instructions forbid rewording it,
  retrying it, or opening it as another work item type.
- **New governance capability: `ActionDescriptor.requireArgIn`.** Confines an action to
  named argument values — here `workItemType ∈ {Bug}`. A disallowed value is REFUSED,
  not raised to `ask`: a reviewer approving something the manifest never meant to permit
  is answering the wrong question, and their yes would be indistinguishable from a yes to
  the intended case. `update`, `update_batch` and `add_child` stay unlisted, so the agent
  still cannot edit fields on an existing work item — acceptance criteria remain a
  human's to write.
- **Bugs must say what was RULED OUT.** Not what the agent saw — what it checked that
  would have made this *not* a defect, and what that check said. Confidence follows from
  that paragraph; no named check means "nothing ruled out" and low confidence.
  Prompted by a real proposal that claimed "Confidence: High that this is a product
  defect" while its own repro steps opened "Enter a REGISTERED user's email" — a
  precondition asserted and never tested. A 200 from the login endpoint makes it a
  defect; a 401 makes it a fixture problem and no bug at all, and the two are
  indistinguishable from outside.

**The unchanged retry is instructed, not enforced — deliberately.** Nothing in the gate
stops the agent editing a spec between the failed run and the retry. Decided against on
2026-09-18: the instruction held on the first real run (`20260918T170400Z-4683360d` made
two `pw.run_tests` calls with no `fs.write_file` between them), and enforcement would
cost a gate rule guarding a case that has not happened. The quarantine check still
catches the specific harm. Revisit if a run is observed editing before its retry.

### Measured — run 20260918T170400Z-4683360d, live Juice Shop, deny path

| | this morning | now |
| --- | --- | --- |
| inferences | 33 | **15** |
| suite runs | 4 | 2 (one is the mandatory retry) |
| rewrites of the spec | 15 | **0** |
| test cases | 0 | 4, and **not** re-created on the second run |

The agent re-ran the suite with nothing edited between the two runs, proposed one bug,
had it denied, and wrote: *"per policy, this is the end of the matter and no further bug
is filed."* It did not reword it or retry under another type.

### Added — contract

- **`triage` event kind**, with `attempt`, `runLevel`, `verdicts[]`,
  `quarantined[]` and optional `disagreements[]`. Its own kind rather than a
  field on `verify`, because triage runs more than once per run (a flake verdict
  means a retry) and because the quarantine check reads back what an earlier
  attempt recorded. A run from before this version has no `triage` line, which is
  the correct answer to "what did triage decide", not a missing field.
- `Verifier.triage?()` — optional, runs before `verify`, and the loop writes its
  result to the ledger. Verifiers do not write to the ledger; the loop does.
- `aqa replay` renders triage in the timeline and adds a **Defect candidates**
  section, or a **Nothing was measured** section when the run was written off.

### Added — the defect analysis service, as an upgrade

- `DEFECT_ANALYSIS_URL` unset (the default) means triage runs entirely
  in-process and **nothing leaves the machine**. Set, failures are POSTed to the
  service and its verdicts win where it answered.
- The service can never fail a run: a timeout, a non-200, a malformed body or an
  out-of-vocabulary category all fall back to the built-in verdict already in
  hand, and the report says the run's verdicts did not all come from one
  classifier.
- Disagreements between the two are **recorded, not resolved** — they are the
  training signal for the service and the drift alarm for the port, and they are
  the one thing two implementations buy that one does not.
- The URL is read from the environment and only from the environment. An
  endpoint the agent could nominate from a work item or a tool result would be
  an exfiltration path with a helpful name.

### Added — tests

- 48 tests for the triage module: the first unit tests for any defect-side code
  in this project. One of them found a real interaction on the day it was
  written (the duration-boost/contagion collision above).

### Fixed

- A backtick inside a template literal in `src/skills/story-to-tests.ts` broke
  the build. Second occurrence of this exact class.

### Docs

- `docs/DESIGN_triage.md` — the design, including the three questions it closed
  and what changed after the first draft got the algorithm wrong.
- `docs/VERSIONS.md` — what is released where, and the release order.
- `docs/ADOPTION.md` — a data-egress section, since this is the first feature
  that can send anything outside the workspace.


### Added (A10 — prompt caching)

- **Cache breakpoints on the tools block and the system prompt.** Both are
  byte-identical on every cycle of a run and are most of what a cycle sends — a
  fix → run → fix cycle costs roughly 14k tokens, the bulk of it the fixed tool
  schemas. Assembling each cycle from the ledger rather than continuing an
  API-side conversation is what makes a run replayable; re-sending that prefix
  every cycle was the price of the property. Caching removes the price without
  touching the property.
- **Contract, additive and optional:** `InferencePayload.usage.cacheReadTokens`
  and `.cacheCreationTokens`, written only when the provider reports prompt-cache
  accounting. Absent is not zero — a zero says the prefix missed, absent says the
  provider does not report caching — and keeping them off the payload otherwise
  is what leaves the golden fixture unchanged.
- `aqa replay` reports cache reads as a share of input, and omits the clause
  entirely when nothing was cached. Counts, not money: the price per token is
  not this project's to assert, and a run report that quotes a figure it cannot
  derive from its own ledger is the kind of claim the verifier exists to stop.
- A test asserts the tools and system bytes are identical across two cycles.
  The saving depends entirely on that, and a change that reordered tools or
  rewrote the system prompt per cycle would fail no other test — it would just
  quietly stop the cache from hitting.

### Fixed (A10 — a model call had no bound)

- **A stalled model request hung a run indefinitely.** Every other wait here is
  bounded — the step and token budgets, `--approval-timeout`, the adapters'
  command timeouts — but the Anthropic call was issued with no timeout and no
  retry bound, so a connection that stopped responding never returned control to
  the loop. Observed on run `20260915T222657Z-73bb1bab`: the ledger's last event
  is a `context` at 22:44:17 and nothing followed it for 26 minutes.
  `DEFAULT_TRANSPORT` now sets a 5-minute timeout and 2 retries, configurable per
  model via `AnthropicModelOptions.transport`.
- The worse half of that defect was evidential rather than operational. A hung
  request writes no event, so the ledger — the one artefact this project relies
  on to explain a run — recorded only that a cycle had been assembled, and the
  reason for the silence was not in it. A timeout turns silence into a recorded
  failure, which is the property that was actually missing.

**Measured** on run `20260915T222657Z-73bb1bab`, 76 inferences: 75 of them hit the
cache — only the first missed, which is the write — and the cached prefix was
exactly 6,282 tokens every time, confirming the tools and system bytes really
are identical across cycles. Input-token-equivalents fell from 1,654,057 to
1,231,592, a **25.5% reduction**.

The shape of the saving matters more than the total. An early cycle sends 3,445
real tokens against 6,282 cached — **57% cheaper**. A late cycle sends 25,974
against the same 6,282 — **17%**. Caching removed the cost that was constant and
left the cost that scales: the message content, which grows with the run's
history and cannot carry a breakpoint while it is assembled as a single string.
Splitting it so the stable sources sit ahead of the growing history is the next
move, and this run is the evidence for it.

Also observed: a **260-second gap** between two inferences, across a suite run,
and the cache still hit — 4.3 minutes against a five-minute window. It survived,
barely. A slower suite would miss, which makes the one-hour TTL a question with
evidence behind it rather than a guess.

## [0.1.2] — 2026-09-15

### Fixed

- **Documentation claimed the ledger was scrubbed of secrets. It is not, by design.** Five places
  across four documents said credentials were "redacted on the way in" and that a ledger could be
  shared without review. `scrub()` is applied to model input and to stderr, and deliberately **not**
  to ledger observations — tool results are stored verbatim because redacted evidence is not
  evidence, a decision the code has always carried in a comment. The docs now state the real
  position: no prompt text, no PAT, but whatever the tools returned. Found by auditing
  `ARCHITECTURE.md` against the source rather than against memory.

### Added

- `ARCHITECTURE.md` §8b — why tools arrive over MCP at all, why both servers are pinned, why the
  Azure DevOps server forced per-action classification, why the browser server is deliberately
  half-used, and why six adapters are in-process.
- A statement of what the `bdd2pw`, `synthdata` and `tcg` adapters actually are. They carry the
  names of separate projects of the author's and none is a dependency: `bdd2pw` is reimplemented
  here, `synthdata` is invoked as a subprocess, `tcg` is a remote service. Enabling `tcg` sends the
  story and its acceptance criteria to `TCG_URL`, which is a data-egress decision and is now named
  as one in `ADOPTION.md`.
- `FUNCTIONAL.md` — "What provides each capability": both MCP servers with their pinned versions and
  all six adapters with their real tool names.
- README — "What it is built on", so the runtime's actual composition is visible without opening
  `TECHNICAL.md`.
- A VS Code extension under `extension/`, versioned and released separately. It answers approvals
  through the existing `--approval file` contract and renders the ledger as a browsable tree. Not
  part of this package: `files` is an allow-list and does not include it.

## [0.1.1] — 2026-09-14

### Fixed (found by the pre-publish tarball check)

- `aqa --version` reported `0.1.0-dev.0`. The version was a string literal in `src/cli.ts`, so
  `npm version` bumped `package.json` and left the CLI reporting the last value anyone typed. It is
  now read from `package.json` at runtime, and a test asserts the two are equal. The test that
  should have caught this matched `/0\.1\.0/`, which `0.1.0-dev.0` satisfies — a substring assertion
  on a version number is not an assertion. Found by installing the tarball into a clean directory,
  which is the only step that exercises the package as a user receives it.
- The `files` allow-list shipped `docs/` wholesale, putting eleven internal `HANDOFF_*.md` notes and
  a 272 kB observed-tool dump into the tarball — more than half its size. The seven user-facing docs
  are now listed individually, so a working note added to `docs/` cannot silently join a release.

### Added

- `docs/ADOPTION.md` — what a team has to change before this is useful, who does it, and in what
  order.

## [0.1.0] — 2026-09-14

First public release. One skill — `story-to-tests` — working end to end against a live Azure DevOps
project and a real application, with the governance gate, ledger, replay and verifier behind it.

Packaging: `publishConfig.access: public` stated explicitly, documentation shipped in the tarball,
and `prepublishOnly` now runs lint as well as typecheck, tests and build.

Everything below is the development history that produced it.

### Added (A0 — scaffold)

- Package scaffold: `@vijaypjavvadi/agentic-qa`, TypeScript strict, tsup (ESM+CJS+d.ts), vitest,
  ESLint flat config, Prettier, MIT, CITATION.cff, SECRETS-CHECKLIST.md, CI matrix (node 18/20 ×
  ubuntu/windows).

### Added (A1 — types, ledger, replay, fixture)

- `src/types.ts`: contract types — 11 event kinds, 5 policy classes, decisions, run status and exit
  codes, config schema, `Skill` and `Verifier` interfaces.
- `src/ledger/ledger.ts`: append-only JSONL `Ledger` (flush per event, resume-safe numbering),
  strict parser with line-numbered `LedgerFormatError`, monotonic/same-run checks.
- `src/ledger/replay.ts`: `renderLine` (stable one-liners for the platform run page),
  `computeStats`, `renderMarkdown`.
- `src/cli.ts`: `aqa replay <path> [--out]`, `--version`, `--help`; `aqa run` stubbed until A2.
- `examples/fixture-ledger/`: 34-event synthetic story→tests→Test Plans run covering every kind,
  `make-fixture.mjs` generator, `emit.mjs` streamer with `--approval file` wait for the platform
  track, README.
- Tests: 27 (ledger, parser, replay, CLI).

### Added (A2 — loop with scripted model and stub tools)

- `src/runtime/loop.ts`: plan → act → observe → verify cycle with stop rules (done / blocked /
  refused-fed-back / budget / error), step and token budgets, one batched approval per cycle,
  refused and denied calls fed back to the model as history, `summary.md` written at `end`.
- Interfaces + test doubles: `ModelClient`/`ScriptedModel`, `ToolClient`/`StubTools`,
  `Approver`/`ScriptedApprover`, `Verifier`/`ScriptedVerifier`, `Clock`/`SteppingClock`,
  `ContextBuilder`/`BasicContextBuilder` (hashes + token estimates only).
- `src/governance/policy.ts`: `Gate` interface and `TableGate` (class from the tool manifest,
  decision from the policy table; unknown or non-allow-listed tools are destructive → refuse).
  Scope checks and argument inspection arrive in A3.
- Fixture is now GENERATED by the loop (`examples/fixture-ledger/scenario.ts`,
  `npm run fixture:make`); the golden test asserts byte equality and CI fails on drift.
  Fixture grew from 34 to 42 events (one `context` event per cycle; one `policy` event per call).
- Tests: 41.

### Added (A3 — gate hardening, approvers, scrub)

- `ScopedGate` (design §7): class raised for destructive tool names and protected branches
  (`main`, `master`, `release`, `production`, `prod`); scope allow-list checks on work item, repo,
  test plan and branch arguments declared via `ToolDescriptor.scopeArgs` (exact / numeric range /
  glob; `"*"` only in sandbox mode); out-of-scope → refuse regardless of the policy table.
- `TerminalApprover` (`--approval terminal`, default No) and `FileApprover` (`--approval file`:
  writes `approvals/<id>.json` with `decision:null`, polls, 30-minute timeout → denied by
  "timeout"). Both injectable for tests.
- `scrub()` local redaction rules (Anthropic/OpenAI/AWS/GitHub keys, bearer tokens, basic-auth
  URLs, PAT/password assignments, ADO PAT shapes, email, IPv4, SSN, card) and `mask()` for logs.
- Fixture regenerated: scenario now uses `ScopedGate`; reasons carry scope notes
  (e.g. "read-only; work item 1 in scope"). Still 42 events, no shape change.
- Tests: 85.

### Added (A4 — real MCP client, config, discovery)

- `src/config.ts`: `loadAgentConfig` (JSON or YAML `ai-quality.config.yaml`, PLAN §0 schema,
  defaults + clear `ConfigError`s), `loadDotEnv` (never overrides existing env), `readRuntimeEnv`
  (ANTHROPIC_API_KEY, AZURE_DEVOPS_ORG_URL/PAT/PROJECT, AQA_MODEL, AQA_SANDBOX, TCG_URL,
  AI_GOVERNANCE_URL, SYNTHDATA_CMD).
- `src/mcp/client.ts`: `McpToolClient` over `@modelcontextprotocol/sdk` (stdio transport, one
  session per server, lazy connect, `listTools` → qualified `ToolDescriptor`s classified via the
  manifest, `callTool` → normalised `{ok,result,artefacts}`, errors never throw), `CompositeTools`
  to merge MCP servers with in-process adapters. SDK imported lazily so tests need no network.
- `src/mcp/manifest.ts`: governance manifest (qualified tool → policy class + scopeArgs). Unknown
  tools are `destructive` → refused. Only `fs.*` is filled in; `ado.*`/`playwright.*` are added in
  A5 from `docs/tools-observed.md`, not from memory.
- `src/mcp/servers.ts`: specs for Microsoft's `@azure-devops/mcp` (PAT via env, never argv) and
  `@playwright/mcp --headless`; versions from `AQA_ADO_MCP_VERSION` / `AQA_PLAYWRIGHT_MCP_VERSION`
  or `latest` until pinned after discovery. `npx.cmd` on Windows.
- `src/mcp/adapters/fs.ts`: workspace-bounded `fs.read_file` / `fs.list_dir` / `fs.write_file`
  (path-escape refused).
- `aqa discover [--servers ado,playwright,fs] [--out docs/tools-observed.md] [--env .env]
[--workspace .]`: connects, lists tools, writes a Markdown + JSON report of real names, schemas
  and classification status, closes servers.
- `aqa run "<request>" --config <file> --dry-run`: loads config + env, connects, prints each tool
  as `class → decision`, makes no model or tool calls. Non-dry-run exits 1 until A7.
- `examples/ai-quality.config.yaml`: the sandbox config (work item 1, `agent/*` branches).
- Dependencies: `@modelcontextprotocol/sdk`, `yaml`.
- Tests: 113.

### Added (A5 — per-action governance, adapters)

- **Per-action classification.** Microsoft's Azure DevOps MCP server multiplexes operations behind
  an `action` argument and mixes reads with writes under one tool name (`wit_backlog` does `list`
  and `reorder`; `wit_work_item_link_write` does `link` and `unlink`). `ToolDescriptor` gained
  `actionArg` + `actions`, `ManifestEntry` the same, and `resolveAction()` resolves a call to one
  operation before the gate classifies it. An action absent from the manifest is refused exactly
  like an unknown tool; a missing `action` argument is refused rather than guessed.
- `DEFAULT_MANIFEST` filled in from `docs/tools-observed.json` (67 tools, 2026-09-12): 13 Azure
  DevOps read actions/tools, 6 write_record actions (test case / suite / plan create, add cases,
  update steps, work item comment), 1 write_branch tool, 6 observational Playwright tools. Every
  name is checked against the recorded schemas by a test — nothing is admitted from memory.
- Gate: destructive-by-name now also inspects the ACTION name, and `unlink` / `remove` joined the
  destructive patterns. Scope arguments may be lists (`ids: [1,2]`) and every element must be in
  scope.
- In-process adapters: `bdd2pw` (Gherkin → Playwright spec skeleton; `Scenario Outline` rows
  expanded; every generated test is `fixme` so an unimplemented skeleton can never report a pass),
  `pw` (runs the suite, parses the JSON reporter, `green` requires zero failed AND zero skipped),
  `tcg` (POSTs to `TCG_URL`, which is the full endpoint), `synthdata` (runs `SYNTHDATA_CMD` with no
  shell). All external I/O is injected, so the suite spawns nothing and makes no requests.
- CLI: `--servers` learned `bdd2pw`, `pw`, `tcg`, `synthdata` (the last two opt-in, requiring
  `TCG_URL` / `SYNTHDATA_CMD`); default is now `ado,playwright,fs,bdd2pw,pw`. `run --dry-run`
  prints one line per classified action with the argument each still needs.
- `examples/sandbox/features/login.feature` — AB#1's four acceptance criteria as a feature file,
  for exercising bdd2pw and pw without touching Azure DevOps.
- Pinned `@azure-devops/mcp@2.10.0` and `@playwright/mcp@0.0.80` (the versions discovery recorded).
- Tests: 144.

### Added (A6 — skill, verifier, context ordering)

- `src/verify/evidence.ts`: reads the ledger into `CallRecord`s by pairing `call` with
  `observation` events. A call with no observation (refused, denied, or cut short) never appears,
  so a refused write can never be mistaken for a completed one.
- `src/verify/story-to-tests.ts`: `StoryToTestsVerifier` decides "done" from six observed facts —
  story read, spec file present on disk, suite run green (zero failed AND zero skipped), cases
  created, every case carrying `testsWorkItemId`, cases in a suite. Each failure is a `Gap` whose
  `evidence` records what WAS seen, distinguishing not-attempted from attempted-and-failed.
  `minCases`, `requireGreenSuite` and `requireSuiteMembership` are configurable.
  `parseWorkItemRef()` pulls "AB#1" / "#1" / "work item 1" out of a request.
- `src/skills/story-to-tests.ts`: the slice-1 skill — instructions (goal, the verifier's checks
  stated as not the model's to decide, method, the `action` calling convention, working rules),
  the 14 tools it may see, and the source tools. Tests assert the instructions name only actions
  the manifest admits and only tools it classifies, so skill and governance cannot drift apart.
- `src/runtime/context.ts`: `OrderedContextBuilder` (design §6) — primary sources ordered ahead of
  step history and trimmed last, newest steps kept when over cap, tool schemas never trimmed, and
  gate feedback never trimmed at any size (dropping it makes the model re-propose refused calls
  until the budget dies). Now the loop's default; `BasicContextBuilder` remains for tests.
- Contract, additive only: `ContextPayload.sections[].dropped` and `ContextPayload.droppedItems`
  (optional, present only when trimming happened); `Skill.sourceTools` (optional). The `context`
  event now reports a `sources` section alongside `history` — the fixture shows sources growing to
  a plateau while history grows, which is the shape the run page should render.
- Fixture regenerated (still 42 events) with `sourceTools` declared.
- Tests: 177.

### Added (A7 — Anthropic model adapter, live runs)

- `src/runtime/anthropic.ts`: `AnthropicModel` over the Messages API. Tool descriptors become
  tool-use definitions; the qualified name `ado.wit_work_item` is mapped to `ado__wit_work_item`
  because the API only accepts `^[a-zA-Z0-9_-]{1,128}$`, and mapped back on the way in, so the
  ledger keeps the qualified name. Each tool's description states its governance class and, for
  multiplexed tools, exactly which `action` values are permitted — the model learns the boundary
  from the tool definition instead of by being refused. A tool name the model invents is dropped
  with a warning rather than passed to the gate.
- `RUNTIME_SYSTEM`: the runtime's own instructions (what a cycle is, what the gate does to a call,
  that the verifier decides done), sent ahead of the skill's. The adapter deliberately does NOT
  keep an API-side conversation with tool_result turns: every cycle is a fresh request assembled
  from the ledger, which is what keeps a run replayable.
- `scrub()` is applied to the system prompt and every message before it leaves the process, and to
  adapter warnings on stderr.
- `aqa run` without `--dry-run` now runs: `--work-item` (or "AB#1" parsed from the request), scope
  checked before a token is spent (out-of-scope exits 3), ledger under `--ledger`, `--approval
terminal|file`, and the loop's status as the exit code. `ToolingDeps.buildModel` injects a model
  for tests.
- Contract, additive: `InferencePayload.note` records the model's own words when it declares the
  goal reached, so the ledger shows the claim beside the verifier's verdict.
- Dependency: `@anthropic-ai/sdk` (lazy-imported; the suite never loads it).
- Fixture regenerated (42 events; context sections now mark sources, inference records the note).
- Tests: 196.

### Added (A8 part 1 — URL scope, browser tools)

- **Contract change (PLAN §0.3):** `agent.scope.urls` — where the agent may point a browser. An
  entry may be an origin (allowing every path under it), a path prefix, or a glob; `"*"` only in
  sandbox mode. Empty means the agent may not browse at all. Existing configs must add the key.
- `matchesUrl()` matches on the parsed origin plus path, so a differing scheme, host or port is out
  of scope and a userinfo prefix (`http://localhost:3100@attacker.example`) cannot sneak through a string
  test. `ScopeArgs.url` carries the argument name; `ScopedGate` checks it before the class table.
- Playwright browser tools classified — **exploration only**. `browser_navigate` (scope-checked),
  `browser_navigate_back`, `browser_snapshot`, `browser_find`, `browser_wait_for`,
  `browser_take_screenshot` and the console/network readers are admitted. Everything that OPERATES
  the page — click, type, fill_form, press_key, select_option, hover, drag, drop, file_upload,
  handle_dialog — stays unclassified, so the only thing that ever interacts with the application
  under test is the suite the agent writes. `browser_evaluate` and `browser_run_code_unsafe` are
  never classified.
- `playwrightServer()` now passes `--allowed-origins` (derived from `agent.scope.urls`) and
  `--isolated`. Microsoft states this flag "does not serve as a security boundary and does not
  affect redirects", so it is a second layer under the gate, not the control. Documented as such.
- The skill may now explore an SPA: `browser_navigate`/`snapshot`/`find`/`screenshot`/
  `console_messages` added, `browser_snapshot` declared a primary source (an SPA's selectors live in
  the DOM, not on disk), and the instructions tell the model to take expected behaviour from the
  acceptance criteria rather than by trying it in the browser.
- Known limitation, stated in code and docs: only navigation carries a URL, so a link the agent
  follows or a redirect is not re-checked by the gate.
- Fixture regenerated: adding `urls` to the scope changes the config hash recorded in the `request`
  event. Still 42 events, no shape change.
- Tests: 209.

### Added (A8 part 2 — first live runs against Azure DevOps and Juice Shop)

Everything here comes from defects observed in real runs, not from review. The ledger of each
failing run is what diagnosed it; the run ids are cited so the evidence can be re-read.

- **Authorization failures are terminal** (`src/runtime/denials.ts`). A call can fail because the
  arguments were wrong — retry — or because the environment will not perform that operation for
  this identity at all, which no argument list fixes. `authorizationFailure()` recognises the
  second kind from a narrow set of phrases; `operationKey()` identifies the operation (tool plus
  multiplexed `action`, so `testplan#list_plans` staying open does not depend on
  `testplan_test_plan_write#create`). The loop closes a refused operation for the rest of the run,
  refuses it **before** the approval batch is assembled, and tells the model plainly that
  retrying cannot help. Observed in run `20260914T015933Z-4a2806d0`: Azure DevOps answered "You
  are not authorized to access this API" four times; the model varied `iteration` and `areaPath`
  between attempts, so the exact-argument repeat memo never fired and the reviewer was asked to
  approve the same dead write three more times.
- **Contract change (PLAN §0.3):** `agent.capabilities` — what the environment CAN do, as distinct
  from what the agent is allowed to do (`policy`) or where it may act (`scope`). One key so far,
  `test_plans` (default `true`). Creating a test _case_ is an ordinary work-item write and needs
  only Basic access; creating a test _plan_ or _suite_ goes through the Test Plans service, which
  needs the Test Plans access level — a paid extension. With `test_plans: false` the plan and
  suite tools are removed from the skill's view, the instructions drop the suite step and say why,
  and the verifier stops requiring suite membership.
- **Contract, additive:** `VerifyPayload.limitations` — checks the verifier did not make, and why.
  A run can be done without being complete, and the difference belongs in the ledger rather than in
  a footnote. `aqa replay` renders them under "Checks not made".
- `ServerSpec.defaultArgs`, merged before gating so the ledger and the policy record the arguments
  actually sent. Fixes "Client does not support form elicitation": the Azure DevOps server asks the
  client for `project` when it is missing, and this client cannot answer.
- No-progress stop rule (`MAX_STALE_CYCLES = 3`): a cycle whose calls were all made before is fed
  back once, then the run ends as blocked. Observed: the same two files read 29 times. A
  successful call that produced artefacts, or that is not a read, clears the memo — re-running the
  suite after editing a spec is the same call with a different meaning, and refusing it stranded
  the agent (observed: the model rewrote the spec 13 times working around the rule).
- The model's own notes are fed back cycle to cycle (`NOTE_WINDOW = 4`). Each cycle is assembled
  from the ledger rather than from an API-side conversation, which is what makes a run replayable —
  but without its own notes the model receives identical input and makes an identical decision.
- Context windows split by role: `SOURCE_CHARS = 16_000` for primary sources, `STEP_CHARS = 2_000`
  for step results. A flat 400-character cap had been starving the agent of the acceptance criteria
  it had just read, so it read the work item again, forever.
- `spawnable()`: on Windows a `.cmd`/`.bat` is run through `ComSpec`, since Node refuses to spawn
  one directly (`EINVAL`).
- Azure DevOps auth: `--authentication envvar` with the PAT in `ADO_MCP_AUTH_TOKEN`, passed through
  the child process environment and never argv. The server's default is interactive browser OAuth,
  which opened a browser window mid-run.
- The skill names the credential variables exactly (`AQA_APP_USER`, `AQA_APP_PASS`) and forbids
  falling back to credentials the model happens to know for the application — observed: it invented
  `AQA_USER_EMAIL`, then signed in as the Juice Shop administrator.
- Budgets raised to 60 steps / 1,500,000 tokens; a fix → run → fix cycle costs roughly 14k tokens,
  most of it the fixed tool schemas.
- Fixture regenerated: `agent.capabilities` changes the config hash in the `request` event. Still
  42 events, no shape change.

### Fixed (A8c — the verifier could never pass on a real ledger)

- **`completedCalls()` now returns the server-qualified tool name.** A `call` event stores `server`
  and `toolName` separately, with the tool name bare (`wit_work_item`); the verifier compared it
  against the qualified spelling everything else uses (`ado.wit_work_item`), matched nothing, and
  reported every check as "never attempted". Observed in run `20260914T032555Z-366ff951`: the story
  was read, the suite ran 5/0/0 green, four cases were created — and the verifier answered
  `story-not-read, suite-not-run, no-test-cases`. An already-qualified name is left alone, so a
  ledger from an older build still reads.
- **The unit fixtures had encoded the wrong shape**, writing the qualified name into a `call` event
  the loop would have written bare. That is why 223 tests were green while the verifier could not
  pass a single check against a real run. The fixture builder now writes what the loop writes.
- **Added an end-to-end test** that runs the real loop and hands its ledger to the real verifier.
  Every other fixture in the suite encodes an assumption about the event shape; this one encodes
  none, and is the test that would have caught this.

### Changed (A8d — the verifier checks state, not effort)

Three findings from the first `done` run (`20260914T034436Z-a69f71a5`), all the same mistake wearing
different clothes: a check that asks "did this run DO the thing" rather than "is the thing TRUE".

- **Check 2 accepts a spec that already exists.** It required an artefact recorded in this run's
  ledger, so a run that found a correct spec in the workspace and simply executed it was told "no
  spec written" and had to rewrite the file to pass. It now counts any spec path the run named —
  written, generated or merely read — that is present on disk. A path named but absent is still a
  gap.
- **Check 4 counts cases the story already had.** It required creation, which is precisely why three
  consecutive runs each filed a fresh set of test cases against AB#1. It now counts cases created
  this run plus those already linked by a `Microsoft.VSTS.Common.TestedBy` relation.
- **New check 4b: it looked before it wrote.** Whether a criterion is already covered is a semantic
  judgement — the create tool exposes no tag and no automated-test-name field to key on, and the
  model rewords every title between runs — so the model decides it and code insists only that the
  existing cases were read first (`wit_work_item get` with `expand: "Relations"`). Creating without
  looking is now a gap.
- The skill reads the story with `expand: "Relations"`, reads any linked cases before writing, and
  is told to create only what is missing, `update_steps` what is stale, and leave the rest alone —
  with "a run that creates nothing is a successful run" stated, because the previous instructions
  implied the opposite.

### Fixed (A8d)

- **Azure DevOps results are fenced text, not objects.** Every ADO result reaches the ledger wrapped
  in the untrusted-content fence that keeps the model from reading it as instruction; `asRecord` saw
  a string and returned undefined, so `createdCaseIds` reported nothing on runs that had created
  five cases. `unfence`/`payloadOf` now parse the body, and `testedByIds` reads a story's tested-by
  links out of it.

### Changed (A8d, continued — the grain of a test case is stated)

- One test case per acceptance criterion, whatever number of Playwright tests that criterion
  needs. AB#1 produced **five** cases on one run and **four** on the next, from the same four
  criteria, because nothing said which unit a case represents: the agent split "empty fields show
  validation messages" into two cases one time and kept it as one the next. A traceability link
  whose granularity changes run to run is not a traceability link. The skill now fixes the case
  grain at the criterion, fixes the test grain at the behaviour, and says explicitly that the two
  counts may differ.

### Added (A8e — the run reports itself from the ledger)

- **`aqa.run_summary`** (`src/mcp/adapters/summary.ts`), a new in-process adapter classed `read`.
  It counts the suite result, the cases created and the cases the story already had, the spec files
  written, and anything the environment prevented — all from the ledger — and returns the markdown
  to post. The skill now calls it and posts the text verbatim.

  This closes the one place where the design's own rule did not hold. Everywhere else the model
  proposes and code decides; the comment written back to the story was the model narrating its own
  work — "5 passed", "no duplicates were introduced" — with nothing checking it. It was accurate
  both times we looked. It was still a claim standing where evidence belongs, and it could drift
  from `aqa replay` without anyone noticing. The agent may still add its own judgement around the
  block, clearly marked as its own; it no longer restates the figures, because it no longer has to.

- **The test naming convention is stated**: a test is named for the criterion it covers, suffixed
  `a`, `b`, `c` when a criterion needs several (`AC-3a`, `AC-3b`); the case keeps the bare id. The
  model invented this convention on one run and might not have repeated it. It has to hold in both
  directions, because stripping the suffix off a failing JUnit test name is how the regression
  pipeline will map a failure back to a requirement.

### Changed (A8e)

- **The Playwright JSON report is kept**, written to `.aqa-report/playwright.json` in the workspace
  and recorded as an artefact. The reporter writes to stdout, which was parsed into a flat summary
  and then discarded — so per-test durations, retries and error stacks, exactly what failure triage
  needs, were never persisted at all. Best-effort: a workspace that cannot be written still returns
  a usable summary.

### Added (A9 — the file-approval contract)

- **`--approval-timeout <seconds>`** on `aqa run`. Contract addition, optional, default 1800. With
  `--approval file` nobody is at a keyboard, and silence past the timeout becomes
  `{ decision: "denied", by: "timeout" }` so an unattended run cannot sit forever holding a browser
  and two MCP servers open. A joint smoke or a CI run wants seconds, not half an hour.
- **Four tests covering the platform's path end to end** — the loop asks, the ledger announces, a
  simulated platform answers by writing the file, the run carries on. They pin the parts the other
  track depends on: approve → `done` with the approver recorded, deny → `blocked` with the call
  never made, silence → `blocked` by `timeout`, and the request file carrying the whole batch.
- **Documented the ordering race**: `approval_requested` is appended to the ledger _before_ the
  approver writes `approvals/<id>.json`, so a platform that stats the file the instant it sees the
  event will sometimes find nothing. "Not there yet" means still arriving. There is a test for the
  ordering, because this is the kind of race that appears once in fifty runs and gets blamed on
  something else.
- `docs/HANDOFF_A9_2026-09-14.md`: the full contract, the four things to get right, the status/exit
  table, and the smoke script.
