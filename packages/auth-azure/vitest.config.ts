import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `attestqa` resolves to the core package's SOURCE during tests and typecheck,
// so the plug-in builds and tests without the core having been compiled first.
// At runtime the built plug-in imports the published `attestqa` from node_modules.
export default defineConfig({
  resolve: {
    alias: {
      attestqa: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
