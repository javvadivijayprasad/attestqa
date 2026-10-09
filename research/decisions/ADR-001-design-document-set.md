# ADR-001 — Design document set before development

Date: 2026-10-09 · Status: accepted — approved by Vijay on 10 October 2026 (design set at v1.6, 27 decisions)

## Context
agentic-qa (Paper I) is frozen at `f2771d4` / `corpus-2026-10-07`. The next step is a product: an open-source Windows app, then a web version, with bring-your-own model. Paper I showed how much effort it takes to rebuild the reasoning behind a design after the fact.

## Decision
Write and sign AQ-00 to AQ-08 (product, design and UI prototype, HLD, LLD, implementation plan, local test strategy and targets, migration and packaging, research logging) before any code in the new repository. Keep the research log from day one.

## Alternatives
Start coding the Electron shell straight away and document later. Rejected: the decisions about ledger format (D7), credential storage (D5) and repository layout (D2) are expensive to change once code depends on them.

## Consequences
Development starts after sign-off. Any change to a signed decision is a new ADR.
