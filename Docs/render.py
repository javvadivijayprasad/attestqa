"""Render Docs/src/*.md to PDF with Chromium. Usage: python render.py"""
import hashlib, re, sys
from pathlib import Path
import markdown
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
SRC, OUT, ASSETS = ROOT / "src", ROOT, ROOT / "assets"

CSS = """
@page { size: A4; margin: 22mm 18mm 20mm 18mm; }
body { font: 10.5pt/1.5 "Segoe UI", "DejaVu Sans", sans-serif; color: #1d2330; }
.cover { border-bottom: 2px solid #3b6ef5; padding-bottom: 10px; margin-bottom: 18px; }
.cover .id { color: #3b6ef5; font-weight: 700; letter-spacing: .06em; font-size: 9pt; }
.cover h1 { font-size: 21pt; margin: 4px 0 6px; border: 0; }
.cover .meta { color: #6b748a; font-size: 9pt; }
h1 { font-size: 15pt; margin: 22px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #dde1e8; page-break-after: avoid; }
h2 { font-size: 12.5pt; margin: 16px 0 6px; page-break-after: avoid; }
h3 { font-size: 11pt; margin: 12px 0 4px; }
p { margin: 6px 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 9pt; page-break-inside: auto; }
th, td { border: 1px solid #d5dae3; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #f1f3f7; }
tr { page-break-inside: avoid; }
code { font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 8.8pt; background: #f4f5f8; padding: 0 2px; border-radius: 3px; }
pre { background: #f6f7f9; border: 1px solid #e3e6ec; border-radius: 5px; padding: 8px 10px; font-size: 8.4pt; line-height: 1.4; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
img { max-width: 100%; border: 1px solid #dde1e8; border-radius: 4px; margin: 6px 0; page-break-inside: avoid; }
ul, ol { margin: 4px 0 8px 20px; padding: 0; }
li { margin: 2px 0; }
a { color: #2d4fd1; text-decoration: none; }
.sig td { height: 34px; }
.box { display: inline-block; width: 11px; height: 11px; border: 1px solid #4a5368; margin-right: 4px; vertical-align: -1px; }
"""

def front_matter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    meta = {}
    if m:
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip('"')
        text = text[m.end():]
    return meta, text

def to_html(md_path):
    meta, body = front_matter(md_path.read_text(encoding="utf-8"))
    body = body.replace("../assets/", ASSETS.resolve().as_uri() + "/")
    html_body = markdown.markdown(body, extensions=["tables", "fenced_code", "sane_lists", "attr_list", "md_in_html"])
    cover = (f'<div class="cover"><div class="id">{meta.get("doc","")} · attestqa</div>'
             f'<h1>{meta.get("title","").replace("attestqa — ","")}</h1>'
             f'<div class="meta">Version {meta.get("version","")} · {meta.get("date","")} · Author: Vijay Javvadi</div></div>')
    return meta, f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>{cover}{html_body}</body></html>'

def render(names=None):
    OUT.mkdir(exist_ok=True)
    files = sorted(SRC.glob("*.md"))
    if names:
        files = [f for f in files if f.stem in names]
    results = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        for f in files:
            meta, html = to_html(f)
            tmp = OUT / f"{f.stem}.html"
            tmp.write_text(html, encoding="utf-8")
            pg.goto(tmp.resolve().as_uri())
            pg.wait_for_load_state("networkidle")
            foot = (f'<div style="font-size:7.5pt;color:#8a92a5;width:100%;padding:0 18mm;display:flex;justify-content:space-between">'
                    f'<span>{meta.get("doc","")} · {meta.get("title","")} · v{meta.get("version","").split(" ")[0]}</span>'
                    f'<span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>')
            pdf = OUT / f"{f.stem}.pdf"
            pg.pdf(path=str(pdf), format="A4", print_background=True, display_header_footer=True,
                   header_template="<div></div>", footer_template=foot,
                   margin={"top": "20mm", "bottom": "18mm", "left": "18mm", "right": "18mm"})
            tmp.unlink()
            results[f.stem] = (meta, hashlib.sha256(pdf.read_bytes()).hexdigest())
            print(f"{pdf.name}  {results[f.stem][1][:16]}")
        b.close()
    return results

if __name__ == "__main__":
    render(sys.argv[1:] or None)
