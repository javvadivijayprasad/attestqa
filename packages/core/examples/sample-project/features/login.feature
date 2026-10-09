@login
Feature: Login with valid credentials
  As a registered user
  I want to log in with my email and password
  So that I can access my account

  Background:
    Given I navigate to "/#/login"

  # AC-1: A registered user who submits their correct email and password is signed in:
  # the account menu shows their email address and offers Logout.
  @ac:1
  Scenario: AC-1: A registered user signs in with correct email and password
    When I find the Email field and enter "admin@juice-sh.op"
    And I find the Password field and enter "admin123"
    And I click "Login"
    Then the URL does not contain "/#/login"
    Then the account menu is displayed

  # AC-2: Submitting a valid email with an incorrect password keeps the user on the login
  # page and shows "Invalid email or password."
  @ac:2
  Scenario: AC-2: Submitting a valid email with an incorrect password shows a generic error message
    When I find the Email field and enter "admin@juice-sh.op"
    And I find the Password field and enter "WrongPassword!99"
    And I click "Login"
    Then the URL contains "/#/login"
    Then the page displays "Invalid email or password."

  # AC-3: The Log in button is disabled while either field is empty.
  # An email field that has been touched and left empty shows "Please provide an email address."
  @ac:3
  Scenario: AC-3a: Touched email field left empty shows validation message and Log in button is disabled
    When I leave the Email field empty
    Then the Log in button is disabled
    Then the page displays "Please provide an email address."

  # AC-3: The password field shows "Please provide a password." when touched and left empty
  @ac:3
  Scenario: AC-3b: Touched password field left empty shows validation message and Log in button is disabled
    When I find the Email field and enter "admin@juice-sh.op"
    And I leave the Password field empty
    Then the Log in button is disabled
    Then the page displays "Please provide a password."

  # AC-4: An unregistered email with any password produces the same "Invalid email or
  # password." message, so the response does not disclose whether an account exists.
  @ac:4
  Scenario: AC-4: An unregistered email with any password produces the same error as a wrong password
    When I find the Email field and enter "nobody-unregistered@example.com"
    And I find the Password field and enter "SomePassword123!"
    And I click "Login"
    Then the URL contains "/#/login"
    Then the page displays "Invalid email or password."
