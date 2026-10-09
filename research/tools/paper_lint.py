"""Check the Paper I living manuscript against the research record.

Usage (from E:\\EB1A_Research):
    python Application\\attestqa\\research\\tools\\paper_lint.py

Reports:
  - lines that state a claim but carry neither a finding id nor [frame]
  - finding ids used in the manuscript that do not exist in findings.jsonl
  - runs cited by those findings that are missing from runs-manifest.csv
  - findings tagged for Paper I that no line uses yet
Exit code 1 if any of the first three are found.
"""
import csv, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve()
RESEARCH = HERE.parents[1]
FINDINGS = RESEARCH / "findings.jsonl"
MANIFEST = RESEARCH / "runs-manifest.csv"
MANUSCRIPT = HERE.parents[4] / "EB1_Master" / "06_Authorship" / "Paper_I_AgenticQA" / "Article" / "living" / "paper_I_living.md"

LINE = re.compile(r"^- \[(?P<tag>F-\d{4}|frame)\](?: \[(?P<date>\d{4}-\d{2}-\d{2})\])? \[(?P<status>draft|checked|withdrawn)\] ")
FID = re.compile(r"F-\d{4}")

def main(manuscript=MANUSCRIPT):
    findings = {}
    if FINDINGS.exists():
        for n, raw in enumerate(FINDINGS.read_text(encoding="utf-8").splitlines(), 1):
            if raw.strip():
                f = json.loads(raw)
                findings[f["id"]] = f
    runs = set()
    if MANIFEST.exists():
        with MANIFEST.open(encoding="utf-8") as fh:
            runs = {r["run_id"] for r in csv.DictReader(fh)}

    problems, used = [], set()
    in_rules = False
    for n, line in enumerate(Path(manuscript).read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("## How this file works"):
            in_rules = True; continue
        if in_rules and line.startswith("## "):
            in_rules = False
        if in_rules or not line.startswith("- "):
            continue
        m = LINE.match(line)
        if not m:
            problems.append(f"line {n}: claim line without [F-nnnn] or [frame] and a status: {line[:80]}")
            continue
        for fid in FID.findall(line):
            used.add(fid)
            if fid not in findings:
                problems.append(f"line {n}: {fid} is not in findings.jsonl")
                continue
            for ev in findings[fid].get("evidence", []):
                run = ev.get("run")
                if run and runs and run not in runs:
                    problems.append(f"line {n}: {fid} cites run {run}, which is not in runs-manifest.csv")

    unused = [fid for fid, f in sorted(findings.items()) if "I" in f.get("paper", []) and fid not in used]
    for p in problems:
        print("PROBLEM", p)
    for fid in unused:
        print("UNUSED ", fid, "-", findings[fid].get("summary", "")[:70])
    print(f"{len(findings)} findings, {len(used)} used in the manuscript, {len(problems)} problems, {len(unused)} Paper I findings not yet used")
    return 1 if problems else 0

if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
