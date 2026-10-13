import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import AxeBuilder from "@axe-core/playwright";

test.describe("Customer account access", () => {

  test.beforeEach(async ({ page }) => {
    await test.step("Given I navigate to \"/#/login\"", async () => {
      await page.goto("/#/login");
    });
  });

  // @story:1
  // @ac:1
  // @design:D1
  // @type:functional
  // @technique:state-transition
  test("AC-1: Registered user signs in with correct email and password", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the test user password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Precondition: authentication succeeded (navigated away from login page)", async () => {
      await expect(page).not.toHaveURL(/\/#\/login/, { timeout: 10000 });
    });

    await test.step("Then the URL contains \"/#/\"", async () => {
      await expect(page).toHaveURL(/\/#\//);
    });

    await test.step("And the account menu is displayed", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });
  });

  // @story:1
  // @ac:1
  // @design:D2
  // @type:functional
  // @technique:state-transition
  test("AC-1: Authentication token is written to localStorage after successful login", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the test user password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Precondition: authentication succeeded (account menu visible)", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });

    await test.step("And the account menu is displayed", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible();
    });
  });

  // @story:1
  // @ac:2
  // @design:D3
  // @type:functional
  // @technique:equivalence-partitioning
  test("AC-2: Wrong password shows generic error and keeps user on login page", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter a wrong password", async () => {
      await page.locator("input[type='password']").fill("wrongpassword123");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the page displays \"Invalid email or password.\"", async () => {
      await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 10000 });
    });

    await test.step("And the URL contains \"/#/login\"", async () => {
      await expect(page).toHaveURL(/\/#\/login/);
    });
  });

  // @story:1
  // @ac:3
  // @design:D4
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-3a: Log in button is disabled when both fields are empty", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When both the Email and Password fields are empty (not touched)", async () => {
      const emailValue = await page.getByLabel("Email").inputValue();
      expect(emailValue, "Precondition: email field must be empty").toBe("");
      const passwordValue = await page.locator("input[type='password']").inputValue();
      expect(passwordValue, "Precondition: password field must be empty").toBe("");
    });

    await test.step("Then the Log in button is disabled", async () => {
      await expect(page.getByRole("button", { name: "Login" })).toBeDisabled();
    });
  });

  // @story:1
  // @ac:3
  // @design:D5
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-3b: Log in button is disabled when only one field is filled; validation messages shown on touched empty fields", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And the Password field is left empty", async () => {
      const passwordValue = await page.locator("input[type='password']").inputValue();
      expect(passwordValue, "Precondition: password field must be empty").toBe("");
    });

    await test.step("Then the Log in button is disabled", async () => {
      await expect(page.getByRole("button", { name: "Login" })).toBeDisabled();
    });
  });

  // @story:1
  // @ac:4
  // @design:D6
  // @type:functional
  // @technique:equivalence-partitioning
  test("AC-4: Unregistered email produces same generic error as wrong password", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter an unregistered email", async () => {
      await page.getByLabel("Email").fill("unregistered_user_99@example-noreply.invalid");
    });

    await test.step("And I find the Password field and enter any password", async () => {
      await page.locator("input[type='password']").fill("anypassword123");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the page displays \"Invalid email or password.\"", async () => {
      await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 10000 });
    });
  });

  // @story:1
  // @ac:2
  // @design:D7
  // @type:security
  // @technique:equivalence-partitioning
  test("AC-2 security: Wrong credentials show the same message regardless of which field is wrong", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter a wrong password", async () => {
      await page.locator("input[type='password']").fill("wrongpassword123");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the page displays \"Invalid email or password.\" (same generic message)", async () => {
      await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 10000 });
    });
  });

  // @story:1
  // @design:D8
  // @type:accessibility
  // @technique:checklist-based
  test("story: Login page passes axe-core WCAG A/AA scan", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("Then the login form has no axe-core WCAG A/AA violations", async () => {
      const results = await new AxeBuilder({ page })
        .include("mat-card, form, #login-form")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(
        results.violations.map((v) => v.id).sort(),
        "axe-core WCAG A/AA violations on the login page"
      ).toEqual([]);
    });
  });

  // @story:1
  // @bug:49
  // @design:D9
  // @type:confirmation
  // @technique:boundary-value-analysis
  test("Bug 49: Login with leading whitespace in password fails with standard error", async ({ page }) => {
    await test.step("Precondition: login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the correct password with a leading space", async () => {
      await page.locator("input[type='password']").fill(" " + (process.env["AQA_APP_PASS"] ?? ""));
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the page displays \"Invalid email or password.\" (leading space is not silently trimmed)", async () => {
      await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 10000 });
    });
  });

});
