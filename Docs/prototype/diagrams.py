"""Hand-built SVG diagrams for the HLD/LLD. No graphviz needed."""
from pathlib import Path

OUT = Path(__file__).parent.parent / "assets"
FONT = 'font-family="Segoe UI, DejaVu Sans, sans-serif"'

def box(x, y, w, h, title, lines=(), fill="#ffffff", stroke="#9aa4ba", tcol="#1d2330"):
    s = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>'
    s += f'<text x="{x + w/2}" y="{y + 22}" text-anchor="middle" font-size="14" font-weight="600" fill="{tcol}" {FONT}>{title}</text>'
    for i, l in enumerate(lines):
        s += f'<text x="{x + w/2}" y="{y + 42 + i*16}" text-anchor="middle" font-size="11.5" fill="#4a5368" {FONT}>{l}</text>'
    return s

def group(x, y, w, h, label, fill="#f4f6fa"):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="#c5cbd8" stroke-dasharray="5 4"/>'
            f'<text x="{x + 12}" y="{y + 20}" font-size="12" font-weight="700" fill="#6b748a" {FONT}>{label}</text>')

def arrow(x1, y1, x2, y2, label="", dash=False, lx=None, ly=None):
    d = ' stroke-dasharray="5 4"' if dash else ""
    s = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#4a5368" stroke-width="1.4" marker-end="url(#a)"{d}/>'
    if label:
        lx = lx if lx is not None else (x1 + x2) / 2 + 6
        ly = ly if ly is not None else (y1 + y2) / 2 - 4
        s += f'<text x="{lx}" y="{ly}" font-size="11" fill="#2d4fd1" {FONT}>{label}</text>'
    return s

def svg(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
            '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            '<path d="M0,0 L10,5 L0,10 z" fill="#4a5368"/></marker></defs>'
            f'<rect width="{w}" height="{h}" fill="#ffffff"/>{body}</svg>')

BLUE, PURP, GRN, AMB = "#eef2ff", "#f3f0ff", "#ecf8f0", "#fff7e8"

# 1. System context
ctx = svg(1000, 520,
    box(30, 30, 190, 70, "Tester / QA lead", ["reviews, approves, rules"], fill=AMB)
    + box(30, 220, 190, 90, "Story source", ["ADO · Jira · pasted text", "· .feature file (optional)"])
    + box(30, 400, 190, 80, "Website under test", ["any URL the user", "is allowed to test"])
    + group(280, 20, 420, 480, "attestqa (on the user's machine or company server)")
    + box(310, 60, 360, 70, "Review UI", ["Explore · Specify · Attest · Ledger"], fill=BLUE)
    + box(310, 170, 360, 90, "Governed runtime (core)", ["model proposes → gate → skill rules", "→ human approval → tool call"], fill=PURP)
    + box(310, 300, 170, 80, "Playwright", ["drives the browser"])
    + box(500, 300, 170, 80, "Ledger", [".aqa/runs/<id>/", "events.jsonl"], fill=GRN)
    + box(310, 410, 360, 70, "Test project folder", ["features/ · tests/ · pages/ — plain Playwright"], fill=GRN)
    + box(770, 150, 200, 110, "Model provider", ["Anthropic · OpenAI · Azure", "Bedrock · gateway · local", "(company's own account)"], fill=AMB)
    + box(770, 330, 200, 80, "Company identity", ["Entra ID · AWS SSO", "· API key in OS vault"])
    + arrow(220, 65, 310, 90, "approve / rule")
    + arrow(220, 265, 310, 215, "story", ly=232)
    + arrow(490, 130, 490, 170)
    + arrow(395, 260, 395, 300)
    + arrow(585, 260, 585, 300)
    + arrow(310, 345, 220, 435, "browser", lx=228, ly=380)
    + arrow(670, 205, 770, 205, "prompt+tools", lx=676, ly=198)
    + arrow(870, 330, 870, 260, "token", lx=878)
    + arrow(395, 380, 395, 410, "writes code", lx=403, ly=400)
)

# 2. Desktop processes
desk = svg(1000, 470,
    group(20, 20, 960, 430, "Winapp — Electron, Windows")
    + box(50, 60, 280, 150, "Renderer", ["@attestqa/ui (React)", "IpcClient implements AttestClient", "no secrets, no Node access", "contextIsolation · sandbox"], fill=BLUE)
    + box(380, 60, 260, 150, "Main process", ["preload bridge (typed IPC)", "credential vault (DPAPI)", "provider + token sources", "project + settings store"], fill=AMB)
    + box(690, 60, 260, 150, "Run worker", ["utilityProcess, one per run", "attestqa core loop", "ledger writer", "Playwright (child process)"], fill=PURP)
    + box(690, 280, 260, 120, "Chromium under test", ["v1: headed window", "v2: WebContentsView + CDP"])
    + box(380, 280, 260, 120, "Disk (user-owned)", ["TestRunApplication/<site>/", ".aqa/runs/<id>/events.jsonl", "ai-quality.config.yaml"], fill=GRN)
    + box(50, 280, 280, 120, "Outside", ["model endpoint (HTTPS)", "story tracker (optional)", "nothing else"])
    + arrow(330, 120, 380, 120, "invoke / on", ly=112)
    + arrow(640, 120, 690, 120, "port", lx=650, ly=112)
    + arrow(690, 170, 640, 170, "approval?", ly=162, lx=644)
    + arrow(820, 210, 820, 280, "drives", lx=828)
    + arrow(690, 200, 600, 280, "append-only", lx=600, ly=250)
    + arrow(510, 210, 330, 300, "HTTPS (token from main)", lx=330, ly=250)
)

# 3. Web
web = svg(1000, 430,
    box(30, 60, 200, 110, "Browser", ["@attestqa/ui (React)", "HttpClient implements", "AttestClient"], fill=BLUE)
    + group(270, 20, 480, 390, "WebApplication — company-hosted")
    + box(300, 60, 420, 80, "@attestqa/server", ["REST + SSE for the UI · MCP endpoint for IDE agents", "OIDC sign-in (Entra/Okta) · roles: viewer, approver"], fill=AMB)
    + box(300, 180, 200, 100, "Run workers", ["same core loop", "one container per run"], fill=PURP)
    + box(520, 180, 200, 100, "Secret store", ["Key Vault / Secrets", "Manager / env"])
    + box(300, 310, 420, 80, "Run storage", ["ledgers + generated projects → git repo or object store"], fill=GRN)
    + box(790, 60, 180, 100, "IDE agent", ["Copilot / Claude Code", "via MCP: run_story,", "run_status, resources"])
    + box(790, 200, 180, 80, "Model provider", ["company account"], fill=AMB)
    + arrow(230, 110, 300, 100, "HTTPS", ly=96)
    + arrow(790, 110, 720, 100, "MCP", ly=96, lx=735)
    + arrow(400, 140, 400, 180)
    + arrow(500, 230, 520, 230)
    + arrow(400, 280, 400, 310)
    + arrow(500, 210, 790, 240, "inference", lx=640, ly=215)
)

# 4. One governed step
seq_lines = [
    ("Model", "Runtime", "decide(): proposes fs.write_file(spec, content)"),
    ("Runtime", "Runtime", "ScopedGate: path in scope? class = write_workspace"),
    ("Runtime", "Runtime", "Skill rules: writeOnExecutePath, weakensAQuarantinedTest, …"),
    ("Runtime", "Ledger", "refusal event (if any rule fires) → shown to model next cycle"),
    ("Runtime", "UI", "approval request (if gate needs a human)"),
    ("UI", "Runtime", "approve / deny + reason (author = signed-in user)"),
    ("Runtime", "Ledger", "call event → tool runs → observation event"),
    ("Runtime", "Model", "next cycle prompt rebuilt from the ledger"),
]
cols = {"Model": 100, "Runtime": 360, "Ledger": 620, "UI": 880}
body = ""
for name, x in cols.items():
    body += box(x - 70, 20, 140, 40, name, fill=BLUE if name == "UI" else PURP if name == "Runtime" else GRN if name == "Ledger" else AMB)
    body += f'<line x1="{x}" y1="60" x2="{x}" y2="{80 + len(seq_lines)*48}" stroke="#c5cbd8" stroke-dasharray="4 4"/>'
for i, (a, b, label) in enumerate(seq_lines):
    y = 95 + i * 48
    xa, xb = cols[a], cols[b]
    if xa == xb:
        body += f'<path d="M{xa},{y} h40 v18 h-36" fill="none" stroke="#4a5368" stroke-width="1.4" marker-end="url(#a)"/>'
        body += f'<text x="{xa + 50}" y="{y + 13}" font-size="11.5" fill="#1d2330" {FONT}>{i+1}. {label}</text>'
    else:
        body += arrow(xa, y, xb, y)
        lx = min(xa, xb) + 8
        body += f'<text x="{lx}" y="{y - 6}" font-size="11.5" fill="#1d2330" {FONT}>{i+1}. {label}</text>'
seq = svg(1000, 110 + len(seq_lines) * 48, body)

for name, s in {"d1_context": ctx, "d2_desktop": desk, "d3_web": web, "d4_step": seq}.items():
    (OUT / f"{name}.svg").write_text(s, encoding="utf-8")
    print("wrote", name)
