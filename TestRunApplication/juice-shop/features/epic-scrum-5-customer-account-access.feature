@epic:SCRUM-5
Feature: Customer account access
  Everything a customer does to get into and out of their Juice Shop account:
  registering, signing in and signing out.

  # ---------------------------------------------------------------------------
  # SCRUM-8: Customer signs out
  # ---------------------------------------------------------------------------

  Background:
    Given I navigate to "/#/login"

  @story:SCRUM-8 @ac:1 @design:D1 @type:functional @technique:state-transition
  Scenario: AC-1: Choosing Account > Logout signs the customer out and Account menu offers Login again
    When I find the Email field and enter "user@email.com"
    And I find the Password field and enter "password"
    And I click "Log in"
    Then the account menu is displayed
    When I click "Account"
    And I click "Logout"
    Then the page displays "Login"

  @story:SCRUM-8 @ac:2 @design:D2 @type:functional @technique:state-transition
  Scenario: AC-2: After logout the browser returns to the storefront home page
    When I find the Email field and enter "user@email.com"
    And I find the Password field and enter "password"
    And I click "Log in"
    Then the account menu is displayed
    When I click "Account"
    And I click "Logout"
    Then the URL contains "/#/"

  @story:SCRUM-8 @ac:1 @design:D3 @type:security @technique:state-transition
  Scenario: AC-1: After logout the authentication token is removed from the browser
    When I find the Email field and enter "user@email.com"
    And I find the Password field and enter "password"
    And I click "Log in"
    Then the account menu is displayed
    When I click "Account"
    And I click "Logout"
    Then local storage does not contain "token"

  @story:SCRUM-8 @ac:1 @design:D4 @type:accessibility @technique:checklist-based
  Scenario: AC-1: Storefront pages involved in sign-out pass axe-core WCAG A/AA scan
    Then the page has no axe violations

  @story:SCRUM-8 @bug:SCRUM-12 @design:D5 @type:confirmation @technique:state-transition
  Scenario: Bug SCRUM-12: Session token is still accepted by the server after logout
    When I find the Email field and enter "[EMAIL]"
    And I find the Password field and enter "[PASSWORD]"
    And I click "Log in"
    Then the account menu is displayed
    When I click "Account"
    And I click "Logout"
    Then the session token is not accepted by the server after logout

  @story:SCRUM-8 @bug:SCRUM-12 @design:D5 @type:confirmation @technique:state-transition
  Scenario: bug #SCRUM-12: Session token is still accepted by the server after logout
    When I find the Email field and enter "[EMAIL]"
    And I find the Password field and enter "password"
    And I click "Log in"
    Then the account menu is displayed
    When I click "Account"
    And I click "Logout"
    Then the session token is rejected by the server after logout
