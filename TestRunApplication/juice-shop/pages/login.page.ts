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

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto("http://localhost:3100");
  }
}
