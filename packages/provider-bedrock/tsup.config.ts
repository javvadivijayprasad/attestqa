import { defineConfig } from "tsup";

// `attestqa` is a peer dependency, so tsup leaves it external in the bundle; the
// plug-in resolves it at runtime from the host's installed core. No .d.ts is
// shipped: the plug-in is loaded by attestqa's loader by convention (duck-typed
// on its `provider` and `factory` exports), not imported as a typed module.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node18",
});
