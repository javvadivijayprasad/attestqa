---
"attestqa": patch
---

A `test.fail` test that fails as its known bug says it should is now reported as `expected-failure` ("fails as expected — known bug reproduced") instead of `passed`, in the per-test rows, the run summary and the terminal line. Playwright's own pass count is unchanged.
