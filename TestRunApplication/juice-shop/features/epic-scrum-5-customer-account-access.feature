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

  # ---------------------------------------------------------------------------
  # SCRUM-6: Customer signs in with email and password
  # ---------------------------------------------------------------------------

  @story:SCRUM-6 @ac:1 @design:D6 @type:functional @technique:state-transition
  Scenario: AC-1: A registered customer with correct credentials is signed in and taken to the product list
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "aqa_user_pass"
    And I click "Log in"
    Then the URL contains "/#/"
    And the account menu is displayed

  @story:SCRUM-6 @ac:2 @design:D7 @type:functional @technique:equivalence-partitioning
  Scenario: AC-2: A wrong password shows an error message and the customer stays on the login page
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "wrongpassword123"
    And I click "Log in"
    Then the page displays "Invalid email or password."
    And the URL contains "/#/login"

  @story:SCRUM-6 @ac:3 @design:D8 @type:functional @technique:boundary-value-analysis
  Scenario: AC-3a: Log in button is disabled when only the email field is filled
    When I find the Email field and enter "aqa_user_email"
    And I leave the Password field empty
    Then the Log in button is disabled

  @story:SCRUM-6 @ac:3 @design:D9 @type:functional @technique:boundary-value-analysis
  Scenario: AC-3b: Log in button is disabled when only the password field is filled
    When I leave the Email field empty
    And I find the Password field and enter "aqa_user_pass"
    Then the Log in button is disabled

  @story:SCRUM-6 @ac:3 @design:D10 @type:functional @technique:boundary-value-analysis
  Scenario: AC-3c: Log in button is disabled when both fields are empty
    When I leave the Email field empty
    And I leave the Password field empty
    Then the Log in button is disabled

  @story:SCRUM-6 @ac:3 @design:D11 @type:functional @technique:boundary-value-analysis
  Scenario: AC-3d: Log in button is enabled when both email and password are filled
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "aqa_user_pass"
    Then the Log in button is enabled

  @story:SCRUM-6 @ac:2 @design:D12 @type:security @technique:state-transition
  Scenario: AC-2 (security): Wrong credentials show the same message regardless of which field is wrong
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "wrongpassword123"
    And I click "Log in"
    Then the page displays "Invalid email or password."

  @story:SCRUM-6 @design:D13 @type:accessibility @technique:checklist-based
  Scenario: AC-story: Login page passes axe-core WCAG A/AA scan
    Then the page has no axe violations
