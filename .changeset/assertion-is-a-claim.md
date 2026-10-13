---
"attestqa": patch
---

On the execute path (route B), removing a line that contains a locator was always treated as a locator repair — including assertion lines, so an `expect(page.getByText(…))…` could be deleted or rewritten. A removed assertion is now allowed only when an assertion making the same claim (locators set aside) remains; moving the locator inside a check is still a repair. "strict mode violation" (an ambiguous locator) is now classified as the test's own fault rather than a possible defect, and "failures-not-triaged" is reported only when triage really gave no verdict for the latest run.
