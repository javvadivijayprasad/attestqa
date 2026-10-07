# Design slice — failure triage, quarantine, and the defect candidate list

Status: **decided, not implemented.** Three open questions from the first draft are
closed; see §11 for what changed and why.
Follows: the locked defect-insight design (lessons from bug history → test design).
Followed by: bug creation on human approval (separate slice, deliberately out of this one).

---

## 1. The problem this solves

Two different things go wrong today, and they look identical to the agent.

A run of `story-to-tests` ends with `pw.run_tests` returning red. The agent's next move
is always the same: assume the spec is wrong, edit it, run again. That is correct
perhaps a third of the time. The other two thirds it is editing a perfectly good test
because the application container was not up, or because a shared fixture left state
behind, or — the case that matters most — because the test is right and **the product
is broken**.

The run on 2026-09-15 took 76 inferences. A large share of them were the agent
rewriting selectors against an app that was not serving. No amount of spec editing
reaches green when green is unreachable, and nothing in the loop can say so, because
the verifier only knows "tests did not pass".

There is a second, quieter cost. When the agent does hit a real product defect, it
*fixes the test around it*. It relaxes the assertion until the suite is green. That is
the worst possible outcome: the defect survives and the evidence of it is destroyed.

Triage is the missing step: **before deciding what to do about red, decide what kind of
red it is.**

## 2. What triage is, and what it is not

Triage classifies a **failure** — a single test that failed in this run, from its
error text and context.

The defect profile (previous slice) classifies a **defect** — a closed bug from the
history, from its prose.

Same project, opposite ends of the lifecycle, and they must not be confused. The
profile teaches the designer what to write *before* a run. Triage tells the loop what
to do *during* one, and produces the defect candidates a human reviews *after* one.

Triage does not file bugs. It does not edit specs. It produces a verdict per failing
test, and the loop acts on the verdicts.

**Triage never stops test execution.** The suite always runs to completion — Playwright
already does this and nothing here changes it. Running twenty-nine more tests after one
finds a bug costs nothing and tells you twenty-nine more things. What triage can stop is
the *agent's repair loop*: the edit-and-rerun cycle. Those are different things and the
first draft of this document ran them together, which was wrong.

## 3. The categories

Ported from `Application/defect-analysis-service/src/defect_analysis/engine/classifier.py`,
deliberately unchanged — same five categories, same precedence, same ordering comment.

```
infrastructure > environmental > flake > real-defect > expected-failure
```

| category | means | examples the patterns catch |
| --- | --- | --- |
| `infrastructure` | the test never got to run properly — the harness, runner or CI itself | worker crashed, browser launch failed, out of memory, runner disconnected |
| `environmental` | the system under test was not there or not usable | ECONNREFUSED, 502/503, DNS failure, page never loaded, auth service down |
| `flake` | ran, failed, would likely pass again unchanged | timeout waiting for a selector, race on animation, retry passed, intermittent |
| `real-defect` | the product did something wrong and the test correctly caught it | assertion on a value, wrong status code, wrong text, element genuinely absent |
| `expected-failure` | known-failing, marked as such | `test.fail()`, `fixme`, annotated known issue |

The precedence is the whole design, and it carries its original comment into the
TypeScript:

> This ordering biases towards NOT over-escalating.

A failure that matches both `environmental` and `real-defect` is called environmental.
Wrongly calling an outage a product defect is expensive — someone investigates a bug
that does not exist. Wrongly calling a product defect an outage is cheap — the next
green run corrects it. The asymmetry is intentional and should be preserved exactly,
because it is the part of this that was tuned against real failures.

## 4. How the rules are ported

Not as a rewrite. As a **data table that mirrors the Python literally**, so divergence
between the two implementations is visible as a diff rather than as behaviour nobody
noticed changing.

```ts
// src/triage/patterns.ts
//
// Ported verbatim from defect_analysis/engine/classifier.py (five banks).
// Keep the order, the wording and the comments aligned with the Python so
// `git diff` across the two files is the drift report. If you change a pattern
// here, change it there in the same commit or write down why not.
export const INFRASTRUCTURE_PATTERNS: readonly RegExp[] = [ /* ... */ ];
export const ENVIRONMENTAL_PATTERNS:  readonly RegExp[] = [ /* ... */ ];
export const FLAKE_PATTERNS:          readonly RegExp[] = [ /* ... */ ];
export const REAL_DEFECT_PATTERNS:    readonly RegExp[] = [ /* ... */ ];
export const EXPECTED_FAILURE_PATTERNS: readonly RegExp[] = [ /* ... */ ];

export const CATEGORY_ORDER = [
  "infrastructure", "environmental", "flake", "real-defect", "expected-failure",
] as const;
```

The engine itself is ~40 lines: for each failure, walk `CATEGORY_ORDER`, return the
first category with a matching pattern and the matched substring as evidence. No state,
no network, no model. Deterministic — which means it is unit-testable, and this slice
is where the defect code finally gets tests.

**Not ported:** `llm_analyzer.py` (899 lines), `state_store.py` (SQLite cache and
training corpus, 506 lines), `few_shot.py`, the Jira client. Those are the service's
reason to exist. Reimplementing them here would be the third copy of your own work
after `bdd2pw`, and the first two already drift.

## 5. Contagious versus local — the only run-level judgement

Not every verdict means the same thing about the *other* tests in the suite.

**Contagious — `environmental`, `infrastructure`.** If the application was not serving,
then nothing in that run was measured. A `real-defect` verdict on some other test is
meaningless, because that test was not exercising the product either. The whole result
set is written off. There are no defect candidates, because nothing was tested.

**Local — `real-defect`, `flake`, `expected-failure`.** These say something about one
test and nothing about any other. A product bug in the discount calculation tells you
nothing about whether the address form works. Twenty-nine passing tests remain
twenty-nine passing tests.

This replaces the "worst category across the run wins" rule from the first draft, which
collapsed two unrelated ideas — *this result is untrustworthy* and *this result is bad
news* — into one ordering. Only the first is contagious.

## 6. Where it sits in the flow

`pw.run_tests` already writes `.aqa-report/playwright.json`. Triage reads that file —
it does not re-run anything and does not need the model.

```
plan → act → observe → VERIFY
                         │
                         ├─ suite green ────────────────────────────► done
                         │
                         └─ suite red   (all tests have run to completion)
                              │
                              ▼
                        triage each failure     ← in-process, deterministic
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      contagious verdict present?        no contagious verdict
    (environmental / infrastructure)             │
              │                                  │
              ▼                    ┌─────────────┼──────────────┐
      nothing was measured         ▼             ▼              ▼
      stop the repair loop    real-defect      flake     expected-failure
      no defect candidates         │             │              │
                              quarantine    retry once      ignore
                              (hands off)   then treat
                                   │        as its new
                                   ▼        verdict
                           defect candidate
                                   │
                                   ▼
                        agent continues repairing
                        every OTHER failing test
                                   │
                                   ▼
                      end of run: quarantine check
                                   │
                                   ▼
                       defect candidate list → human
```

Triage runs **inside the verifier**, not as a tool the model may call. That placement
is the point. A model that could choose whether to triage would skip it exactly when it
is most useful — when it has a theory about the failure it wants to act on. Code decides
"done"; code also decides which failures the agent is allowed to touch.

## 7. Quarantine — protecting the evidence with a check, not an instruction

A test triaged `real-defect` is **quarantined**: the agent may not modify it, and may not
modify anything it depends on in a way that changes its outcome.

The risk is specific and worth naming. The agent is working in the same spec file as the
quarantined test, and its entire disposition is to make red go green. One relaxed
assertion, one adjusted shared `beforeEach`, and the defect is gone from the record —
silently, and in a commit that looks like ordinary repair work.

Telling the model not to do this is necessary and not sufficient. So:

1. At triage, record the quarantined test's full title and its exact error.
2. At end of run, re-read the report. The test must still exist and must still fail with
   the same error.
3. If it does not, raise gap `quarantined-test-modified`, carrying the before and after.

This is the same principle as everywhere else in the runtime: the model proposes, code
checks. It also resolves the tension in the first draft, where the only way I could see
to protect the evidence was to forbid the agent from continuing at all. A check is
cheaper than a prohibition and does not cost you the other twenty-nine results.

## 8. What the run produces

The output of triage is not "stop". It is a **defect candidate list**:

```
Suite complete: 30 tests, 3 failed.
  2 triaged real-defect  → defect candidates (quarantined)
  1 triaged flake        → retried, passed

Defect candidates:
  [1] checkout › applies a 10% discount code
      expected 90.00, received 100.00
  [2] checkout › rejects an expired code
      expected 400, received 200
```

That list is what the next slice hands to a human at the CLI, and files as bugs only on
an explicit yes. Triage produces the candidates; it never files anything.

Verifier outcomes:

| situation | outcome |
| --- | --- |
| contagious verdict | gap `sut-unavailable` or `harness-unusable` — green is unreachable, nothing was measured, the fix is a human starting something |
| one or more `real-defect` | gap `product-defect-suspected`, one per candidate, carrying the failing assertion and the expected/actual values |
| `flake` only, retry passed | `done` with a limitation recording that the suite was retried and why |
| quarantined test changed | gap `quarantined-test-modified` |

A `real-defect` never resolves to `done: true`. The run finished its work; the product
did not pass. Those are different sentences and the report says the second one.

## 9. The ledger event

Triage writes its own event type rather than a field on the verify event. Two reasons,
both mechanical:

- **Triage can run more than once per run.** A flake verdict means retry, and the retry's
  results must be triaged again. There is only one verify event, so a field on it would
  either overwrite the first triage or nest an array inside itself — which is an event
  type with extra steps and worse ergonomics.
- **The quarantine check reads back what triage wrote earlier.** The ledger is already
  this runtime's memory; a fact written when it is true and read when it is needed
  belongs there as a fact. Folding it into the verify event makes the verifier read its
  own earlier output with no independent record in between.

```jsonl
{"type":"triage","at":"2026-09-18T11:04:22Z","attempt":1,
 "runLevel":null,
 "verdicts":[
   {"test":"checkout › applies a 10% discount code",
    "category":"real-defect",
    "evidence":"expected 90.00, received 100.00",
    "triagedBy":"builtin"},
   {"test":"checkout › shows the promo banner",
    "category":"flake",
    "evidence":"Timeout 5000ms exceeded waiting for locator",
    "triagedBy":"builtin"}],
 "quarantined":["checkout › applies a 10% discount code"]}
```

`runLevel` carries `"environmental"` or `"infrastructure"` when the contagious case
fires, and `null` otherwise — one field that says "nothing here was measured", rather
than leaving a reader to infer it from the verdict list.

Costs: `replay` learns the type, the Paper I event schema gains an entry, the VS Code
extension renders it or ignores it gracefully. Three files.

Worth having: a run from before triage existed simply has no `triage` line. That is the
correct answer to "what did triage decide here", not a missing field needing an edge
case — which matters when the paper's table is counted across a few hundred ledgers.

## 10. The service as an upgrade, not a dependency

Same shape as `capabilities`: the built-in path is a fact about what this runtime can
do on its own; the service is something the environment may additionally offer.

```
DEFECT_ANALYSIS_URL unset  → built-in rules. No egress. Default.
DEFECT_ANALYSIS_URL set    → POST the failure to the service; use its
                             classification when it answers, fall back to the
                             built-in rules when it does not.
```

The service is never required, never blocks a run, and a timeout or a 500 from it is a
limitation in the report rather than a failed run. A CI pipeline that loses the service
for an afternoon degrades to deterministic rules and says so.

**Provenance is recorded per verdict** — `triagedBy: "builtin" | "service"`, plus
`serviceVersion` when the service answered. A verdict whose origin is unknown cannot be
audited later.

When both ran, record both and flag disagreement as a limitation. Disagreements are the
training signal for the service and the drift alarm for the port — the one place where
having two implementations pays for having two implementations.

### Data egress — for ADOPTION.md

This is the first feature that can send anything outside the workspace, so it gets an
explicit paragraph in the adoption guide rather than a footnote:

- Default: **nothing leaves the machine.** Triage is regex matching over a local JSON
  report.
- With `DEFECT_ANALYSIS_URL` set, the payload is the failing test's name, error message,
  stack and status — application output, which may contain data from the system under
  test. Teams pointing this at a hosted service must know that.
- The URL is read from the environment, never from a work item, a spec, or anything the
  model produced. An endpoint the agent could choose is an exfiltration path.
- No credentials are sent. If the service needs auth, that is a separate decision and
  not in this slice.

## 11. Decisions taken since the first draft

**Flake retries once, unchanged, then is treated as whatever the retry says.** None
risks stopping on something that would have passed; more than one is a slow way to hide
a real intermittent. A flake verdict never justifies editing the spec.

**A real defect does not end the run.** The first draft argued for stopping the whole
run on the first `real-defect`, on the grounds that a rule with an exception is a rule
the loop will find a way through. That was a developer's instinct, not a tester's: you
run the suite and then report what you found. The evidence concern behind it was real
and is now handled by the quarantine check in §7 — a check rather than a prohibition, so
it costs nothing.

**Triage gets its own ledger event type.** §9.

## 12. What the rule became, after running it

§6 and §11 describe the design as reviewed. Running it changed it, and this section is
what is actually built. The operator's rule replaced mine:

> Any Playwright issue or any env issue — retry the execution. If it fails again, treat
> it as a real failure and ask the user to approve a defect. If they say no, it ends
> there.

**Retry first, every category.** Triage's first verdict in a run is never acted on. It
asks for one clean re-run of the suite, unchanged, and forbids editing a spec, selector,
timeout or config value before it. A transient outage and a persistent one look
identical on the first report; so do a racy assertion and a broken one. Only the second
run separates them.

This replaced an immediate stop on `environmental`/`infrastructure`, which decided on
the operator's behalf that an unreachable application could never be worth filing. That
is a judgement about the product, and it belongs to a person.

**Then propose, never decide.** A failure that survives the retry produces a proposed
Bug — `ado.wit_work_item_write` action `create`, `workItemType` "Bug" — classified
`write_record`, so the gate asks. Deny is final: the instructions forbid rewording it,
retrying it, or opening it as another type.

**Triage no longer ends a run at all.** Every path returns notes for the next context.

### The retry is instructed, not enforced — deliberately

Nothing in the gate stops the agent editing a spec between the failed run and the retry.
It could be enforced (refuse `fs.write_file` on a spec while a retry is outstanding), and
it is not. Decided against on 2026-09-18: the instruction held on the first real run —
run `20260918T170400Z-4683360d` made two `pw.run_tests` calls with no `fs.write_file`
between them — and enforcement here would cost a gate rule guarding a case that has not
happened. The end-of-run quarantine check still catches the specific harm this would
prevent: a quarantined test being modified.

Revisit if a run is observed editing before its retry. Do not add it pre-emptively.

## 13. Out of scope, deliberately

**The feedback loop.** `POST /feedback` to the service when a human overrules a verdict.
The deny at the prompt is the most valuable label in the system and is currently
recorded only in the ledger.

**Re-triaging history.** Running the rules over old ledgers to see what the stop rule
would have saved. Interesting for the paper, not for the runtime.

**Enforcing the unchanged retry.** See above — a decision, not an omission.

## 14. Build order

1. `src/triage/patterns.ts` — the five banks, ported, with the mirror comment.
2. `src/triage/classify.ts` — the ~40-line engine. **Unit tests here first**; this is
   the first defect-side code in the project to get them.
3. Report parsing — read `.aqa-report/playwright.json` into failures.
4. Ledger `triage` event + `replay` support.
5. Verifier integration: contagious check, quarantine record, the four gaps.
6. End-of-run quarantine check.
7. `DEFECT_ANALYSIS_URL` path, provenance, disagreement limitation.
8. ADOPTION.md egress paragraph.

Steps 1–3 are testable with no agent run at all, which is where the confidence comes
from before anything touches the loop.
