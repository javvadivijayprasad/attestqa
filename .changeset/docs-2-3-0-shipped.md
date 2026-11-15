---
"attestqa": patch
---

Record that 2.3.0 shipped. `VERSIONS.md` now shows 2.3.0 as current (npm and the Marketplace, 15 Nov 2026), records its Zenodo DOI (10.5281/zenodo.24249907) and names `release/2.4.0` as the branch the next version is built on; `ROADMAP.md` moves 2.3.0 from planned to shipped. The `CITATION.cff` inside the npm package had not been updated since 2.0.3: it now matches the repository's, and the release script keeps both in step. Docs and release tooling only; no change to the package's behaviour.
