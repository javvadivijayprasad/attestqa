/**
 * @bdd2pw generated 2026-09-25T14:51:44.027Z
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
  readonly cookieconsent: Locator;
  readonly learnMoreAboutCookiesButton: Locator;
  readonly dismissCookieMessageButton: Locator;
  readonly openSidenavButton: Locator;
  readonly menuImage: Locator;
  readonly backToHomepageButton: Locator;
  readonly clickToSearch: Locator;
  readonly openSearchButton: Locator;
  readonly searchImage: Locator;
  readonly textboxElement: Locator;
  readonly closeSearchButton: Locator;
  readonly closeImage: Locator;
  readonly showHideAccountMenuButton: Locator;
  readonly accountCircleImage: Locator;
  readonly showTheShoppingCartButton: Locator;
  readonly shoppingCartImage: Locator;
  readonly _0: Locator;
  readonly languageSelectionMenuButton: Locator;
  readonly languageImage: Locator;
  readonly clickForMoreInformationAboutTheProductButton: Locator;
  readonly addToBasketButton: Locator;
  readonly addShoppingCartImage: Locator;
  readonly itemsPerPage15115Of46: Locator;
  readonly _15Select: Locator;
  readonly _115Of46: Locator;
  readonly previousPageButton: Locator;
  readonly nextPageButton: Locator;
  readonly cdkDescribedbyMessageNg12: Locator;
  readonly cdkDescribedbyMessageNg13: Locator;
  readonly cdkDescribedbyMessageNg14: Locator;
  readonly cdkDescribedbyMessageNg15: Locator;
  readonly welcomeToOwaspJuiceShopBeingAWeb: Locator;
  readonly welcomeToOwaspJuiceShopHeading: Locator;
  readonly openWorldwideApplicationSecurityProjectOwaspLink: Locator;
  readonly httpsOwaspJuiceShopHeading: Locator;
  readonly httpsOwaspJuiceShopLink: Locator;
  readonly schoolHelpGettingStartedButton: Locator;
  readonly schoolImage: Locator;
  readonly closeWelcomeBannerButton: Locator;
  readonly visibilityOffImage: Locator;
  readonly forcePageReloadButton: Locator;
  readonly loginHeading: Locator;
  readonly email: Locator;
  readonly textFieldForTheLoginEmailInput: Locator;
  readonly password: Locator;
  readonly textFieldForTheLoginPasswordInput: Locator;
  readonly buttonToDisplayThePasswordButton: Locator;
  readonly eyeImage: Locator;
  readonly forgotYourPasswordLink: Locator;
  readonly loginButton: Locator;
  readonly exitToAppImage: Locator;
  readonly rememberMe: Locator;
  readonly notYetACustomerLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.cookieconsent = page.locator("");
    this.learnMoreAboutCookiesButton = page.locator("");
    this.dismissCookieMessageButton = page.locator("");
    this.openSidenavButton = page.locator("");
    this.menuImage = page.locator("");
    this.backToHomepageButton = page.locator("");
    this.clickToSearch = page.locator("");
    this.openSearchButton = page.locator("");
    this.searchImage = page.locator("");
    this.textboxElement = page.locator("");
    this.closeSearchButton = page.locator("");
    this.closeImage = page.locator("");
    this.showHideAccountMenuButton = page.locator("");
    this.accountCircleImage = page.locator("");
    this.showTheShoppingCartButton = page.locator("");
    this.shoppingCartImage = page.locator("");
    this._0 = page.locator("");
    this.languageSelectionMenuButton = page.locator("");
    this.languageImage = page.locator("");
    this.clickForMoreInformationAboutTheProductButton = page.locator("");
    this.addToBasketButton = page.locator("");
    this.addShoppingCartImage = page.locator("");
    this.itemsPerPage15115Of46 = page.locator("");
    this._15Select = page.locator("");
    this._115Of46 = page.locator("");
    this.previousPageButton = page.locator("");
    this.nextPageButton = page.locator("");
    this.cdkDescribedbyMessageNg12 = page.locator("");
    this.cdkDescribedbyMessageNg13 = page.locator("");
    this.cdkDescribedbyMessageNg14 = page.locator("");
    this.cdkDescribedbyMessageNg15 = page.locator("");
    this.welcomeToOwaspJuiceShopBeingAWeb = page.locator("");
    this.welcomeToOwaspJuiceShopHeading = page.locator("");
    this.openWorldwideApplicationSecurityProjectOwaspLink = page.locator("");
    this.httpsOwaspJuiceShopHeading = page.locator("");
    this.httpsOwaspJuiceShopLink = page.locator("");
    this.schoolHelpGettingStartedButton = page.locator("");
    this.schoolImage = page.locator("");
    this.closeWelcomeBannerButton = page.locator("");
    this.visibilityOffImage = page.locator("");
    this.forcePageReloadButton = page.locator("");
    this.loginHeading = page.getByRole("heading", { name: "Login" });
    this.email = page.getByLabel("Email");
    this.textFieldForTheLoginEmailInput = page.getByRole("textbox", { name: "Text field for the login email" });
    this.password = page.getByLabel("Password");
    this.textFieldForTheLoginPasswordInput = page.getByRole("textbox", { name: "Text field for the login password" });
    this.buttonToDisplayThePasswordButton = page.getByRole("button", { name: "Button to display the password" });
    this.eyeImage = page.getByRole("img", { name: "Eye" });
    this.forgotYourPasswordLink = page.getByRole("link", { name: "Forgot your password?" });
    this.loginButton = page.getByRole("button", { name: "Login" });
    this.exitToAppImage = page.getByText("exit_to_app");
    this.rememberMe = page.getByLabel("Remember me");
    this.notYetACustomerLink = page.getByRole("link", { name: "Not yet a customer?" });
  }

  async goto(): Promise<void> {
    await this.page.goto("http://localhost:3100");
  }
}
