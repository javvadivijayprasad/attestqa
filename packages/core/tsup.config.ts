import { execSync } from "node:child_process";
import { defineConfig } from "tsup";

/**
 * The git commit this engine is built from, stamped into the CLI so every run's
 * ledger can name the exact code that produced it — including evaluation runs
 * of an unreleased build, whose package.json version alone would be wrong.
 * "+dirty" when the engine's source has uncommitted changes; "unknown" outside
 * a git checkout (for example a build from the npm tarball).
 */
function commit(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain -- src package.json", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node18",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    sourcemap: true,
    target: "node18",
    banner: { js: "#!/usr/bin/env node" },
    define: { __AQA_COMMIT__: JSON.stringify(commit()) },
  },
]);
