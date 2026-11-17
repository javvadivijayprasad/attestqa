# Booking a room — guest details

A guest who has chosen the nights for a room gives a first name, a last name, an email address
and a phone number. The booking is made only when all four are valid.

Limits and message wording confirmed against the local application on 17 Nov 2026.

## First name

A first name must be 3 to 18 characters long.

When it is empty the booking is not made and this message is shown:

> Firstname should not be blank

When it is shorter or longer than allowed, this message is shown:

> size must be between 3 and 18

## Last name

A last name must be 3 to 30 characters long.

When it is empty the booking is not made and this message is shown:

> Lastname should not be blank

When it is shorter or longer than allowed, this message is shown:

> size must be between 3 and 30

## Email address

An email address must be well formed: it has an @ with a name before it and a domain after it.

When it is not, the booking is not made and this message is shown:

> must be a well-formed email address

## Phone number on a booking

A guest's phone number must be 11 to 21 characters long.

When it is shorter or longer, the booking is not made and this message is shown:

> size must be between 11 and 21
