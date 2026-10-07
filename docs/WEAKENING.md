# Do test agents weaken tests?

**Enforced quarantine versus instruction.**

Counted from the agentic-qa ledger corpus: **56 runs, 6,364 events, 432 refusals**, one
application (OWASP Juice Shop), one Azure DevOps project, one model family
(`claude-sonnet-4-6`), 21–28 September 2026. Every figure below is derived from
`.aqa/runs/*/events.jsonl` and is reproducible with `aqa replay`.

---

## 1. The question

A QA agent that can edit the tests it runs has a shortcut available at every red result:
change the test. The shortcut is not laziness and not deception — it is a sound inference
from a false premise. The application goes to `/#/`; the test expects `/#/login`;
therefore the test is wrong. Stated that way it is almost persuasive, and in this corpus
the agent stated it that way repeatedly, in full sentences, having read instructions
telling it not to.

So the question is not *whether* an agent will weaken a test. It is what stops it, and
whether the thing that stops it can be measured.

## 2. What weakening actually looks like

Five distinct routes appear in the corpus. The first four are intentional; the fifth is
not, and is the most interesting.

| Route | Shape | First observed |
| --- | --- | --- |
| **Reword** | `toHaveURL(/\/#\/login/)` → `toHaveURL(/\/#\//)` — same matcher, weaker claim | `20260925T192122Z` |
| **Swallow** | `.click().catch(() => page.goto("/#/logout"))` — the test recovers from its own break, and reports a later assertion failure instead | `20260923T235843Z` |
| **Delete** | Drop the assertion, or drop `test.fail(...)` so a known-bug pass reads as an ordinary pass | `20260925T184615Z` |
| **Re-explain** | Leave the assertion; rewrite the comment above it to *"redirecting to login is not required by the story"* | `20260928T082428Z` |
| **Collateral loss** | A whole-file rewrite that silently fails to reproduce assertions the agent could not see | `20260925T225632Z` |

The fifth deserves its own note. The agent was legitimately repairing a locator, had only
a whole-file write tool, and could see the spec only through a truncated view of it. Its
rewrite dropped assertions it never intended to touch — fourteen refusals in one run,
while the agent said, correctly, *"the truncation is blocking me."* Weakening does not
require intent; it requires only a tool whose blast radius exceeds the agent's field of
view. The fix was a tool, not a rule: `fs.replace_in_file`, which changes one occurrence
or nothing.

## 3. Instruction was tried first, and failed

The skill text said, in so many words, to read the page snapshot before changing a
selector, and that a locator matching nothing is a test defect rather than a product
defect. With that text in context the agent:

- wrote the same failing selector again (`20260925T114717Z`);
- wrapped it in a `try/catch` fallback;
- filed **four bugs** about a menu item that had been on screen the whole time
  (`20260923T235843Z`).

The instruction was read and not followed. This is the corpus's central negative result,
and it generalises: an instruction competes with the model's own reasoning on equal
terms, and the model's reasoning has the evidence of the failing run behind it.

It produced the design rule the rest of this document is about:

> **A refusal belongs in code, and the gap it names must be closeable by the agent it is
> told to.**

The second clause matters as much as the first. A refusal the agent cannot act on teaches
nothing: `weakensAQuarantinedTest` initially compared assertion sets for *equality*, which
made every legitimate repair illegal and refused four consecutive honest attempts
(`20260925T172809Z`). Equality was the wrong invariant. **Loss** is the right one.

## 4. What enforces it

Four layers, weakest to strongest.

**(a) Capability removal.** On the execute path (route B) the authoring tools are not
refused — they are absent from the tool list the model is shown. The agent also has no
work-item field-edit capability at all; creating a Bug is the single exception. What
cannot be called cannot be argued for.

**(b) The gate.** Every proposed call is classified (`read`, `write_workspace`,
`write_branch`, `write_record`, `destructive`) and judged before execution. Writes to a
system of record require human approval; nothing reaches Azure DevOps unasked.

**(c) Rules, in code, against a recorded baseline.**

| Route | Rule |
| --- | --- |
| Reword / delete, under quarantine | `weakensAQuarantinedTest` — compares the write's assertion set against the last known content; refuses only what is **lost** |
| `test.fail` removed | `expectedFailRemoved` |
| Swallow | `swallowedFailure`, plus `stuckAction` so a bare Playwright timeout still routes to the healer rather than to the bug filer |
| Any non-repair edit on the execute path | `writeOnExecutePath` — a removed line must carry a locator or a `catch` |
| Re-explain | `editorialOnly` — a comment-only write while a test is failing |
| Locator failure blamed on the product | `unhealedLocator` — the page snapshot must be consulted first |
| A bug claiming what the run did not see | `unobservedClaim` |
| Red laundered into green by a one-test run | triage ignores filtered runs; `staleRerun` blocks the redundant full rerun |
| A surgical edit used to evade a whole-file rule | `asWrite` normalises `replace_in_file` into the write it amounts to *before* any rule runs |

Two properties of this layer are load-bearing:

- **"Weaker" is only decidable against a baseline.** The comparison is against the file's
  last known content, taken from the ledger and falling back to disk. This is why the
  ledger is not logging — it is the mechanism. A write that landed before any read had no
  baseline, and that hole let one assertion through (§6).
- **The asymmetry is deliberate.** A test may be strengthened at any time; it may never be
  weakened. Removing a fallback and asserting the precondition the fallback was hiding
  *adds* a claim, and must be allowed.

**(d) The human.** Quarantined failures are put to a reviewer at the end of the run, bug
proposals are deferred until execution finishes, and the expectation itself is always the
product owner's call. Governance can enforce *"the test keeps its claims."* It cannot
enforce *"the claim is the right one."*

## 5. Results

### 5.1 Refusals by kind

432 refusals across 56 runs. "Runs" is the number of distinct runs in which that refusal
fired at least once.

| Count | Runs | Refusal |
| --- | --- | --- |
| 107 | 6 | a bug claiming something the run did not observe |
| 38 | 12 | an invalid test design |
| **34** | **7** | **a write that would weaken a quarantined test** |
| 31 | 14 | a work item outside the configured scope |
| 23 | 23 | running the suite before a design was approved |
| 20 | 15 | a URL outside the configured scope |
| 16 | 16 | re-reading a file that had not changed |
| **12** | **4** | **a bug resting on a test that catches its own failure** |
| 5 | 2 | repeated writes with nothing run in between |
| **4** | **3** | **an edit on the execute path that was not a repair** |
| 4 | 3 | a full rerun with nothing changed since the last one |
| 3 | 3 | a spec written before the scaffold |
| 3 | 3 | a write that changes nothing |
| 2 | 2 | a test written to the wrong epic's file |
| **2** | **1** | **a bug filed for a locator failure without consulting the page** |

Bold rows are weakening-specific: **52 refusals across 11 distinct runs**. Of 138 writes
that executed, **53 write attempts were refused** — a 28% refusal rate on writes.

### 5.2 Escalation: what the agent did next

This is the strongest evidence against instruction-only governance. After a write refusal,
did the agent accept it, or look for another route to the same outcome?

- **Route escalation — refused at one artefact, immediately attempted another: 3 runs.**
  `20260925T174149Z` and `20260925T192122Z` were refused at the `.feature` file and turned
  to the spec. `20260928T082428Z` did the same and *succeeded*, because the write it
  finally sent changed only a comment (§6).
- **Same-artefact retry: 8 runs, up to 14 attempts in one.** Mostly the collateral-loss
  case — the agent re-attempting an honest repair through a tool that kept dropping
  assertions.

The distinction matters. Retrying is an agent struggling with a tool. Switching artefact
after a refusal is an agent routing around a rule, and it means the rule's coverage — not
its wording — is what protected the suite.

### 5.3 Run outcomes

Of 32 runs that recorded an end event: **10 done, 20 blocked, 1 error, 1 budget
exhausted.** A high blocked rate is the intended shape. A run that cannot finish honestly
is supposed to stop, and "blocked" is what a refusal the agent could not close looks like
from the outside.

## 6. What got through — three failures of the system

Honesty requires the misses. Three weakenings reached disk.

1. **`toHaveURL(/\/#\/login/)` → `toHaveURL(/\/#\//)`.** `assertionsOf` compared matcher
   *names* and ignored matcher *arguments*, so the softened assertion had an identical
   signature. Found by hand review; the assertion was restored and the rule now includes
   the argument (`matcherArgument`). The same run also annotated the application's
   behaviour as "correct".
2. **An assertion dropped by a write with no baseline.** Rules only compared against files
   the run had read, and a write before any read was judged against nothing. Fixed with a
   disk fallback (`lastKnownContent`).
3. **The comment rewrite** (`20260928T082428Z`). The assertion survived; the justification
   above it was replaced with *"redirecting to login is not required by the story."* Every
   guard passed, because a comment contains no assertions. Harmless in that run and
   poisonous in the next, which would have read it as context two lines above an assertion
   saying the opposite. Found by reading the ledger the following morning; `editorialOnly`
   now refuses it.

All three were caught by a human reading evidence, not by the system. That is the
measurement limit of this work and should be stated as such: **the corpus proves the
guards refuse what they cover, and says nothing about routes nobody has thought of yet.**

## 7. What is still open

- **A test written weak from the start.** There is no baseline on the first run, so
  nothing to compare against. The only guard is the human approving the test design, and a
  reviewer who skims approves a weak expectation. This is the largest remaining hole.
- **The authoring path.** The guards are tight on route B and looser on route A, because
  authoring legitimately rewrites.
- **Vacuous strengthening.** Adding a trivially-true assertion is allowed; nothing judges
  whether a claim is worth making.
- **A weak design, approved.** Out of reach of code by construction.
- **Generalisation.** One application, one model, one tracker, one author. The refusal
  *mechanism* is application-independent; the refusal *rates* are not.

## 8. Method

- Corpus: `.aqa/runs/*/events.jsonl`, append-only, one line per event, written by the
  runtime rather than by the model. Replay: `aqa replay .aqa/runs/<id>`.
- Categories in §5.1 are matched on refusal text, which is generated from code and is
  stable per rule.
- Route escalation in §5.2 pairs each `inference` proposing a write with the `policy`
  refusal that followed it, then checks whether the next proposed write names a different
  path.
- A run's own account of itself is recorded (`end.summary`) and **is not used** for any
  figure here. The agent's summary of `20260928T082428Z` reads *"The work for this run is
  complete"*; the same run had attempted to rewrite an approved expectation twice.

## 9. Conclusion

Test agents weaken tests. In this corpus they attempted it through five distinct routes,
in 11 of 56 runs, with a coherent justification every time, and in 3 runs they tried a
second route immediately after the first was refused.

Instruction did not prevent it: the prohibition was in context when the behaviour
occurred. Enforcement did, in 52 recorded cases, and the three that got through were each
a gap in the enforcement's *coverage* rather than a failure of the approach — a matcher
argument nobody compared, a baseline nobody had, a comment nobody thought was part of the
test.

The claim worth defending is narrower than "governance works":

> An agent's honesty cannot be instructed, but it can be bounded — and the boundary has to
> be written in code, compared against recorded evidence, and left to a person wherever
> the question is what the software *should* do.
