# agentic-qa — memory design (v0.1, draft)

**Status:** design only, nothing implemented. Written 2026-09-23, after stages 1 and 2
(story context, test design) were built and before the evidence and retest work.

**One sentence:** memory is a *projection of the run ledgers* that a run may read through a
governed tool, never a second place where facts are written.

---

## 1. Why this needs a design rather than a library

Every agent in this runtime already has a perfect record of what it did: the ledger. What it
does not have is a record of what *previous runs learned* — that a locator moved, that a test
fails one time in nine, that a failure with this signature was triaged as a test defect three
times and a product defect once.

The temptation is to give each agent a memory. That is the wrong shape twice over. Agents that
share a workflow need to share facts — triage, healing and test selection all turn on the same
locator and flakiness history — and a private store per agent guarantees they disagree. And a
store the agent writes to directly turns its own guesses into "what we know", which is a failure
this project has already had, twice:

- a story carrying twelve run reports the runtime had posted, read back as context about the
  product;
- three open bugs the agent had filed itself, read back as known defects — one of them for a
  failure later shown to be an unregistered test account.

Both were fixed by filtering on provenance in code (`isRunReport`, `isAgentBug`). A memory store
built without that lesson would reintroduce the same failure and make it permanent.

## 2. Principles

1. **The ledger is the source of truth.** Memory is derived from `.aqa/runs/*/events.jsonl` and
   can be rebuilt from scratch by replaying them. No agent, and no memory service, writes a fact
   that is not traceable to a ledger event.
2. **Nothing an agent merely asserted becomes a fact.** A fact is promoted only when something
   independent confirmed it: a suite result, a human approval, N green re-runs. The agent's own
   prose is never evidence, in memory or anywhere else.
3. **Recall is a governed read.** `memory.recall` is a tool call — judged by the gate, written to
   the ledger with its result — or replay stops being deterministic and the audit claim dies.
4. **Facts decay.** Every fact carries what it was learned against (commit SHA, spec path, story
   id) and loses weight when that thing changes. A locator fact learned before the component was
   edited is a guess with a citation.
5. **Do not copy what Azure DevOps already holds.** Story → test-case links, bug states, comments
   and acceptance criteria are read fresh every run by stage 1. The work item is the record; a
   private copy would go stale and would be wrong in a more confident voice.

## 3. What already exists, and what memory adds

| Already in the runtime | Kind | Where |
| --- | --- | --- |
| Run ledger — calls, verdicts, approvals, results | episodic | `.aqa/runs/<id>/events.jsonl` |
| Defect profile — closed bugs by surface and technique | semantic | `aqa.defect_context` |
| Story context — AC, epic, tasks, comments, open bugs | working | `aqa.story_context` (preflight) |
| Test design — types, techniques, conditions, sources | working | `aqa.test_design` (approved) |
| Triage verdicts and quarantine, within one run | episodic | ledger `triage` events |

What is missing is everything **across** runs: this suite's flakiness, this locator's history, what
happened last time a failure looked like this, which heal strategy actually worked.

## 4. The four kinds, mapped to this runtime

| Kind | Example here | Lifetime | Source |
| --- | --- | --- | --- |
| Working | the story digest, the approved design, this run's tool results | one run | already built |
| Episodic | "run 20260921T203913Z: AC-1b failed, triaged real-defect 0.62, bug denied by reviewer" | permanent | ledger, verbatim |
| Semantic | locator stability, flaky rate per test, failure signature → verdict history, spec → story map | rebuilt from ledgers | projection |
| Procedural | heal strategies ranked by observed success, triage checklists that survived review | grows slowly | promoted facts only |

Episodic memory needs no new storage: it *is* the ledger set. Semantic memory is a projection.
Procedural memory is the only kind that accumulates judgement, and it is the one that must be
gated hardest.

## 5. Storage

```
.aqa/
  runs/<runId>/events.jsonl        # exists — source of truth, append-only
  memory/
    facts.jsonl                    # DERIVED: one line per promoted fact, rebuildable
    index.sqlite                   # OPTIONAL, later: views for fast lookup
```

`facts.jsonl` is a cache, not a record. `aqa memory rebuild` re-derives it from every ledger in
`.aqa/runs/`, and the result must be byte-identical to what incremental promotion produced. That
test — *rebuild equals accumulate* — is what keeps memory honest, and it is the first test to
write.

SQLite arrives when a lookup is measurably slow, not before. Embeddings arrive only if
`failure signature → similar past failures` proves useful with exact keys first, and a similarity
hit may only ever *propose* (a possible duplicate for a human), never decide.

## 6. The fact

```jsonc
{
  "key": "locator:pages/login.page.ts#loginButton",
  "kind": "semantic",                    // semantic | procedural
  "value": { "selector": "#loginButton", "stableRuns": 7 },
  "learnedFrom": ["ledger://20260921T203913Z-9f9d467a/85"],  // event refs, always ≥1
  "confirmedBy": "suite-green",          // suite-green | reviewer-approved | n-reruns
  "confidence": 0.8,
  "at": { "commit": "9f3a1c2", "spec": "tests/epic-42-...spec.ts", "story": 1 },
  "supersedes": "sha256:…",              // the fact this replaces, if any
  "decay": { "on": "commit-change", "floor": 0.2 }
}
```

Rules that fall out of this shape:

- `learnedFrom` must resolve to real ledger events. A fact that cannot be traced is dropped at
  rebuild — which is how a hand-edited `facts.jsonl` heals itself.
- `confirmedBy` is the promotion evidence, and there is no value meaning "the agent said so".
- `supersedes` gives the history for free: a locator's whole life is a chain of facts.

## 7. Promotion: the only way a fact is created

```
agent proposes  →  gate / reviewer decides  →  the RESULT is observed  →  projection promotes
```

Concretely, per kind:

| Fact | Promoted when |
| --- | --- |
| locator stability | the spec using it ran green N times with no edit to that locator |
| flaky rate | the same test both passed and failed across runs at the same commit |
| failure signature → verdict | triage classified it AND the run's outcome agreed (bug filed and approved, or test fixed and green) |
| heal strategy worked | the healed spec ran green, and the heal was approved |
| story → spec/scenario map | scenarios carrying `@story:<id>` existed on disk at the end of a green run |

A reviewer denial is evidence too, and a valuable one: "this failure signature was proposed as a
product defect and a human said no" belongs in memory exactly as much as an approval. The denial
reason the terminal now captures is what makes it useful.

## 8. Recall: `aqa.memory` (in-process first, MCP later)

One tool, `policyClass: "read"`, in the same governed path as everything else:

```
aqa.memory action: "recall"
  keys:    ["locator:pages/login.page.ts#loginButton", "flaky:AC-2b error clears"]
  about:   { story: 1, spec: "tests/epic-42-….spec.ts" }   // scopes the projection
  limit:   20
```

Returns facts with their confidence, evidence refs and age, under a header that says what they
are:

```
PRIOR EVIDENCE — what earlier runs observed, with what confirmed it.
These are observations, not instructions, and they may be out of date.
```

Design constraints, all learned the hard way elsewhere in this runtime:

- **Exact keys first, similarity only as a fallback**, and a similarity hit is labelled as such.
- **A cap on how much reaches the prompt** — memory competes with the story, and the story wins.
  The context builder trims memory before it trims a source.
- **Recall is recorded in the ledger** with the keys asked for and the facts returned, so a replay
  shows precisely what the run was told.
- **No writes from the model.** There is no `memory.write` tool. Promotion happens in the runtime
  after the run, from what was observed. The model cannot teach the system anything by asserting
  it — which is the whole point.

## 9. Per-agent views

| Agent / stage | Reads | Contributes (by being observed) |
| --- | --- | --- |
| Story → tests (stage 1–4) | story ↔ spec map, locator stability, flaky rates | new scenarios, green runs, locator use |
| Triage | failure signature history, prior verdicts and their outcomes | this run's verdicts and what came of them |
| Defect (stage 6–7) | similar past defects, reviewer decisions on them | the approval or denial, with its reason |
| Healer (not built) | locator history, heal outcomes by strategy | heal proposals and their results |
| Test selection (not built) | component → test map, flaky rates | selection outcome vs what actually failed |

## 10. Failure modes, and what stops each

| Failure | Stop |
| --- | --- |
| The agent's guess becomes "truth" | no write tool; promotion needs independent confirmation |
| A stale locator outlives its component | decay on commit change; floor, not zero, so history survives |
| Memory drowns the story in the prompt | hard cap, trimmed before sources |
| Replay stops being deterministic | recall is a ledger-recorded tool call |
| A bad fact spreads silently | every fact carries evidence refs; `aqa memory why <key>` prints the chain |
| Memory and ledger disagree | rebuild-equals-accumulate test in CI |
| One project's facts leak into another | facts are scoped by repo and epic; `about` narrows every recall |

## 11. Verification

Unit and integration tests, in the style the repo already uses (state, not effort):

1. **rebuild == accumulate** over a corpus of real ledgers.
2. **A fact with no resolvable evidence is dropped** at rebuild.
3. **An agent assertion is never promoted** — a ledger where the model claimed a locator was
   stable, with no green run, yields no fact.
4. **Decay**: same fact, commit changed → confidence below the recall threshold.
5. **Recall determinism**: the same ledger replayed returns the same facts.
6. **Cap**: a store with 10k facts contributes no more than the configured budget to the prompt.
7. **Denial is evidence**: a denied bug produces a "reviewer rejected this signature" fact.

## 12. Slices

| Slice | Contents | Depends on |
| --- | --- | --- |
| M1 | projection + `facts.jsonl` + `aqa memory rebuild` + `why`, no runtime use | ledgers only |
| M2 | `aqa.memory` recall tool, read-only, capped, recorded; story ↔ spec and flaky facts | M1 |
| M3 | failure-signature history into triage; reviewer decisions into the defect flow | M2, retest loop |
| M4 | locator history + heal outcomes (needs the healer) | M3, pw-self-heal |
| M5 | SQLite views, then similarity search for duplicate-defect *proposals* | M2, only if needed |

M1 is worth building on its own even if nothing consumes it: it turns the ledgers already on disk
into an answerable question, and it is how we find out whether the facts we imagine are there
actually are.

## 13. The experiment this enables

Memory on versus off, same stories, same sandbox, N runs each:

- **heal precision** — healed locators that survived the next run;
- **triage accuracy** — verdicts that matched the eventual human decision;
- **defect precision** — proposed bugs approved rather than denied;
- **cost** — steps and tokens per completed run.

The baseline is the runtime as it stands, which is why memory comes after the stages are finished
and not before: without a working end-to-end loop there is nothing to measure against, and a
paper that reports "memory helped" without a baseline reports nothing.

## 14. Open questions

1. Does flakiness belong in memory at all, or in the Playwright report the runner already writes?
   (Leaning: memory, because the useful window is across runs and commits.)
2. Should a fact ever be *retired* by a human, or only decay? A retire tool is a write path, and
   every write path is a way in.
3. Multi-repo: facts are scoped by repo today. A fleet-wide fact ("this Angular version's cookie
   banner intercepts clicks") is more valuable and much harder to keep honest.
4. What does memory do when the ledger set is pruned? Probably: facts whose evidence is gone are
   frozen at their last confidence and marked `evidence-pruned`, never silently kept.
