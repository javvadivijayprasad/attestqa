# Rooms — rules for the owner

The owner adds, edits and deletes rooms in the admin area. A room has a room number, a type,
whether it is accessible, a price per night and a list of features.

Limits and message wording confirmed against the local application on 17 Nov 2026.

## Room number

Every room has a room number. When a room is created without one, no room is added and this
message is shown:

> Room name must be set

## Room price

The price of a room per night is a whole number from 1 to 999.

When the price is 0 or is left out, no room is added and this message is shown:

> must be greater than or equal to 1

When the price is 1000 or more, no room is added and this message is shown:

> must be less than or equal to 999

## Signing in to the admin area

The admin area is shown only after the owner signs in. A wrong username or password shows this
message, and the admin area is not shown:

> Invalid credentials
