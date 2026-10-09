# ADR-002 — Engine tags use the package name; product tags use v-numbers

Date: 2026-10-10 · Status: accepted

## Context
The engine is already published on npm with its own versions (0.1.x as @vijaypjavvadi/agentic-qa, 1.1.0 as attestqa), and becomes 2.0.0 inside product release v1.0.0. Product releases are tagged v1.0.0, v1.1.0 … (D22). Once the monorepo and the old repository share one GitHub repository, an engine tag `v1.1.0` (October 2026) would collide with product release v1.1.0 (December 2026).

## Decision
Engine and package tags use the Changesets form `<package>@<version>`: `attestqa@1.1.0`, `attestqa@2.0.0`, `@attestqa/ui@0.1.0`. Plain `vX.Y.Z` tags are product releases only. The existing `v0.1.1` and `v0.1.2` tags stay as they are.

## Consequences
GitHub releases and Zenodo DOIs are made for product tags. Package tags exist for traceability and npm provenance.
