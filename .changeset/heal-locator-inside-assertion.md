---
"attestqa": patch
---

A test quarantined as a defect candidate can now have the locator inside its assertion healed — `expect(page.getByRole("button", { name: "Log in" })).toBeEnabled()` → `{ name: "Login" }` — when the new locator is one `aqa.heal_locator` offered from the page in this run. The matcher and its expected value still may not change, and a locator the heal tool never offered is still refused.
