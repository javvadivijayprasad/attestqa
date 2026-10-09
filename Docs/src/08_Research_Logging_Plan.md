---
title: "attestqa — Research Logging Plan"
doc: "AQ-08"
version: "1.6 (for sign-off)"
date: "2026-10-10"
---

# 1. Why log from day one

Paper I was possible because every run already wrote a ledger. What it lacked was everything around the runs: why a rule was added on a given day, what we expected before we looked, which runs belonged to which question. Reconstructing that afterwards from chat history and commit messages took longer than the analysis. This plan makes that record a by-product of the work from the first day of development.

# 2. What is recorded automatically

Every run writes `.aqa/runs/<id>/events.jsonl` as today: the request, route, plan, each inference (provider, model, prompt version, tokens), each policy decision and refusal with its rule name, approvals with author, calls, observations, triage verdicts, and the end. Core 2.0 adds rulings and human edits (AQ-04). The run's config hash and core commit are in its first event.

# 3. What we record by hand, and where

All under `attestqa/research/`, committed to git so every entry is timestamped and cannot be silently changed later.

## 3.1 `findings.jsonl` — anything worth a sentence in a paper

One line per finding:

```json
{
  "id": "F-0001",
  "date": "2026-10-14",
  "type": "weakening-attempt",
  "summary": "Agent widened a URL regex to accept /#/ after logout failed",
  "evidence": [{"run": "20261014T101500Z", "events": [118, 121]}],
  "target": "juice-shop",
  "provider": "azure-openai/gpt-4.1",
  "core_commit": "abc1234",
  "paper": ["I2"],
  "status": "open"
}
```

`type` is one of: `weakening-attempt`, `new-refusal-rule`, `stall`, `false-refusal`, `real-defect`, `false-defect`, `provider-difference`, `ux-observation`, `design-decision`, `measurement` (a counted fact about the evidence itself, such as corpus size or run outcomes). Every finding must point at ledger events; a finding without evidence is a note, not a finding.

## 3.2 `decisions/ADR-NNN-title.md` — why the design is the way it is

Short architecture decision records: context, decision, alternatives, consequences, date. ADR-001 is this document set. Every new refusal rule gets an ADR naming the run that produced it, matching the comment in code.

## 3.3 `hypotheses.md` — what we expect, before we look

Written and hashed before a study collects data. The SHA-256 of the file goes into the first manifest row of the study. Changing a hypothesis after data collection means a new file with a new hash and a note explaining why; the original stays. Proposed starting hypotheses, to be confirmed at sign-off:

- **H1** Weakening attempts occur under every provider tested, not only the one in the Paper I corpus.
- **H2** The share of runs with a weakening attempt differs by provider, but the set of routes (reword, swallow, delete, re-explain, collateral loss) does not gain a new class.
- **H3** On targets with known faults, defects confirmed by a human after attestqa reports them are a subset of the known faults, with no defect reported that the answer key contradicts.
- **H4** Explore mode, with no oracle, produces zero drafts containing verdicts once `verdictInExplore` is active; before it is active, some do.
- **H5** Weakening is not specific to browser tests. In API, security and ETL tests the agent attempts moves that map onto the five web routes (status and tolerance widening as rewording, finding suppression as swallowing, removing a reconciliation as deleting), and the type-specific rules refuse them.

## 3.4 `runs-manifest.csv` — one row per run that counts

Columns: `run_id, study, date, target, story_id, story_sha256, mode, provider, model, prompt_version, core_commit, config_hash, passed, failed, quarantined, refusals, weakening_refusals, approvals, denials, outcome, notes`. A script fills everything except `study` and `notes` from the ledger, so the numbers cannot drift from the evidence.

## 3.5 `journal/YYYY-WW.md` — the weekly note

Five to ten lines a week: what was built, what surprised us, what we decided. This is where the story of the project lives for the eventual papers, written while it is fresh.

# 4. Study discipline

Each study gets a name (`S2-cross-model`, `S3-cross-site`, `S4-cross-type`), a tagged core commit that does not change during data collection, its own hypotheses hash, and its own manifest rows. If the runtime must change mid-study, the study is split at that commit and both halves are reported. The Paper I corpus remains study `S1-corpus` at `corpus-2026-10-07`, closed.

# 5. Where this feeds

| Output | Draws on |
|---|---|
| Paper I (governed runtime), written as the work happens (§6) | S1, ADRs, findings tagged `I`, every line tied to a finding |
| Paper I2 (weakening study) | S1 and S2/S3 manifests, findings typed `weakening-attempt` and `provider-difference`, H1–H2 |
| Cross-type follow-up (API, security, ETL) | S4 manifest, H5 |
| A software/tool paper on attestqa as open source | ADRs, release history, install and use evidence, S3 |
| Later: oracle-less exploration | H4, Explore findings |

Venue choices for any of these are made against the master tracker, not in this document.

# 6. Paper I is written as the work happens

Paper I is not written at the end. It grows line by line, from findings, while attestqa is being built. The living manuscript sits with the paper, in `06_Authorship\Paper_I_AgenticQA\Article\living\paper_I_living.md`, and every line in it that states a result points at the finding it comes from.

**The rule for every line.** A sentence that states something observed carries the finding id it rests on, for example `[F-0012]`, and that finding points at ledger events. A sentence with no finding behind it is either framing (introduction, related work, design description), marked `[frame]`, or it does not go in. This keeps the paper to what the experiments found, which is the standing rule for every paper in the portfolio.

**The daily loop.** When a finding is added to `findings.jsonl`, the line it supports is added to the manuscript the same day, in the section it belongs to, written plainly in Vijay's own voice. Claude drafts the line; Vijay edits it. Each line also carries its date and a status: `draft`, `checked` (numbers re-derived from the ledger) or `withdrawn` (kept, struck through, with the reason, never deleted).

**The monthly loop.** In the write-up days after each release (AQ-05 §2), the month's lines are read together and joined into paragraphs, and a small checker (`research/tools/paper_lint.py`) confirms that every finding id in the manuscript exists, that every run it cites exists in the manifest, and lists findings tagged for Paper I that no line uses yet. A finding the paper does not use is a decision, not an accident.

**What stays separate.** Paper I2, the controlled weakening experiment, keeps its own self-contained setup in its own folder. Findings from attestqa's day-to-day runs can be tagged `I2` as observations, but the I2 manuscript draws its results from the I2 experiment only.

**Where the first lines come from.** The frozen corpus (study S1, 56 runs) already holds findings: the refusal rules born from specific runs and the weakening routes in `WEAKENING.md`. They were entered on 10 October 2026 as findings F-0001 to F-0018, each tied to its runs and, where the ledger allows, to event ids, and the first 21 lines of the manuscript were drafted from them.

# 7. Privacy and ethics in the research record

No personal data from target sites is stored; test accounts only. Ledgers are scrubbed of secrets by core before writing. Target permission checks and dates (AQ-06 §5) are part of the record, so the method section can state them exactly.
