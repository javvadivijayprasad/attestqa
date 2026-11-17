---
"attestqa": minor
---

A design item that takes a value from a project document is now checked against that document. The item cites the passage in its source (`doc:<passage id>`) and copies the words that state the value into a new optional field, `quote`. Before a person sees the design, the runtime checks that the passage was returned by a search in this run and that the quoted words are in it; a design that fails either is sent back to the agent with the reason. The approval shows the file, the heading and the quote under what the item expects. When a later run would reuse an approved design that cites a passage, and that passage is no longer in the index (the document changed or was removed) or there is no index, the story is designed again. Designs that cite no document are checked and reused exactly as before.
