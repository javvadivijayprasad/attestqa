# Signing in — rules and messages

A customer signs in with a username and a password. The product list is shown only to a customer
who is signed in.

Message wording confirmed against the hosted application on 17 Nov 2026.

## Wrong username or password

When the username and password do not belong to a user, the product list is not shown and this
message is shown:

> Epic sadface: Username and password do not match any user in this service

## Username left empty

When the username is empty, this message is shown:

> Epic sadface: Username is required

## Password left empty

When a username is given and the password is empty, this message is shown:

> Epic sadface: Password is required

## Locked-out user

A user who has been locked out cannot sign in, even with the right password. This message is
shown:

> Epic sadface: Sorry, this user has been locked out.

## Opening the product list without signing in

Opening the product list address directly without signing in shows the sign-in page with this
message:

> Epic sadface: You can only access '/inventory.html' when you are logged in.
