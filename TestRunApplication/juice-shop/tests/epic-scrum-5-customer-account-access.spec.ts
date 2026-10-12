import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import AxeBuilder from "@axe-core/playwright";

test.describe("Customer account access", () => {

  test.beforeEach(async ({ page }) => {
    await test.step("Given I navigate to \"/#/login\"", async () => {
      await page.goto("/#/login");
    });

    await test.step("Dismiss cookie consent if present", async () => {
      const dismissBtn = page.getByRole("button", { name: "dismiss cookie message" });
      await dismissBtn.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      if (await dismissBtn.isVisible()) {
        await dismissBtn.click();
      }
    });

    await test.step("Dismiss welcome banner if present", async () => {
      const closeBtn = page.getByRole("button", { name: "Close Welcome Banner" });
      await closeBtn.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      }
    });
  });

  // @story:SCRUM-8
  // @ac:1
  // @design:D1
  // @type:functional
  // @technique:state-transition
  test("AC-1: Choosing Account > Logout signs the customer out and Account menu offers Login again", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the test user password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the account menu is displayed (login succeeded)", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });

    await test.step("When I click Account", async () => {
      await page.getByRole("button", { name: "Show/hide account menu" }).click();
    });

    await test.step("And I click Logout", async () => {
      await page.getByRole("menuitem", { name: "Logout" }).click();
    });

    await test.step("Then the page displays Login", async () => {
      // AC-1: "Account menu then offers Login again" — open the menu and assert the Login menuitem is present
      await page.getByRole("button", { name: "Show/hide account menu" }).click();
      await expect(page.getByRole("menuitem", { name: "Login" })).toBeVisible();
    });
  });

  // @story:SCRUM-8
  // @ac:2
  // @design:D2
  // @type:functional
  // @technique:state-transition
  test("AC-2: After logout the browser returns to the storefront home page", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the test user password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      // @bdd2pw lane=rule rule=rule-30
      await loginPage.loginButton.click();
    });

    await test.step("Then the account menu is displayed (login succeeded)", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });

    await test.step("When I click Account", async () => {
      await page.getByRole("button", { name: "Show/hide account menu" }).click();
    });

    await test.step("And I click Logout", async () => {
      await page.getByRole("menuitem", { name: "Logout" }).click();
    });

    await test.step("Then the URL contains \"/#/\"", async () => {
      // @bdd2pw lane=rule rule=rule-39
      await expect(page).toHaveURL(new RegExp("/#/"));
    });
  });

  // @story:SCRUM-8
  // @ac:1
  // @design:D3
  // @type:security
  // @technique:state-transition
  test("AC-1: After logout the authentication token is removed from the browser", async ({ page }, testInfo) => {
    const loginPage = new LoginPage(page);

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the test user password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      // @bdd2pw lane=rule rule=rule-30
      await loginPage.loginButton.click();
    });

    await test.step("Then the account menu is displayed (login succeeded)", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });

    await test.step("Then the authentication token is present in localStorage after login", async () => {
      // Wait up to 5 s for the app to write the token to localStorage after the Angular response handler runs
      await page.waitForFunction(
        () => window.localStorage.getItem("token") !== null,
        { timeout: 5000 }
      );
      const token = await page.evaluate(() => window.localStorage.getItem("token"));
      expect(token, "Precondition: token must be present in localStorage after login").not.toBeNull();
    });

    await test.step("When I click Account", async () => {
      await page.getByRole("button", { name: "Show/hide account menu" }).click();
    });

    await test.step("And I click Logout", async () => {
      await page.getByRole("menuitem", { name: "Logout" }).click();
    });

    await test.step("Then the Logout action completed (URL changed away from pre-logout page)", async () => {
      await expect(page).toHaveURL(new RegExp("/#/"), { timeout: 10000 });
    });

    await test.step("Then local storage does not contain token", async () => {
      const token = await page.evaluate(() => window.localStorage.getItem("token"));
      expect(token, "Authentication token should be removed from localStorage after logout").toBeNull();
    });
  });

  // @story:SCRUM-8
  // @ac:1
  // @design:D4
  // @type:accessibility
  // @technique:checklist-based
  test("AC-1: Storefront pages involved in sign-out pass axe-core WCAG A/AA scan", async ({ page }, testInfo) => {
    await test.step("Then the login page has no axe violations", async () => {
      const results = await new AxeBuilder({ page })
        .include("#login-form, mat-card, form")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(
        results.violations.map((v) => v.id).sort(),
        "axe-core WCAG A/AA violations on the login page"
      ).toEqual([]);
    });
  });

  // @story:SCRUM-8
  // @bug:SCRUM-12
  // @design:D5
  // @type:confirmation
  // @technique:state-transition
  test("Bug SCRUM-12: Session token is still accepted by the server after logout", async ({ page }) => {
    test.fail(true, "Bug #SCRUM-12 Active: Session token is still accepted after logout");

    await test.step("When I find the Email field and enter the test user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the test user password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the account menu is displayed (login succeeded)", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });

    await test.step("Capture the session token from localStorage", async () => {
      // Wait for the token to be written
      await page.waitForFunction(
        () => window.localStorage.getItem("token") !== null,
        { timeout: 5000 }
      );
    });

    const token = await page.evaluate(() => window.localStorage.getItem("token"));
    expect(token, "Precondition: token must be present in localStorage after login").not.toBeNull();

    await test.step("When I click Account", async () => {
      await page.getByRole("button", { name: "Show/hide account menu" }).click();
    });

    await test.step("And I click Logout", async () => {
      await page.getByRole("menuitem", { name: "Logout" }).click();
    });

    await test.step("Then the Logout action completed (URL changed)", async () => {
      await expect(page).toHaveURL(new RegExp("/#/"), { timeout: 10000 });
    });

    await test.step("Then the session token is rejected by the server after logout", async () => {
      // Make an authenticated API call with the captured token.
      // If the server correctly invalidates the token on logout, it should return 401.
      // Bug SCRUM-12: the server still accepts the token (returns 200 instead of 401).
      const response = await page.request.get("/api/Users/whoami", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(
        response.status(),
        "Server should reject the token after logout (401), but it is still accepted — Bug SCRUM-12"
      ).toBe(401);
    });
  });
});
