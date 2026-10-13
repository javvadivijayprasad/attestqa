@epic:42
Feature: Customer account access
  Everything a customer does to get into and out of their Juice Shop account:
  registering, signing in and signing out.

  Background:
    Given I navigate to "/#/login"

  # ---------------------------------------------------------------------------
  # Story 1: Login with valid credentials
  # ---------------------------------------------------------------------------

  @story:1 @ac:1 @design:D1 @type:functional @technique:state-transition
  Scenario: AC-1: Registered user signs in with correct email and password
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "aqa_user_pass"
    And I click "Log in"
    Then the URL contains "/#/"
    And the account menu is displayed

  @story:1 @ac:1 @design:D2 @type:functional @technique:state-transition
  Scenario: AC-1: Authentication token is written to localStorage after successful login
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "aqa_user_pass"
    And I click "Log in"
    Then the account menu is displayed

  @story:1 @ac:2 @design:D3 @type:functional @technique:equivalence-partitioning
  Scenario: AC-2: Wrong password shows generic error and keeps user on login page
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "wrongpassword123"
    And I click "Log in"
    Then the page displays "Invalid email or password."
    And the URL contains "/#/login"

  @story:1 @ac:3 @design:D4 @type:functional @technique:boundary-value-analysis
  Scenario: AC-3a: Log in button is disabled when both fields are empty
    When I leave the Email field empty
    And I leave the Password field empty
    Then the Log in button is disabled

  @story:1 @ac:3 @design:D5 @type:functional @technique:boundary-value-analysis
  Scenario: AC-3b: Log in button is disabled when only one field is filled; validation messages shown on touched empty fields
    When I find the Email field and enter "aqa_user_email"
    And I leave the Password field empty
    Then the Log in button is disabled

  @story:1 @ac:4 @design:D6 @type:functional @technique:equivalence-partitioning
  Scenario: AC-4: Unregistered email produces same generic error as wrong password
    When I find the Email field and enter "notregistered@example.com"
    And I find the Password field and enter "anypassword123"
    And I click "Log in"
    Then the page displays "Invalid email or password."

  @story:1 @ac:2 @design:D7 @type:security @technique:equivalence-partitioning
  Scenario: AC-2 security: Wrong credentials show the same message regardless of which field is wrong
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter "wrongpassword123"
    And I click "Log in"
    Then the page displays "Invalid email or password."

  @story:1 @design:D8 @type:accessibility @technique:checklist-based
  Scenario: story: Login page passes axe-core WCAG A/AA scan
    Then the page has no axe violations

  @story:1 @bug:49 @design:D9 @type:confirmation @technique:boundary-value-analysis
  Scenario: Bug 49: Login with leading whitespace in password fails with standard error
    When I find the Email field and enter "aqa_user_email"
    And I find the Password field and enter " aqa_user_pass_with_leading_space"
    And I click "Log in"
    Then the page displays "Invalid email or password."
