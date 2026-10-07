/**
 * Epic 42 — Customer account access
 * Generated from: examples/sample-project/features/epic-42-customer-account-access.feature
 *
 * NOTE: The accessibility scenario (D7) requires @axe-core/playwright which is
 * not installed in this project. That test is marked fixme and excluded from
 * the run. Installing the dependency is a person's decision.
 */
import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Story 1 — Login with valid credentials
// ---------------------------------------------------------------------------

const BASE = process.env["AQA_APP_URL"] ?? "http://localhost:3100";

test.describe("Customer account access", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE + "/#/login");
    // Dismiss the welcome banner if present
    const dismissBtn = page.locator('button:has-text("Dismiss"), button[aria-label="Close Welcome Banner"]');
    if (await dismissBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await dismissBtn.click();
    }
    // Dismiss cookie consent if present
    const cookieBtn = page.locator('button:has-text("Me want it!")');
    if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cookieBtn.click();
    }
  });

  // -------------------------------------------------------------------------
  // @story:1 @ac:1 @design:D1
  // AC-1: A registered user who submits their correct email and password is
  // signed in: the account menu shows their email address and offers Logout.
  // -------------------------------------------------------------------------
  test("AC-1: Registered user signs in with correct email and password", async ({ page }) => {
    // @story:1 @ac:1 @design:D1

    // Precondition: verify credentials are configured
    const appUser = process.env["AQA_APP_USER"];
    const appPass = process.env["AQA_APP_PASS"];
    expect(appUser, "AQA_APP_USER must be set").toBeTruthy();
    expect(appPass, "AQA_APP_PASS must be set").toBeTruthy();

    // Act
    await page.locator("#email").fill(appUser!);
    await page.locator("#password").fill(appPass!);

    // Intercept the login response to verify precondition (credentials correct)
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/rest/user/login") && r.request().method() === "POST"),
      page.locator("#loginButton").click(),
    ]);
    expect(response.status(), "Login endpoint should return 200 — if 401, check AQA_APP_USER/AQA_APP_PASS").toBe(200);

    // Assert: URL leaves login page
    await expect(page).not.toHaveURL(/\/#\/login/);

    // Assert: account menu shows signed-in state
    const accountMenuBtn = page.getByRole("button", { name: /account/i });
    await expect(accountMenuBtn).toBeVisible();
    await accountMenuBtn.click();

    // The account menu should show the user's email and a Logout option
    await expect(page.getByText(appUser!)).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /logout/i })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // @story:1 @ac:2 @design:D2
  // AC-2: Submitting a valid email with an incorrect password keeps the user
  // on the login page and shows "Invalid email or password."
  // -------------------------------------------------------------------------
  test("AC-2: Wrong password shows generic error and keeps user on login page", async ({ page }) => {
    // @story:1 @ac:2 @design:D2

    const appUser = process.env["AQA_APP_USER"];
    expect(appUser, "AQA_APP_USER must be set").toBeTruthy();

    await page.locator("#email").fill(appUser!);
    await page.locator("#password").fill("WrongPassword!99");
    await page.locator("#loginButton").click();

    // Assert: stays on login page
    await expect(page).toHaveURL(/\/#\/login/);

    // Assert: generic error message shown
    await expect(page.getByText("Invalid email or password.").first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // @story:1 @ac:3 @design:D3
  // AC-3a: The Log in button is disabled while the email field is empty;
  // a touched and left-empty email field shows "Please provide an email address."
  // -------------------------------------------------------------------------
  test("AC-3a: Touched email field left empty shows validation message and Log in button is disabled", async ({ page }) => {
    // @story:1 @ac:3 @design:D3

    // Touch the email field and leave it empty (focus then blur)
    await page.locator("#email").focus();
    await page.locator("#password").focus(); // blur the email field

    // Assert: Log in button is disabled
    await expect(page.locator("#loginButton")).toBeDisabled();

    // Assert: validation message for email field
    await expect(page.getByText("Please provide an email address.").first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // @story:1 @ac:3 @design:D3
  // AC-3b: The Log in button is disabled while the password field is empty;
  // a touched and left-empty password field shows "Please provide a password."
  // -------------------------------------------------------------------------
  test("AC-3b: Touched password field left empty shows validation message and Log in button is disabled", async ({ page }) => {
    // @story:1 @ac:3 @design:D3

    const appUser = process.env["AQA_APP_USER"];
    expect(appUser, "AQA_APP_USER must be set").toBeTruthy();

    // Fill email (valid), touch password and leave empty
    await page.locator("#email").fill(appUser!);
    await page.locator("#password").focus();
    await page.locator("#email").focus(); // blur the password field

    // Assert: Log in button is disabled
    await expect(page.locator("#loginButton")).toBeDisabled();

    // Assert: validation message for password field
    await expect(page.getByText("Please provide a password.").first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // @story:1 @ac:4 @design:D4
  // AC-4: An unregistered email with any password produces the same
  // "Invalid email or password." message — no account-existence disclosure.
  // -------------------------------------------------------------------------
  test("AC-4: Unregistered email produces same generic error as wrong password", async ({ page }) => {
    // @story:1 @ac:4 @design:D4

    await page.locator("#email").fill("notregistered_aqa@example.com");
    await page.locator("#password").fill("SomePassword123!");
    await page.locator("#loginButton").click();

    // Assert: stays on login page
    await expect(page).toHaveURL(/\/#\/login/);

    // Assert: same generic error message — no disclosure of account existence
    await expect(page.getByText("Invalid email or password.").first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // @story:1 @ac:2 @design:D5 @bug:48
  // Bug #48 [Active]: Error message persists after successful login following
  // a failed attempt. EXPECTED TO FAIL.
  // -------------------------------------------------------------------------
  test("AC-2 / Bug-48: Error message clears after a successful login following a failed attempt", async ({ page }) => {
    // @story:1 @ac:2 @design:D5 @bug:48
    test.fail(true, "Bug #48 Active: Error message persists after the email is corrected");

    const appUser = process.env["AQA_APP_USER"];
    const appPass = process.env["AQA_APP_PASS"];
    expect(appUser, "AQA_APP_USER must be set").toBeTruthy();
    expect(appPass, "AQA_APP_PASS must be set").toBeTruthy();

    // Step 1: fail once
    await page.locator("#email").fill(appUser!);
    await page.locator("#password").fill("WrongPassword!99");
    await page.locator("#loginButton").click();
    await expect(page.getByText("Invalid email or password.").first()).toBeVisible();

    // Step 2: correct the password and log in successfully
    await page.locator("#password").fill(appPass!);

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/rest/user/login") && r.request().method() === "POST"),
      page.locator("#loginButton").click(),
    ]);
    expect(response.status(), "Login endpoint should return 200").toBe(200);

    // Assert: URL leaves login page
    await expect(page).not.toHaveURL(/\/#\/login/);

    // Assert: error message must not persist (this is what Bug #48 says fails)
    await expect(page.getByText("Invalid email or password.").first()).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // @story:1 @design:D6 (security: AC-2 & AC-4 use same message)
  // Security: no account-enumeration disclosure.
  // Covered structurally by AC-2 (D2) and AC-4 (D4) which both assert the
  // same "Invalid email or password." message. No separate test is needed
  // because D2 exercises wrong-password-known-account and D4 exercises
  // unknown-account — both produce the identical message verified in those
  // tests. This comment records the coverage decision.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // @story:1 @design:D7 (accessibility)
  // Accessibility: @axe-core/playwright is NOT installed in this project.
  // The axe-core WCAG A/AA scan cannot be run without it.
  // This test is marked fixme; installing the dependency is a person's decision.
  // -------------------------------------------------------------------------
  test.fixme("Accessibility — login page passes axe-core WCAG A/AA scan", async ({ page }) => {
    // @story:1 @design:D7
    // Cannot run: @axe-core/playwright is not installed.
    // To enable: npm install --save-dev @axe-core/playwright, then implement this test.
  });
});
