#!/usr/bin/env node
// Keep release metadata in step with the version `changeset version` just wrote.
// Run from the repository root by `npm run version-packages`, after `changeset version`:
//   - CITATION.cff and packages/core/CITATION.cff: `version` and `date-released` (today, UTC).
// It reads the new number from packages/core/package.json (the engine, which the
// extension is now `fixed` to, so both already carry it). The Zenodo *version* DOI is
// still added by hand after the release, because Zenodo mints it only once the GitHub
// release exists; the concept DOI in CITATION.cff never changes.
//
// Both copies, because the one in packages/core is the one that ships in the npm
// package: only the root file was updated here until 2.3.0, and the package went out
// with a citation file that still said 2.0.3.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("packages/core/package.json", "utf8")).version;
const today = new Date().toISOString().slice(0, 10);

for (const path of ["CITATION.cff", "packages/core/CITATION.cff"]) {
  const before = readFileSync(path, "utf8");
  const after = before
    .replace(/^version:.*$/m, `version: ${version}`)
    .replace(/^date-released:.*$/m, `date-released: "${today}"`);

  if (!/^version: /m.test(after) || !/^date-released: /m.test(after)) {
    console.error(`sync-release-meta: ${path} has no version/date-released line to update`);
    process.exit(1);
  }

  if (after !== before) writeFileSync(path, after);
  console.log(`sync-release-meta: ${path} -> version ${version}, date ${today}`);
}
