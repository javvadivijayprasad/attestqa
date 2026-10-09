import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/login.page";

test.describe("Customer account access", () => {

  test.beforeEach(async ({ page }) => {
    const loginPage = new LoginPage(page);

    await test.step("Given I navigate to \"/#/login\"", async () => {
      await loginPage.goto();
    });
  });

  // @story:1
  // @ac:1
  // @design:D1
  test("AC-1: Registered user signs in with correct email and password", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("[SKIPPED] When I find the Email field and enter \"[AQA_APP_USER]\"", async () => {
      // TODO: no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
    });

    await test.step("[SKIPPED] And I find the Password field and enter \"[AQA_APP_PASS]\"", async () => {
      // TODO: no rule matched: "And I find the Password field and enter "[AQA_APP_PASS]""
    });

    await test.step("And Click the \"Log in\" button", async () => {
      await loginPage.loginButton.click();
    });

    await test.step("[SKIPPED] Then the URL does not contain \"/#/login\"", async () => {
      // TODO: no rule matched: "Then the URL does not contain "/#/login""
    });

    await test.step("[SKIPPED] Then the account menu is displayed", async () => {
      // TODO: ambiguous visibility step: no POM field matched "the account menu". Add a locator field to the POM, or hand-edit the spec to point at the right element. (bdd2pw will not synthesise a URL regex from a prose noun — that produced always-failing tests in v3.0.0 and earlier.)
    });
  });

  // @story:1
  // @ac:2
  // @design:D2
  test("AC-2: Wrong password shows generic error and keeps user on login page", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("[SKIPPED] When I find the Email field and enter \"[AQA_APP_USER]\"", async () => {
      // TODO: no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
    });

    await test.step("[SKIPPED] And I find the Password field and enter \"WrongPassword!99\"", async () => {
      // TODO: no rule matched: "And I find the Password field and enter "WrongPassword!99""
    });

    await test.step("And Click the \"Log in\" button", async () => {
      await loginPage.loginButton.click();
    });

    await test.step("Then the URL contains \"/#/login\"", async () => {
      await expect(loginPage.page).toHaveURL(new RegExp("/#/login"));
    });

    await test.step("Then the page displays \"Invalid email or password.\"", async () => {
      await expect(loginPage.page.getByText("Invalid email or password.").first()).toBeVisible();
    });
  });

  // @story:1
  // @ac:3
  // @design:D3
  test("AC-3a: Touched email field left empty shows validation message and Log in button is disabled", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("When I leave the Email field empty", async () => {
      // intentionally left empty: Email
    });

    await test.step("[SKIPPED] Then the Log in button is disabled", async () => {
      // TODO: no rule matched: "Then the Log in button is disabled"
    });

    await test.step("Then the page displays \"Please provide an email address.\"", async () => {
      await expect(loginPage.page.getByText("Please provide an email address.").first()).toBeVisible();
    });
  });

  // @story:1
  // @ac:3
  // @design:D3
  test("AC-3b: Touched password field left empty shows validation message and Log in button is disabled", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("[SKIPPED] When I find the Email field and enter \"[AQA_APP_USER]\"", async () => {
      // TODO: no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
    });

    await test.step("And I leave the Password field empty", async () => {
      // intentionally left empty: Password
    });

    await test.step("[SKIPPED] Then the Log in button is disabled", async () => {
      // TODO: no rule matched: "Then the Log in button is disabled"
    });

    await test.step("Then the page displays \"Please provide a password.\"", async () => {
      await expect(loginPage.page.getByText("Please provide a password.").first()).toBeVisible();
    });
  });

  // @story:1
  // @ac:4
  // @design:D4
  test("AC-4: Unregistered email produces same generic error as wrong password", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("[SKIPPED] When I find the Email field and enter \"notregistered_qa_9x7z@example.com\"", async () => {
      // TODO: no rule matched: "When I find the Email field and enter "notregistered_qa_9x7z@example.com""
    });

    await test.step("[SKIPPED] And I find the Password field and enter \"SomePassword123!\"", async () => {
      // TODO: no rule matched: "And I find the Password field and enter "SomePassword123!""
    });

    await test.step("And Click the \"Log in\" button", async () => {
      await loginPage.loginButton.click();
    });

    await test.step("Then the URL contains \"/#/login\"", async () => {
      await expect(loginPage.page).toHaveURL(new RegExp("/#/login"));
    });

    await test.step("Then the page displays \"Invalid email or password.\"", async () => {
      await expect(loginPage.page.getByText("Invalid email or password.").first()).toBeVisible();
    });
  });

  // @story:1
  // @ac:2
  // @design:D5
  // @bug:48
  test("AC-2 / Bug-48: Error message clears after a successful login following a failed attempt", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("[SKIPPED] When I find the Email field and enter \"[AQA_APP_USER]\"", async () => {
      // TODO: no rule matched: "When I find the Email field and enter "[AQA_APP_USER]""
    });

    await test.step("[SKIPPED] And I find the Password field and enter \"WrongPassword!99\"", async () => {
      // TODO: no rule matched: "And I find the Password field and enter "WrongPassword!99""
    });

    await test.step("And Click the \"Log in\" button", async () => {
      await loginPage.loginButton.click();
    });

    await test.step("Then the page displays \"Invalid email or password.\"", async () => {
      await expect(loginPage.page.getByText("Invalid email or password.").first()).toBeVisible();
    });

    await test.step("[SKIPPED] When I find the Password field and enter \"[AQA_APP_PASS]\"", async () => {
      // TODO: no rule matched: "When I find the Password field and enter "[AQA_APP_PASS]""
    });

    await test.step("And Click the \"Log in\" button", async () => {
      await loginPage.loginButton.click();
    });

    await test.step("[SKIPPED] Then the URL does not contain \"/#/login\"", async () => {
      // TODO: no rule matched: "Then the URL does not contain "/#/login""
    });

    await test.step("[SKIPPED] Then the page does not display \"Invalid email or password.\"", async () => {
      // TODO: no rule matched: "Then the page does not display "Invalid email or password.""
    });
  });

  // @story:1
  // @design:D7
  test("Accessibility — login page passes axe-core WCAG A/AA scan", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("[SKIPPED] Then the page has no axe violations", async () => {
      // TODO: no rule matched: "Then the page has no axe violations"
    });
  });
});
