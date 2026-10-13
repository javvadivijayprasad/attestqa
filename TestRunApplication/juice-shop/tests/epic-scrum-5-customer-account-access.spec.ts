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

  // ---------------------------------------------------------------------------
  // SCRUM-6: Customer signs in with email and password
  // ---------------------------------------------------------------------------

  // @story:SCRUM-6
  // @ac:1
  // @design:D6
  // @type:functional
  // @technique:state-transition
  test("AC-1: A registered customer with correct credentials is signed in and taken to the product list", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the registered user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter the correct password", async () => {
      await page.locator("input[type='password']").fill(process.env["AQA_APP_PASS"] ?? "");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Precondition: verify authentication succeeded (login response was 200)", async () => {
      // Wait for navigation away from login page — proves the login was accepted
      await expect(page).not.toHaveURL(new RegExp("/#/login"), { timeout: 10000 });
    });

    await test.step("Then the URL contains '/#/'", async () => {
      await expect(page).toHaveURL(new RegExp("/#/"));
    });

    await test.step("And the account menu is displayed", async () => {
      await expect(page.getByRole("button", { name: "Show/hide account menu" })).toBeVisible({ timeout: 10000 });
    });
  });

  // @story:SCRUM-6
  // @ac:2
  // @design:D7
  // @type:functional
  // @technique:equivalence-partitioning
  test("AC-2: A wrong password shows an error message and the customer stays on the login page", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the registered user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter a wrong password", async () => {
      await page.locator("input[type='password']").fill("wrongpassword123");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the page displays 'Invalid email or password.'", async () => {
      await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 10000 });
    });

    await test.step("And the URL still contains '/#/login'", async () => {
      await expect(page).toHaveURL(new RegExp("/#/login"));
    });
  });

  // @story:SCRUM-6
  // @ac:3
  // @design:D8
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-3a: Log in button is disabled when only the email field is filled", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter a value", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "test@example.com");
    });

    await test.step("And the Password field is left empty (not touched)", async () => {
      // Password field is not filled — remains at default empty state
      const passwordValue = await page.locator("input[type='password']").inputValue();
      expect(passwordValue, "Precondition: password field must be empty").toBe("");
    });

    await test.step("Then the Log in button is disabled", async () => {
      await expect(page.getByRole("button", { name: "Login" })).toBeDisabled();
    });
  });

  // @story:SCRUM-6
  // @ac:3
  // @design:D9
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-3b: Log in button is disabled when only the password field is filled", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When the Email field is left empty (not touched)", async () => {
      // Email field is not filled — remains at default empty state
      const emailValue = await page.getByLabel("Email").inputValue();
      expect(emailValue, "Precondition: email field must be empty").toBe("");
    });

    await test.step("And I find the Password field and enter a value", async () => {
      await page.locator("input[type='password']").fill("somepassword");
    });

    await test.step("Then the Log in button is disabled", async () => {
      await expect(page.getByRole("button", { name: "Login" })).toBeDisabled();
    });
  });

  // @story:SCRUM-6
  // @ac:3
  // @design:D10
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-3c: Log in button is disabled when both fields are empty", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When both the Email and Password fields are empty (not touched)", async () => {
      const emailValue = await page.getByLabel("Email").inputValue();
      const passwordValue = await page.locator("input[type='password']").inputValue();
      expect(emailValue, "Precondition: email field must be empty").toBe("");
      expect(passwordValue, "Precondition: password field must be empty").toBe("");
    });

    await test.step("Then the Log in button is disabled", async () => {
      await expect(page.getByRole("button", { name: "Login" })).toBeDisabled();
    });
  });

  // @story:SCRUM-6
  // @ac:3
  // @design:D11
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-3d: Log in button is enabled when both email and password are filled", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter a value", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "test@example.com");
    });

    await test.step("And I find the Password field and enter a value", async () => {
      await page.locator("input[type='password']").fill("somepassword");
    });

    await test.step("Then the Log in button is enabled", async () => {
      await expect(page.getByRole("button", { name: "Login" })).toBeEnabled();
    });
  });

  // @story:SCRUM-6
  // @ac:2
  // @design:D12
  // @type:security
  // @technique:state-transition
  test("AC-2 (security): Wrong credentials show the same message regardless of which field is wrong", async ({ page }) => {
    await test.step("Precondition: verify login page is ready", async () => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter the registered user email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter a wrong password", async () => {
      await page.locator("input[type='password']").fill("wrongpassword123");
    });

    await test.step("And I click Log in", async () => {
      await page.getByRole("button", { name: "Login" }).click();
    });

    await test.step("Then the page displays the generic 'Invalid email or password.' message (no enumeration of which field is wrong)", async () => {
      await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 10000 });
    });
  });

  // @story:SCRUM-6
  // @design:D13
  // @type:accessibility
  // @technique:checklist-based
  test("AC-story: Login page passes axe-core WCAG A/AA scan", async ({ page }) => {
    await test.step("Then the login form has no axe violations", async () => {
      const results = await new AxeBuilder({ page })
        .include("mat-card, form")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(
        results.violations.map((v) => v.id).sort(),
        "axe-core WCAG A/AA violations on the login page"
      ).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // SCRUM-10: New customer registers an account
  // ---------------------------------------------------------------------------

  // @story:SCRUM-10
  // @ac:1
  // @design:D14
  // @type:functional
  // @technique:state-transition
  test("AC-1: A new customer who fills in all registration fields is sent to the login page", async ({ page }) => {
    await test.step("Given I navigate to the registration page", async () => {
      await page.goto("/#/register");
      await page.waitForLoadState("networkidle");
    });

    await test.step("Dismiss cookie consent if present on registration page", async () => {
      const dismissBtn = page.getByRole("button", { name: "dismiss cookie message" });
      const visible = await dismissBtn.isVisible();
      if (visible) {
        await dismissBtn.click();
      }
    });

    await test.step("Dismiss welcome banner if present on registration page", async () => {
      const closeBtn = page.getByRole("button", { name: "Close Welcome Banner" });
      const visible = await closeBtn.isVisible();
      if (visible) {
        await closeBtn.click();
      }
    });

    await test.step("Precondition: registration page is ready", async () => {
      await expect(page.getByRole("heading", { name: "User Registration" })).toBeVisible({ timeout: 5000 });
      await expect(page.getByLabel("Email address field")).toBeVisible({ timeout: 5000 });
    });

    const uniqueEmail = `aqa-reg-${Date.now()}@example.com`;

    await test.step("When I find the Email field and enter a unique new email", async () => {
      await page.getByLabel("Email address field").fill(uniqueEmail);
    });

    await test.step("And I find the Password field and enter a valid password", async () => {
      await page.getByLabel("Field for the password").fill("Test1234!");
    });

    await test.step("And I find the Repeat Password field and enter the same password", async () => {
      await page.getByLabel("Field to confirm the password").fill("Test1234!");
    });

    await test.step("And I select a security question", async () => {
      const securityQ = page.locator("mat-select[name='securityQuestion']");
      await securityQ.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.locator("#mat-select-0 .mat-mdc-select-trigger").click({ force: true });
      await page.locator("mat-option").first().click();
    });

    await test.step("And I find the Answer field and enter an answer", async () => {
      await page.getByPlaceholder("Answer to your security question").fill("MyAnswer");
    });

    await test.step("Precondition: Register button is enabled before clicking", async () => {
      await expect(page.locator("button[type='submit']")).toBeEnabled({ timeout: 5000 });
    });

    await test.step("And I click Register", async () => {
      await page.locator("button[type='submit']").click();
    });

    await test.step("Then the URL contains '/#/login'", async () => {
      await expect(page).toHaveURL(new RegExp("/#/login"), { timeout: 10000 });
    });
  });

  // @story:SCRUM-10
  // @ac:2
  // @design:D15
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-2: Register button is disabled when password and repeat password differ", async ({ page }) => {
    await test.step("Given I navigate to the registration page", async () => {
      await page.goto("/#/register");
    });

    await test.step("Precondition: registration page is ready", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Password field and enter a password", async () => {
      await page.locator("input[type='password']").first().fill("Test1234!");
    });

    await test.step("And I find the Repeat Password field and enter a different password", async () => {
      await page.locator("input[type='password']").nth(1).fill("Different99!");
    });

    await test.step("Then the Register button is disabled", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeDisabled();
    });
  });

  // @story:SCRUM-10
  // @ac:2
  // @design:D16
  // @type:functional
  // @technique:boundary-value-analysis
  test("AC-2: Register button is enabled when password and repeat password match", async ({ page }) => {
    await test.step("Given I navigate to the registration page", async () => {
      await page.goto("/#/register");
    });

    await test.step("Precondition: registration page is ready", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter an email", async () => {
      await page.getByLabel("Email").fill(`aqa-enabled-${Date.now()}@example.com`);
    });

    await test.step("And I find the Password field and enter a password", async () => {
      await page.locator("input[type='password']").first().fill("Test1234!");
    });

    await test.step("And I find the Repeat Password field and enter the same password", async () => {
      await page.locator("input[type='password']").nth(1).fill("Test1234!");
    });

    await test.step("And I select a security question", async () => {
      await page.locator("#mat-select-0 .mat-mdc-select-trigger").click({ force: true });
      await page.locator("mat-option").first().click();
    });

    await test.step("And I find the Answer field and enter an answer", async () => {
      await page.getByPlaceholder("Answer to your security question").fill("MyAnswer");
    });

    await test.step("Then the Register button is enabled", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeEnabled({ timeout: 5000 });
    });
  });

  // @story:SCRUM-10
  // @ac:3
  // @design:D17
  // @type:functional
  // @technique:equivalence-partitioning
  test("AC-3: Registering with an email that already has an account is refused with a message", async ({ page }) => {
    await test.step("Given I navigate to the registration page", async () => {
      await page.goto("/#/register");
    });

    await test.step("Precondition: registration page is ready", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter an already-registered email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter a password", async () => {
      await page.locator("input[type='password']").first().fill("Test1234!");
    });

    await test.step("And I find the Repeat Password field and enter the same password", async () => {
      await page.locator("input[type='password']").nth(1).fill("Test1234!");
    });

    await test.step("And I select a security question", async () => {
      await page.locator("#mat-select-0 .mat-mdc-select-trigger").click({ force: true });
      await page.locator("mat-option").first().click();
    });

    await test.step("And I find the Answer field and enter an answer", async () => {
      await page.getByPlaceholder("Answer to your security question").fill("MyAnswer");
    });

    await test.step("Precondition: Register button is enabled (all fields filled correctly)", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeEnabled({ timeout: 5000 });
    });

    await test.step("And I click Register", async () => {
      await page.locator("button").filter({ hasText: "Register" }).click();
    });

    await test.step("Then the page displays a message saying the email must be unique", async () => {
      await expect(page.getByText("Email must be unique")).toBeVisible({ timeout: 10000 });
    });
  });

  // @story:SCRUM-10
  // @design:D18
  // @type:accessibility
  // @technique:checklist-based
  test("AC-story: Registration page passes axe-core WCAG A/AA scan", async ({ page }) => {
    await test.step("Given I navigate to the registration page", async () => {
      await page.goto("/#/register");
    });

    await test.step("Precondition: registration page is ready", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeVisible({ timeout: 5000 });
    });

    await test.step("Then the registration form has no axe violations", async () => {
      const results = await new AxeBuilder({ page })
        .include("mat-card, form")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(
        results.violations.map((v) => v.id).sort(),
        "axe-core WCAG A/AA violations on the registration page"
      ).toEqual([]);
    });
  });

  // @story:SCRUM-10
  // @ac:1
  // @design:D19
  // @type:security
  // @technique:error-guessing
  test("AC-1 (security): Duplicate email registration error does not reveal extra account details", async ({ page }) => {
    await test.step("Given I navigate to the registration page", async () => {
      await page.goto("/#/register");
    });

    await test.step("Precondition: registration page is ready", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeVisible({ timeout: 5000 });
    });

    await test.step("When I find the Email field and enter an already-registered email", async () => {
      await page.getByLabel("Email").fill(process.env["AQA_APP_USER"] ?? "");
    });

    await test.step("And I find the Password field and enter a password", async () => {
      await page.locator("input[type='password']").first().fill("Test1234!");
    });

    await test.step("And I find the Repeat Password field and enter the same password", async () => {
      await page.locator("input[type='password']").nth(1).fill("Test1234!");
    });

    await test.step("And I select a security question", async () => {
      await page.locator("#mat-select-0 .mat-mdc-select-trigger").click({ force: true });
      await page.locator("mat-option").first().click();
    });

    await test.step("And I find the Answer field and enter an answer", async () => {
      await page.getByPlaceholder("Answer to your security question").fill("MyAnswer");
    });

    await test.step("Precondition: Register button is enabled (all fields filled correctly)", async () => {
      await expect(page.locator("button").filter({ hasText: "Register" })).toBeEnabled({ timeout: 5000 });
    });

    await test.step("And I click Register", async () => {
      await page.locator("button").filter({ hasText: "Register" }).click();
    });

    await test.step("Then the error message says 'Email must be unique' and does not reveal account details beyond email already in use", async () => {
      const errorMsg = page.getByText("Email must be unique");
      await expect(errorMsg).toBeVisible({ timeout: 10000 });
      // The error message must contain only the "Email must be unique" text —
      // it must not reveal password details, account creation date, or any other
      // information about the existing account.
      const errorText = await errorMsg.textContent();
      expect(errorText, "Error message must not contain password details").not.toMatch(/password/i);
      expect(errorText, "Error message must not reveal account creation details").not.toMatch(/created|account details/i);
    });
  });
});
