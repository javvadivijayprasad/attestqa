"""Builds the attestqa UI prototype screens as HTML, then screenshots them."""
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
CSS = (HERE / "proto.css").read_text()

def rail(on):
    items = [("first", "⌂", "Home"), ("reqs", "▤", "Reqs"), ("explore", "◎", "Explore"), ("specify", "✎", "Specify"),
             ("attest", "✓", "Attest"), ("ledger", "≡", "Ledger"), ("settings", "⚙", "Settings")]
    links = "".join(f'<a class="{"on" if k == on else ""}"><b>{i}</b>{t}</a>' for k, i, t in items)
    return f'<nav class="rail"><div class="logo">aq</div>{links}</nav>'

TYPES = [("Web", "v1.0"), ("API", "v2.0"), ("Security", "v4.0"), ("ETL", "v5.0")]

def typeswitch(on, built=("Web", "API")):
    cells = []
    for t, rel in TYPES:
        cls = "on" if t == on else ("" if t in built else "off")
        label = t if t in built else f"{t} <small>{rel}</small>"
        cells.append(f'<span class="{cls}">{label}</span>')
    return f'<span class="seg">{"".join(cells)}</span>'

def policy(mode, extra="", kind="Web"):
    sw = typeswitch(kind) if kind else ""
    return f'''<header class="policy">
  <span class="pill">{mode}</span>{sw}
  <span><span class="k">Site</span>localhost:3000 (Juice Shop)</span>
  <span><span class="k">Model</span>azure-openai · gpt-4.1 · Entra</span>
  <span><span class="k">Project</span>juice-shop</span>
  <span class="right">{extra}</span>
</header>'''

ASK = '''<footer class="ask"><input value="Ask the ledger — e.g. why is “Logout lands on /#/login” quarantined?"><small>answered from events.jsonl, not by the model</small></footer>'''

def page(on, mode, extra, body, ask=True, kind="Web"):
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head>
<body><div class="app">{rail(on)}{policy(mode, extra, kind)}<main>{body}<div style="position:fixed;right:24px;bottom:62px;color:#b7bdca;font-size:11px">prototype · illustrative data</div></main>{ASK if ask else '<footer class="ask"></footer>'}</div></body></html>'''

screens = {}

# 1 ── First run
screens["01_first_run"] = page("first", "Setup", "", kind=None, body='''
<div style="max-width:880px;margin:0 auto;width:100%;display:grid;gap:14px;align-content:start">
 <div><h1>Set up attestqa</h1><div class="sub">Three steps. Nothing leaves this computer except the model calls you configure here.</div></div>
 <div class="card"><h2>1 · Project folder</h2>
  <div class="row"><code style="flex:1;background:#f6f7f9;padding:8px;border-radius:6px">E:\\attestqa\\TestRunApplication\\juice-shop</code><span class="btn">Change…</span></div>
  <div class="sub" style="margin-top:6px">A normal Playwright project is created here. It runs with <code>npx playwright test</code> whether or not attestqa is installed.</div></div>
 <div class="card"><h2>2 · Model provider</h2>
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:10px">
   <div class="btn">Anthropic</div><div class="btn">OpenAI</div><div class="btn pri">Azure OpenAI</div><div class="btn">AWS Bedrock</div><div class="btn">Gateway</div><div class="btn">Local</div></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
   <div><div class="sub">Endpoint</div><code>https://acme.openai.azure.com</code></div>
   <div><div class="sub">Deployment</div><code>gpt-4.1</code></div>
   <div><div class="sub">Sign-in</div><span class="tag t-pass">Signed in with Microsoft Entra · vijay@acme.com</span></div>
   <div><div class="sub">Key storage</div>Windows credential vault (DPAPI) — never written to a file</div></div>
  <div style="margin-top:10px" class="row"><span class="btn">Test connection</span><span class="tag t-pass">tool call round-trip OK · 1.4 s</span></div></div>
 <div class="card"><h2>3 · Site to test</h2>
  <div class="row"><code style="flex:1;background:#f6f7f9;padding:8px;border-radius:6px">http://localhost:3000</code><span class="btn">Login details…</span></div>
  <div class="sub" style="margin-top:6px">Test-account credentials go to the credential vault. The agent can use them through the browser; it can never read them.</div></div>
 <div class="row" style="justify-content:flex-end;gap:10px"><span class="btn">I have a Selenium suite → Import</span><span class="btn">I already have a suite → Attest</span><span class="btn">I have a story → Specify</span><span class="btn pri">Explore the site →</span></div>
</div>''', ask=False)

# 2 ── Explore
screens["02_explore"] = page("explore", "Explore", '<span class="muted">no oracle in this mode — nothing is “passed” or “bug”</span>', '''
<div style="display:grid;grid-template-columns:300px 1fr 360px;gap:16px;height:770px">
 <div class="card"><h2>Site map · 14 pages</h2><div class="list mono">
  <div>/#/ <span class="muted">home, product grid</span></div><div>/#/login</div><div>/#/register</div>
  <div style="background:#eef2ff;margin:0 -16px;padding:8px 16px">/#/basket <span class="muted">← describing</span></div>
  <div>/#/address/select</div><div>/#/payment/shop</div><div>/#/order-summary</div><div>/#/search?q=</div>
  <div>/#/contact</div><div>/#/complain</div><div>/#/about</div><div>/#/photo-wall</div><div>/#/privacy-security</div><div>/#/score-board <span class="tag t-mut">out of scope</span></div></div></div>
 <div class="card" style="display:grid;grid-template-rows:auto 1fr;gap:10px"><h2>Browser — what the test sees</h2>
  <div style="border:1px solid #dde1e8;border-radius:8px;background:#fafbfc;display:grid;place-items:center;color:#8a92a5">
   <div style="text-align:center"><div style="font-size:15px;color:#1d2330;margin-bottom:6px">Your Basket (demo@juice-sh.op)</div>
    <div style="border:2px solid #3b6ef5;border-radius:6px;padding:6px 14px;color:#2d4fd1;display:inline-block">Checkout</div>
    <div style="margin-top:8px;font-size:11px">highlighted: <code>getByRole('button', {name: 'Checkout'})</code></div>
    <div style="margin-top:20px;font-size:11px">v1: headed Chromium window beside the app · v2: embedded pane</div></div></div></div>
 <div style="display:grid;gap:14px;align-content:start">
  <div class="card"><h2>Observed on /#/basket</h2><div class="list">
   <div>Basket lists items with quantity +/− and a delete icon per row.</div>
   <div>Checkout is disabled while the basket is empty.</div>
   <div>Quantity cannot go below 1 with the − button.</div>
   <div>Total updates without a page reload.</div></div>
   <div class="row" style="margin-top:8px"><span class="btn pri">Promote to feature</span><span class="btn">Look again at…</span></div></div>
  <div class="card"><h2>Open questions for you</h2><div class="list">
   <div>Should a basket survive logout? It does today. <span class="tag t-mut">needs a ruling</span></div>
   <div>Is a quantity above stock allowed? The UI accepts 99.</div></div></div>
  <div class="note">Explore writes <code>features/*.feature</code> drafts only. It never writes a spec and never files a bug.</div></div>
</div>''')

# 3 ── Specify
screens["03_specify"] = page("specify", "Specify", '<span><span class="k">Story</span>AB#44 · Logout</span><span class="ok">4 of 5 AC covered</span>', '''
<div style="display:grid;grid-template-columns:420px 1fr;gap:16px;height:770px">
 <div class="card"><h2>Story AB#44 — from Azure DevOps</h2><h3>As a signed-in shopper I can log out</h3>
  <div class="list" style="margin-top:8px">
   <div><b>AC-1</b> Account menu shows “Logout” when signed in.</div>
   <div><b>AC-2</b> Logout clears the session token.</div>
   <div><b>AC-3</b> Logout lands on <code>/#/login</code>.</div>
   <div><b>AC-4</b> Protected routes redirect to login after logout.</div>
   <div><b>AC-5</b> Logout works on mobile width. <span class="tag t-q">not covered</span></div></div>
  <div class="callout" style="margin-top:10px">PO ruling, posted as a comment on AB#44, upholds AC-3. The ruling is now a citable source for the agent.</div></div>
 <div class="card" style="display:grid;grid-template-rows:auto 1fr auto;gap:10px"><h2>Derived scenarios → generated code</h2>
  <div class="list">
   <div class="row" style="justify-content:space-between"><div><b>Logout lands on the login page</b> <span class="tag t-mut">AC-1 AC-3</span><div class="sub mono">tests/story-44.spec.ts:12 · pages/account.page.ts</div></div><div class="row"><span class="tag t-pass">approved · Vijay</span></div></div>
   <div class="row" style="justify-content:space-between"><div><b>Session token is gone after logout</b> <span class="tag t-mut">AC-2</span><div class="sub mono">tests/story-44.spec.ts:31</div></div><span class="tag t-pass">approved · Vijay</span></div>
   <div class="row" style="justify-content:space-between"><div><b>Basket route redirects after logout</b> <span class="tag t-mut">AC-4</span>
    <pre style="margin-top:6px">Scenario: Basket route redirects after logout
  Given I am signed in as the test shopper
  When I log out
  And I open "/#/basket"
  Then I am on the login page</pre></div>
    <div style="display:grid;gap:6px"><span class="btn grn">Approve</span><span class="btn">Edit text</span><span class="btn red">Reject…</span></div></div></div>
  <div class="note">Editing a scenario regenerates its spec through bdd2pw. The edit is recorded in the ledger with you as author, so the agent can never claim it.</div></div>
</div>''')

# 4 ── Attest (grouped by test type; state as of v2.0.0)
screens["04_attest"] = page("attest", "Attest", '<span class="warn">1 approval waiting</span><span><span class="k">Run</span>20261105T101500Z</span>', kind="All", body='''
<div class="tabs"><span class="on">All types · 20</span><span>Web · 14</span><span>API · 6</span><span class="off">Security — v4.0</span><span class="off">ETL — v5.0</span></div>
<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">
 <div class="card"><div class="sub">Passed</div><div class="stat" style="color:#1d7a46">15</div><div class="sub">web 11 · api 4</div></div>
 <div class="card"><div class="sub">Failed</div><div class="stat" style="color:#a8261b">3</div><div class="sub">web 1 · api 2</div></div>
 <div class="card"><div class="sub">Quarantined</div><div class="stat" style="color:#9a5a00">2</div><div class="sub">web 2</div></div>
 <div class="card"><div class="sub">Agent writes refused</div><div class="stat" style="color:#6230c4">4</div><div class="sub">writeOnExecutePath 3 · statusWidened 1</div></div>
 <div class="card"><div class="sub">Counted from</div><div class="mono" style="margin-top:8px">events.jsonl · 288 events</div></div></div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;height:560px">
 <div class="card"><h2>Failures</h2>
  <div class="list" style="margin-bottom:8px">
   <div class="row" style="justify-content:space-between"><span><span class="tag t-mut">WEB</span> Logout lands on the login page</span><span class="tag t-fail">real defect · #87</span></div>
   <div class="row" style="justify-content:space-between;background:#eef2ff;margin:0 -16px;padding:8px 16px"><span><span class="tag t-mut">API</span> <b>Basket is not readable after logout</b></span><span class="tag t-fail">real defect · 0.91</span></div>
   <div class="row" style="justify-content:space-between"><span><span class="tag t-mut">API</span> Order history requires a token</span><span class="tag t-q">environmental · 0.72</span></div></div>
  <pre>const res = await request.get('/rest/basket/1', { headers: oldToken });
expect(res.status()).toBe(401)
Received: 200</pre>
  <div class="list"><div><b>Already recorded</b> — #83 [Active] protected route reachable after logout — reproduced again, now at the API.</div>
   <div><b>Oracle</b> — AC-4 on AB#44, and the OpenAPI contract: <code>GET /rest/basket/{id}</code> declares 401 without a valid session.</div></div>
  <div class="row" style="margin-top:10px"><span class="btn red">Confirm as defect</span><span class="btn">Rule: not a defect…</span><span class="btn">Leave open</span></div></div>
 <div class="card"><h2>What the agent tried — refused by the gate</h2>
  <div class="row" style="margin-bottom:6px"><span class="tag t-ref">refused</span><b>fs.write_file</b><code>tests/api/story-44.api.spec.ts</code></div>
  <pre><span class="del">-  expect(res.status()).toBe(401);</span><span class="add">+  expect([200, 401]).toContain(res.status());</span></pre>
  <div class="callout" style="margin-top:8px"><b>statusWidened:</b> this write accepts a status the oracle forbids. The contract says 401; 200 is the defect, not a variant. A test may be strengthened; it may not be softened. Leave it red and report it.</div>
  <div class="sub" style="margin-top:8px">Same rule family as web: <code>writeOnExecutePath</code> refused 3 assertion rewrites in this run. The agent has no tool that could make either kind of write happen.</div></div></div>''')

# 6 ── Requirements
screens["06_requirements"] = page("reqs", "Requirements", '<span><span class="k">Source</span>Azure DevOps · JuiceShop-QA · Sprint 14</span><span class="ok">read-only</span>', kind="All", body='''
<div class="row" style="justify-content:space-between">
 <div class="row" style="gap:10px"><span class="btn pri">Azure DevOps</span><span class="btn">Jira</span><span class="btn">Paste a story</span><span class="btn">.feature file</span></div>
 <div class="row" style="gap:10px"><code style="background:#fff;border:1px solid #dde1e8;padding:6px 10px;border-radius:6px">Sprint 14 · area JuiceShop\\Checkout · 6 stories</code><span class="btn">Change query…</span></div></div>
<div class="card" style="padding:6px 16px">
 <table class="grid">
  <tr><th style="width:34%">Story / acceptance criterion</th><th class="c">Web</th><th class="c">API</th><th class="c">Security <small>v4.0</small></th><th class="c">ETL <small>v5.0</small></th><th>Last result</th></tr>
  <tr><td><b>AB#44 Logout</b> <span class="sub">5 AC · PO ruling on AC-3</span></td><td class="c"><span class="dot d-ok">4/5</span></td><td class="c"><span class="dot d-ok">2/2</span></td><td class="c"><span class="dot d-no">planned</span></td><td class="c"><span class="dot d-na">n/a</span></td><td><span class="tag t-fail">2 failing</span> #87 · #83</td></tr>
  <tr><td style="padding-left:22px">AC-3 Logout lands on /#/login</td><td class="c"><span class="dot d-fail">fail</span></td><td class="c"><span class="dot d-na">—</span></td><td class="c"><span class="dot d-na">—</span></td><td class="c"><span class="dot d-na">—</span></td><td class="mono">tests/web/story-44.spec.ts:12</td></tr>
  <tr><td style="padding-left:22px">AC-4 Protected routes redirect after logout</td><td class="c"><span class="dot d-ok">pass</span></td><td class="c"><span class="dot d-fail">fail</span></td><td class="c"><span class="dot d-no">planned</span></td><td class="c"><span class="dot d-na">—</span></td><td class="mono">tests/api/story-44.api.spec.ts:20</td></tr>
  <tr><td style="padding-left:22px">AC-5 Logout works at mobile width</td><td class="c"><span class="dot d-no">none</span></td><td class="c"><span class="dot d-na">—</span></td><td class="c"><span class="dot d-na">—</span></td><td class="c"><span class="dot d-na">—</span></td><td><span class="btn" style="padding:2px 8px">Specify…</span></td></tr>
  <tr><td><b>AB#51 Apply coupon at checkout</b> <span class="sub">4 AC</span></td><td class="c"><span class="dot d-ok">4/4</span></td><td class="c"><span class="dot d-ok">3/4</span></td><td class="c"><span class="dot d-no">planned</span></td><td class="c"><span class="dot d-na">n/a</span></td><td><span class="tag t-pass">all passing</span></td></tr>
  <tr><td><b>AB#52 Order history export</b> <span class="sub">3 AC</span></td><td class="c"><span class="dot d-no">0/3</span></td><td class="c"><span class="dot d-no">0/3</span></td><td class="c"><span class="dot d-na">n/a</span></td><td class="c"><span class="dot d-no">planned</span></td><td><span class="btn" style="padding:2px 8px">Specify…</span></td></tr>
  <tr><td><b>AB#53 Nightly sales load to warehouse</b> <span class="sub">4 AC · mapping doc attached</span></td><td class="c"><span class="dot d-na">n/a</span></td><td class="c"><span class="dot d-na">n/a</span></td><td class="c"><span class="dot d-na">n/a</span></td><td class="c"><span class="dot d-no">0/4</span></td><td class="sub">waits for ETL (v5.0)</td></tr>
 </table></div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
 <div class="note">Coverage is computed from the generated code and the ledger, never from the model. A criterion counts as covered only when an approved test cites it.</div>
 <div class="callout">The tracker is read-only. The one write attestqa can make is a new bug, after you confirm a defect on the Attest screen.</div></div>''')

# 5 ── Approval
screens["05_approval"] = page("attest", "Attest", '<span class="warn">approval waiting</span>', '''
<div style="display:grid;place-items:center">
<div class="card" style="width:820px;margin-top:150px;box-shadow:0 12px 40px rgba(20,30,60,.18)">
 <div class="row" style="justify-content:space-between"><h1>The agent wants to change a test</h1><span class="tag t-q">write_workspace · needs you</span></div>
 <div class="sub" style="margin-bottom:10px">Proposed in inference 9 of run 20261105T101500Z. Gate checks passed: it is a locator repair, no assertion is removed.</div>
 <div class="row" style="margin-bottom:6px"><b>fs.write_file</b><code>pages/account.page.ts</code></div>
 <pre><span class="del">-  readonly logout = this.page.locator('#navbarLogoutButton');</span><span class="add">+  readonly logout = this.page.getByRole('menuitem', { name: 'Logout' });</span></pre>
 <div style="margin:10px 0" class="list">
  <div><b>Why (agent)</b> — the id was removed in the current build; the menu item is found by role and name in the last observation.</div>
  <div><b>Evidence</b> — observation 8: <code>locator('#navbarLogoutButton') resolved to 0 elements</code>; snapshot shows <code>menuitem "Logout"</code>.</div></div>
 <div class="row" style="justify-content:flex-end;gap:10px"><span class="btn">View the whole file</span><span class="btn red">Deny with reason</span><span class="btn pri">Approve this write</span></div>
 <div class="sub" style="margin-top:8px">Your answer is written to the ledger with your name. A denial is shown to the agent with your reason.</div>
</div></div>''')

def main():
    out = HERE.parent / "assets"
    out.mkdir(exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        for name, html in screens.items():
            f = HERE / f"{name}.html"
            f.write_text(html, encoding="utf-8")
            pg.goto(f.as_uri())
            pg.screenshot(path=str(out / f"{name}.png"))
            print("wrote", name)
        b.close()

if __name__ == "__main__":
    main()
