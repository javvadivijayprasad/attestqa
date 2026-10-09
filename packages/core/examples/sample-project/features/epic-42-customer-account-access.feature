@epic:42
Feature: Customer account access
  As a customer
  I want to access my account
  So that I can shop and manage my orders

  Background:
    Given I navigate to "/#/login"

  # ---------------------------------------------------------------------------
  # Story 1 — Login with valid credentials
  # ---------------------------------------------------------------------------

  # AC-1: A registered user who submits their correct email and password is
  # signed in: the account menu shows their email address and offers Logout.
  @story:1 @ac:1 @design:D1
  Scenario: AC-1: Registered user signs in with correct email and password
    When I find the Email field and enter "[AQA_APP_USER]"
    And I find the Password field and enter "[AQA_APP_PASS]"
    And I click "Log in"
    Then the URL does not contain "/#/login"
    Then the account menu is displayed

  # AC-2: Submitting a valid email with an incorrect password keeps the user on
  # the login page and shows "Invalid email or password."
  @story:1 @ac:2 @design:D2
  Scenario: AC-2: Wrong password shows generic error and keeps user on login page
    When I find the Email field and enter "[AQA_APP_USER]"
    And I find the Password field and enter "WrongPassword!99"
    And I click "Log in"
    Then the URL contains "/#/login"
    Then the page displays "Invalid email or password."

  # AC-3a: The Log in button is disabled while the email field is empty.
  # A touched and left-empty email field shows "Please provide an email address."
  @story:1 @ac:3 @design:D3
  Scenario: AC-3a: Touched email field left empty shows validation message and Log in button is disabled
    When I leave the Email field empty
    Then the Log in button is disabled
    Then the page displays "Please provide an email address."

  # AC-3b: The Log in button is disabled while the password field is empty.
  # A touched and left-empty password field shows "Please provide a password."
  @story:1 @ac:3 @design:D3
  Scenario: AC-3b: Touched password field left empty shows validation message and Log in button is disabled
    When I find the Email field and enter "[AQA_APP_USER]"
    And I leave the Password field empty
    Then the Log in button is disabled
    Then the page displays "Please provide a password."

  # AC-4: An unregistered email with any password produces the same
  # "Invalid email or password." message — no account-existence disclosure.
  @story:1 @ac:4 @design:D4
  Scenario: AC-4: Unregistered email produces same generic error as wrong password
    When I find the Email field and enter "notregistered_qa_9x7z@example.com"
    And I find the Password field and enter "SomePassword123!"
    And I click "Log in"
    Then the URL contains "/#/login"
    Then the page displays "Invalid email or password."

  # Bug #48 [Active]: Error message persists after the email is corrected.
  # This test is EXPECTED TO FAIL because the bug is Active.
  @story:1 @ac:2 @design:D5 @bug:48
  Scenario: AC-2 / Bug-48: Error message clears after a successful login following a failed attempt
    When I find the Email field and enter "[AQA_APP_USER]"
    And I find the Password field and enter "WrongPassword!99"
    And I click "Log in"
    Then the page displays "Invalid email or password."
    When I find the Password field and enter "[AQA_APP_PASS]"
    And I click "Log in"
    Then the URL does not contain "/#/login"
    Then the page does not display "Invalid email or password."

  # Security: login must not disclose whether an account exists (AC-2 & AC-4).
  # Covered structurally by D2 and D4 — the message is identical in both cases.
  # Accessibility: axe-core WCAG A/AA scan of the login page.
  @story:1 @design:D7
  Scenario: Accessibility — login page passes axe-core WCAG A/AA scan
    Then the page has no axe violations
