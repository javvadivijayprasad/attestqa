# Checkout — rules and messages

Checkout has three steps: the customer's information, the order overview, and the confirmation.

Wording and figures confirmed against the hosted application on 17 Nov 2026.

## Customer information

The first name, the last name and the postal code are all required. They are checked in that
order, and the first one that is empty is reported.

First name empty:

> Error: First Name is required

Last name empty:

> Error: Last Name is required

Postal code empty:

> Error: Postal Code is required

## Sales tax

Tax is 8% of the item total, rounded to the nearest cent. The total is the item total plus the
tax.

Example: a Sauce Labs Backpack ($29.99) and a Sauce Labs Bike Light ($9.99) give an item total
of $39.98, tax of $3.20 and a total of $43.18.

## Payment and delivery

The overview shows the payment as "SauceCard #31337" and the delivery as "Free Pony Express
Delivery!".

## Order confirmation

Finishing the order shows this heading:

> Thank you for your order!

and below it:

> Your order has been dispatched, and will arrive just as fast as the pony can get there!

After the order the cart is empty.
