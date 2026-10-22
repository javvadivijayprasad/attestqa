---
"attestqa": patch
---

The application's address now comes only from `AQA_APP_URL` in the `.env` file, applied as Playwright's `baseURL`. A write that makes a spec or page object navigate to an absolute address is refused, and the verifier reports any that already does (`absolute-navigation`), asking for a relative path; on the execute path, changing a `goto` target counts as a repair. Before, every generated page object carried its application's address as a literal, so the same tests pointed at another build would quietly have kept testing the original one.
