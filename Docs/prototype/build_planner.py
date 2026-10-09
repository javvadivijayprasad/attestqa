import datetime as dt
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.utils import get_column_letter

F = "Arial"
H = Font(name=F, bold=True, color="FFFFFF"); HF = PatternFill("solid", fgColor="1B2130")
B = Font(name=F); BB = Font(name=F, bold=True)
INP = Font(name=F, color="0000FF"); YEL = PatternFill("solid", fgColor="FFF2CC")
thin = Side(style="thin", color="D5DAE3"); BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
WRAP = Alignment(wrap_text=True, vertical="top")

releases = [
 ("v1.0.0", dt.date(2026,10,12), dt.date(2026,11,15), "Major: engine and CLI: Jira/ADO stories to governed tests, any company model"),
 ("v1.1.0", dt.date(2026,11,16), dt.date(2026,12,15), "Company sign-in, healing suggestions, Selenium import"),
 ("v1.2.0", dt.date(2026,12,16), dt.date(2027,1,15), "First signed Windows app: Attest"),
 ("v1.3.0", dt.date(2027,1,16), dt.date(2027,2,15), "Requirements and Specify in the app"),
 ("v1.4.0", dt.date(2027,2,16), dt.date(2027,3,15), "Explore; web testing complete"),
 ("v2.0.0", dt.date(2027,3,16), dt.date(2027,4,15), "Major: API testing"),
 ("v2.1.0", dt.date(2027,4,16), dt.date(2027,5,15), "API Explore; contracts from traffic"),
 ("v3.0.0", dt.date(2027,5,16), dt.date(2027,6,15), "Major: web version of attestqa"),
 ("v3.1.0", dt.date(2027,6,16), dt.date(2027,7,15), "MCP and multi-user approvals"),
 ("v4.0.0", dt.date(2027,7,16), dt.date(2027,8,15), "Major: security testing"),
 ("v4.1.0", dt.date(2027,8,16), dt.date(2027,9,15), "Active scanning"),
 ("v5.0.0", dt.date(2027,9,16), dt.date(2027,10,15), "Major: ETL testing; all four types"),
]
items = {
 "v1.0.0": [("Monorepo set-up, subtree import of agentic-qa, research log live",15),("Publish attestqa 1.1.0 and the compatibility shim from the old repository",3),("Engine 2.0: ledger additions, tool literal, replay tests over the Paper I corpus",25),("Provider conformance suite, TokenSource, registerProvider, gateway",20),("Tracker interface over the Azure DevOps MCP path; Jira adapter",40),("Coverage tags and aqa coverage; report completeness",25),("synthdata as a package; shared triage fixtures with pw-triage",10)],
 "v1.1.0": [("AWS Bedrock provider; Entra ID and AWS SSO token sources",37),("pw-self-heal in the heal role, suggest-only, with fixture test",20),("aqa import selenium through sel2pw",12),("Desktop groundwork: client interface, FakeClient, Electron skeleton",45)],
 "v1.2.0": [("Attest screen and approval dialog",45),("Worker process, credential vault, validated IPC",25),("Headed Chromium; ledger question box",20),("Renderer-secrets tests; code signing, installer, auto-update",35)],
 "v1.3.0": [("First-run flow, provider round-trip test, site login",30),("Requirements screen: ADO/Jira, query, coverage grid",35),("Specify screen via bdd2pw and pw-emit; user_edit events",45),("Selenium import entry in the app",10)],
 "v1.4.0": [("Web Explore: skill, refusal rules, site map, drafts, rulings",70),("App accessibility and end-to-end tests",25),("User guide and demo video",20)],
 "v2.0.0": [("pw-emit 1.4 with API, security and ETL nodes (pw-emit repo)",20),("api adapter, api_hosts scope, three API refusal rules",35),("API in Specify, Attest, coverage; type switch",25),("API targets onboarded; study S2 cross-model runs",30)],
 "v2.1.0": [("API Explore from OpenAPI or recorded traffic",25),("usagecontract as second API oracle",20),("Study S3 cross-site runs; hardening",55)],
 "v3.0.0": [("@attestqa/server REST + live updates; HttpClient",55),("OIDC sign-in and roles",20),("Run queue and container workers",30)],
 "v3.1.0": [("MCP endpoint (run_story, run_status, resources)",30),("Container image and deployment guide",25),("Multi-user approvals; server security review",45)],
 "v4.0.0": [("Passive security checks in Playwright",30),("adapter-zap: passive scan and spider",35),("ASVS mapping; three security refusal rules; UI",40)],
 "v4.1.0": [("Active scan behind authorisation; ZAP findings as results; S4 security",45),("adapter-sql: read-only parser and connections (ships in v5.0.0)",50),("Hardening",15)],
 "v5.0.0": [("Mapping format; ETL Explore; three ETL refusal rules",50),("Reference load with synthdata and seeded faults",20),("ETL in the app; S4 ETL runs",25),("First-year review and year-two roadmap",15)],
}

wb = Workbook()

def header(ws, row, cols, widths):
    for i,(c,w) in enumerate(zip(cols,widths),1):
        cell = ws.cell(row=row, column=i, value=c); cell.font=H; cell.fill=HF; cell.alignment=Alignment(wrap_text=True, vertical="center"); cell.border=BOX
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = ws.cell(row=row+1, column=1)

# ---- How to use
ws = wb.active; ws.title = "How to use"
ws.column_dimensions["A"].width = 26; ws.column_dimensions["B"].width = 95
lines = [
 ("attestqa planner", ""),
 ("Source", "AQ-05 Implementation Plan and Release Schedule v1.3 (10 Oct 2026). Planned hours are estimates from that document."),
 ("Capacity", "4–5 hours a day, 7 days a week, as stated by Vijay. Daily capacity is set once on the Settings sheet."),
 ("What to fill in", "Only cells with blue text on a yellow background. Everything else is calculated."),
 ("Daily log", "Each day: hours worked, the release it went to (filled automatically from the date), what you did, and whether the journal line was written."),
 ("Work items", "When an item is done: actual hours and status. Status choices: Not started, In progress, Done, Moved."),
 ("Releases", "Calculated: planned hours, hours logged in that cycle, capacity of the cycle, and the gap. Fill in the release status and the Zenodo DOI after release day."),
 ("Weeks", "Calculated weekly totals against 31 hours, for a quick check every Sunday."),
 ("Example daily entry", "Date 12 Oct 2026 · Hours 4.5 · What I did: 'Monorepo created; agentic-qa history imported with git subtree; f2771d4 resolves' · Journal: Yes"),
 ("Rule from AQ-05 §6", "A release ships on the 15th with whatever is finished and tested. Unfinished work items are marked Moved and added to the next release."),
]
for r,(a,b) in enumerate(lines,1):
    ws.cell(row=r, column=1, value=a).font = Font(name=F, bold=True, size=14 if r==1 else 10)
    c = ws.cell(row=r, column=2, value=b); c.font=B; c.alignment=WRAP

# ---- Settings
st = wb.create_sheet("Settings")
st.column_dimensions["A"].width = 30; st.column_dimensions["B"].width = 14; st.column_dimensions["C"].width = 60
st["A1"] = "Setting"; st["B1"] = "Value"; st["C1"] = "Note"
for c in ("A1","B1","C1"): st[c].font=H; st[c].fill=HF
st["A2"] = "Planned hours per day"; st["B2"] = 4.5; st["C2"] = "Stated by Vijay: 4–5 hours a day, 7 days a week"
st["A3"] = "Planned hours per week"; st["B3"] = "=B2*7"; st["C3"] = "Calculated"
st["A4"] = "Share of capacity planned as work"; st["B4"] = 0.85; st["C4"] = "AQ-05 §1: about 115 of 135 hours a month; the rest is slack"
for r in range(2,5):
    for col in "ABC": st[f"{col}{r}"].font = B
st["B2"].font = INP; st["B2"].fill = YEL; st["B4"].font = INP; st["B4"].fill = YEL; st["B4"].number_format = "0%"; st["B3"].number_format="0.0"

# ---- Work items
wi = wb.create_sheet("Work items")
cols = ["Release","#","Work item","Planned h","Actual h","Status","Done on","Notes"]
header(wi, 1, cols, [10,5,62,11,10,13,12,40])
r = 2
for rel, lst in items.items():
    for n,(t,h) in enumerate(lst,1):
        vals = [rel, n, t, h, None, "Not started", None, None]
        for ci,v in enumerate(vals,1):
            c = wi.cell(row=r, column=ci, value=v); c.font=B; c.border=BOX; c.alignment=WRAP
        for ci in (5,6,7,8):
            wi.cell(row=r, column=ci).font=INP; wi.cell(row=r, column=ci).fill=YEL
        wi.cell(row=r, column=7).number_format = "dd mmm yyyy"
        r += 1
last_wi = r-1
dv = DataValidation(type="list", formula1='"Not started,In progress,Done,Moved"', allow_blank=False)
wi.add_data_validation(dv); dv.add(f"F2:F{last_wi}")
wi.cell(row=r+1, column=3, value="Total").font=BB
wi.cell(row=r+1, column=4, value=f"=SUM(D2:D{last_wi})").font=BB
wi.cell(row=r+1, column=5, value=f"=SUM(E2:E{last_wi})").font=BB
wi.conditional_formatting.add(f"A2:H{last_wi}", FormulaRule(formula=[f'$F2="Done"'], fill=PatternFill("solid", fgColor="E4F5EA")))
wi.conditional_formatting.add(f"A2:H{last_wi}", FormulaRule(formula=[f'$F2="Moved"'], fill=PatternFill("solid", fgColor="FDE8E6")))

# ---- Daily log
dl = wb.create_sheet("Daily log")
header(dl, 1, ["Date","Day","Release cycle","Hours","What I did","Journal written?"], [13,7,13,8,80,15])
start, end = dt.date(2026,10,12), dt.date(2027,10,15)
d = start; r = 2
while d <= end:
    dl.cell(row=r, column=1, value=d).number_format = "dd mmm yyyy"
    dl.cell(row=r, column=2, value=f'=TEXT(A{r},"ddd")')
    dl.cell(row=r, column=3, value=f"=INDEX(Releases!$A$2:$A$13,MATCH(A{r},Releases!$B$2:$B$13,1))")
    for ci in range(1,7):
        c = dl.cell(row=r, column=ci); c.font = B if ci<=3 else INP; c.border=BOX
        if ci>=4: c.fill=YEL
    d += dt.timedelta(days=1); r += 1
last_dl = r-1
jv = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True); dl.add_data_validation(jv); jv.add(f"F2:F{last_dl}")
hv = DataValidation(type="decimal", operator="between", formula1="0", formula2="16", allow_blank=True); dl.add_data_validation(hv); hv.add(f"D2:D{last_dl}")
dl.conditional_formatting.add(f"A2:F{last_dl}", FormulaRule(formula=[f'$A2=TODAY()'], fill=PatternFill("solid", fgColor="EEF2FF")))

# ---- Releases
rl = wb.create_sheet("Releases", 1)
header(rl, 1, ["Release","Cycle starts","Release date","Headline","Days in cycle","Capacity h","Planned work h","Planned / capacity","Hours logged","Logged − planned","Items done","Items total","Status","Zenodo DOI"],
       [10,13,13,58,9,10,11,11,10,11,9,9,13,26])
for i,(rel,s0,e0,head) in enumerate(releases):
    r = i+2
    vals = [rel, s0, e0, head,
            f"=C{r}-B{r}+1",
            f"=E{r}*Settings!$B$2",
            f"=SUMIFS('Work items'!$D$2:$D${last_wi},'Work items'!$A$2:$A${last_wi},A{r})",
            f"=IF(F{r}=0,0,G{r}/F{r})",
            f"=SUMIFS('Daily log'!$D$2:$D${last_dl},'Daily log'!$C$2:$C${last_dl},A{r})",
            f"=I{r}-G{r}",
            f"=COUNTIFS('Work items'!$A$2:$A${last_wi},A{r},'Work items'!$F$2:$F${last_wi},\"Done\")",
            f"=COUNTIFS('Work items'!$A$2:$A${last_wi},A{r})",
            "Planned", None]
    for ci,v in enumerate(vals,1):
        c = rl.cell(row=r, column=ci, value=v); c.font=B; c.border=BOX; c.alignment=WRAP
    rl.cell(row=r,column=2).number_format = rl.cell(row=r,column=3).number_format = "dd mmm yyyy"
    rl.cell(row=r,column=6).number_format = "0"; rl.cell(row=r,column=8).number_format="0%"; rl.cell(row=r,column=10).number_format="0;-0;-"
    for ci in (13,14): rl.cell(row=r,column=ci).font=INP; rl.cell(row=r,column=ci).fill=YEL
sv = DataValidation(type="list", formula1='"Planned,In progress,Released,Hardening release"', allow_blank=False); rl.add_data_validation(sv); sv.add("M2:M13")
rl.cell(row=15, column=4, value="Total").font=BB
for col in "FGI":
    c = rl[f"{col}15"]; c.value = f"=SUM({col}2:{col}13)"; c.font=BB; c.number_format="#,##0"
rl["H15"] = "=IF(F15=0,0,G15/F15)"; rl["H15"].font=BB; rl["H15"].number_format="0%"
rl.conditional_formatting.add("H2:H13", CellIsRule(operator="greaterThan", formula=["Settings!$B$4"], fill=PatternFill("solid", fgColor="FDE8E6")))
rl["D17"] = "Planned / capacity turns red above the share set on Settings (85%)."; rl["D17"].font=Font(name=F, italic=True, color="6B748A")

# ---- Weeks
wk = wb.create_sheet("Weeks")
header(wk, 1, ["Week starting (Mon)","Week ending","Planned h","Logged h","Gap"], [18,14,10,10,10])
d = dt.date(2026,10,12); r=2
while d <= end:
    wk.cell(row=r,column=1,value=d).number_format="dd mmm yyyy"
    wk.cell(row=r,column=2,value=f"=A{r}+6").number_format="dd mmm yyyy"
    wk.cell(row=r,column=3,value="=Settings!$B$3").number_format="0.0"
    wk.cell(row=r,column=4,value=f"=SUMIFS('Daily log'!$D$2:$D${last_dl},'Daily log'!$A$2:$A${last_dl},\">=\"&A{r},'Daily log'!$A$2:$A${last_dl},\"<=\"&B{r})").number_format="0.0"
    wk.cell(row=r,column=5,value=f"=D{r}-C{r}").number_format="0.0;-0.0;-"
    for ci in range(1,6): wk.cell(row=r,column=ci).font=B; wk.cell(row=r,column=ci).border=BOX
    d += dt.timedelta(days=7); r+=1

out = "/home/claude/aq/planner/attestqa_Planner.xlsx"
wb.save(out); print(out, "work items", last_wi-1, "days", last_dl-1)
