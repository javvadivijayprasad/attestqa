# Customer account — registration and signing in

Limits from story TOOL-34; wording taken from the Toolshop tests that passed against the local
application in November 2026. Not re-confirmed on 17 Nov 2026: the application was not running.

## Age limit

Only adults may register. On the day of registration the customer must be at least 18 years old
and younger than 75. A customer aged 18 to 74 can register; a date of birth that makes the
customer 17, or 75, is refused.

## Password rules

A password has at least 8 characters, and holds an uppercase letter, a lowercase letter, a number
and a symbol. A password of 7 characters is refused even when it holds all four kinds.

## Required registration fields

When a required field is empty, no account is created and a message is shown at that field. For
the first name it is:

> First name is required

## Signing in with a wrong password

A wrong email or a wrong password gives the same message, so that it does not say whether the
email has an account:

> Invalid email or password.

## Favourites need a sign-in

A visitor who is not signed in and opens the favourites page is sent to the sign-in page.
