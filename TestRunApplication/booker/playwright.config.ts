import { defineConfig, devices } from "@playwright/test";

/**
 * The application's address comes from AQA_APP_URL in the .env file, and from
 * nowhere else: not a default here, not a literal in a page object. A missing
 * value stops the run instead of quietly testing some other address.
 */
const appUrl = process.env["AQA_APP_URL"];
if (!appUrl)
  throw new Error(
    "AQA_APP_URL is not set. Put the application's address in the .env file the run uses " +
      '(attestqa: --env ".env.<app>,.env"; plain Playwright: set AQA_APP_URL in the shell).',
  );

/**
 * The agent's workspace for Restful-Booker Platform (research/EVALUATION_PLAN.md).
 *
 * The application lives at `AQA_APP_URL` (http://localhost:3003 by default). The address is
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
    baseURL: appUrl,
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
