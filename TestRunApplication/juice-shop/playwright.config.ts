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
 * The agent's workspace for the sandbox run (PLAN §1 A8).
 *
 * The application under test lives at `AQA_APP_URL` — OWASP Juice Shop on
 * localhost by default. The address is HERE and nowhere else: generated specs
 * navigate relatively (`page.goto("/#/login")`) so that the same suite runs
 * against a different host without editing a single test. Credentials come from
 * the environment for the same reason, and because a password in a spec file is
 * a password in git.
 */
export default defineConfig({
  testDir: "tests",
  // The agent runs this suite through `pw.run_tests`, which reads the JSON
  // reporter from stdout. Keep retries at 0: a flaky pass is worse than a
  // failure here, because the verifier treats green as evidence.
  retries: 0,
  reporter: process.env["CI"] ? "line" : "list",
  use: {
    baseURL: appUrl,
    // Juice Shop opens a welcome banner over a cookie bar on every fresh
    // browser; the banner swallows clicks meant for anything under it. Both
    // remember "dismissed" in a cookie, so every test starts with those two
    // cookies set and neither pop-up appears. Environment setup, not a test
    // step: nothing here changes what a test checks.
    storageState: "juice-shop.storage.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The Chrome already installed on this machine, not Playwright's bundled
  // Chromium. PW_CHANNEL=msedge uses Edge; PW_CHANNEL=chromium uses the bundled
  // build (what CI runners without Chrome need).
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
