import { defineConfig, devices } from "@playwright/test";

/**
 * The agent's workspace for Toolshop (research/EVALUATION_PLAN.md).
 *
 * The application lives at `AQA_APP_URL` (http://localhost:4200 by default). The address is
 * HERE and nowhere else: generated specs navigate relatively, so the same suite
 * runs against another host (or a seeded-fault build) without editing a test.
 * Credentials come from the environment, never from a spec.
 */
export default defineConfig({
  testDir: "tests",
  // pw.run_tests reads the JSON reporter; keep retries at 0, because the
  // verifier treats green as evidence and a flaky pass is not.
  retries: 0,
  reporter: process.env["CI"] ? "line" : "list",
  use: {
    baseURL: process.env["AQA_APP_URL"] ?? "http://localhost:4200",
    // Toolshop marks its elements with data-test, not data-testid, so getByTestId
    // ("product-price") finds them.
    testIdAttribute: "data-test",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The installed Chrome; PW_CHANNEL=msedge for Edge, PW_CHANNEL=chromium for
  // Playwright's bundled build.
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env["PW_CHANNEL"] === "chromium"
          ? {}
          : { channel: process.env["PW_CHANNEL"] ?? "chrome" }),
      },
    },
  ],
});
