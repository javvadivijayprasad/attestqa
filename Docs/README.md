# Docs

PDFs here are the deliverables; `00_Signoff.pdf` lists each one with its SHA-256.

To regenerate after editing `src/*.md` (needs Python with `markdown` and `playwright`):

    python prototype/build.py      # UI screens  -> assets/0*.png
    python prototype/diagrams.py   # diagrams    -> assets/d*.svg (rasterise to .png before rendering)
    python render.py               # every src/*.md -> *.pdf

Re-rendering changes the PDF hashes, so a revised document needs a new line on the sign-off sheet.
