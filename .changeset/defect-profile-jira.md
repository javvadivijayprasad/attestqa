---
"attestqa": minor
---

The defect profile can be built from Jira. `aqa run "build the defect profile" --skill defect-profile --tracker jira --project SHOP` searches the project for bugs that are done, reads each one once, classifies it in the same vocabulary, and writes the same `.aqa-profile/defects.json` that story runs read, with the Jira key as each bug's id. `--project` can be left out when `agent.scope.work_items` allows exactly one Jira project. Every bug read is checked against the scope, as it is for Azure DevOps. A Jira profile covers at most 100 bugs and carries no closed date. Before this the command was refused for Jira. Nothing changes for Azure DevOps: its instructions are character for character what they were.
