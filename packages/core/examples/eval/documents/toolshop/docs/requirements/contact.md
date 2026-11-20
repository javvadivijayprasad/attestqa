# Contact form — rules and messages

A customer sends the shop a message with a first name, a last name, an email address, a subject
chosen from a list, and a message.

Wording taken from the Toolshop tests that passed against the local application in November
2026. Not re-confirmed on 17 Nov 2026: the application was not running.

## Required fields

Each of these fields is required. When one is empty the form is not sent and a message is shown
at that field.

First name empty:

> First name is required

Last name empty:

> Last name is required

Email address empty:

> Email is required

Message empty:

> Message is required

## Email format

An email address without an @ is refused with this message:

> Email format is invalid

## After sending

A form that is sent shows this message:

> Thanks for your message!
