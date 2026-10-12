---
"attestqa": patch
---

Adding a second story's scenarios to a shared epic feature file no longer deadlocks. A comment line (`# --- SCRUM-6 ---`) is no longer counted as a step of the scenario above it, so a pure append is not mistaken for rewording another story, and the refusal now says how to append safely (`fs.replace_in_file` on the file's last line). New rule `writesMaskedValue`: a write that would put a read-time mask (`[EMAIL]`, `[PASSWORD]`, `[TOKEN]`, …) into a file is refused with an explanation, instead of corrupting the file or failing as an unexplained "rewording".
