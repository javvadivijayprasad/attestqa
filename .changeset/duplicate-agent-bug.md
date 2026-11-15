---
"attestqa": patch
---

A failure that already has an open bug is no longer proposed as a new bug under a different title. The duplicate check compared bug titles only, and each run words the same failure differently, so a bug filed by one run was proposed again by the next; when the reviewer answered "duplicate", the run ended blocked. On Azure DevOps the check now also recognises an open bug by the failing test it names in its description: the proposal is refused with the existing bug's number, the run finishes with that bug cited in its report, and the terminal summary shows it on an "Already filed" line. A bug a person has confirmed is handled as before, through the story context. Jira is unchanged.
