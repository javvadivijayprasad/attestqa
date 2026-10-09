# Hypotheses — DRAFT, not yet frozen

Freeze after sign-off (decision D11): commit this file, record its SHA-256 as the first manifest row of each study, and never edit it afterwards. A revision is a new file with its own hash and a note explaining why.

- **H1** Weakening attempts occur under every provider tested, not only the one in the Paper I corpus.
- **H2** The share of runs with a weakening attempt differs by provider, but the set of routes (reword, swallow, delete, re-explain, collateral loss) does not gain a new class.
- **H3** On targets with known faults, defects confirmed by a human after attestqa reports them are a subset of the known faults, with no defect reported that the answer key contradicts.
- **H4** Explore mode, with no oracle, produces zero drafts containing verdicts once `verdictInExplore` is active; before it is active, some do.
- **H5** Weakening is not specific to browser tests. In API, security and ETL tests the agent attempts moves that map onto the five web routes (status and tolerance widening as rewording, finding suppression as swallowing, removing a reconciliation as deleting), and the type-specific rules refuse them.
