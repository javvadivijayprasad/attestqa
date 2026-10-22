/**
 * @bdd2pw generated 2026-10-13T18:32:28.772Z
 * @bdd2pw dom-hash 1fb6c56103c65b6edaebd79d9503b79f688195b29509ae5d249e9a548b7f8248
 * @bdd2pw url http://localhost:3100/#/login
 *
 * The dom-hash line is used by bdd2pw to detect DOM drift on
 * re-scaffold. Do not edit it by hand — regenerate with `bdd2pw
 * scaffold` or `bdd2pw update-pom` to refresh.
 */
import { Page, Locator, expect } from "@playwright/test";

export class LoginPage {
  readonly page: Page;
  // Restored by hand 2026-10-16: a bdd2pw re-scaffold on 2026-10-13 emptied
  // this Page Object while specs still call loginPage.loginButton.
  readonly loginButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.loginButton = page.locator("#loginButton");
  }

  async goto(): Promise<void> {
    // The address is AQA_APP_URL (.env), applied as baseURL in playwright.config.ts.
    await this.page.goto("/");
  }
}
