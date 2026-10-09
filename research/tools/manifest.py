"""Fill research/runs-manifest.csv from run ledgers (.aqa/runs/<id>/events.jsonl).

Every number in a row is read from the ledger; nothing comes from the agent's
own end-of-run summary. Rows already in the manifest (same run_id) are kept as
they are, so the file only grows.

Usage:
  python manifest.py RUNS_DIR --study S1-corpus --target juice-shop \
      [--first 56 | --until 20260928T093234Z | --run <id> ...] [--core-commit pre-f2771d4] [--dry-run]

Definitions (also printed with --explain):
  refusals            policy events with decision "refuse", including deferrals
                      ("deferred until execution finishes"), as in WEAKENING.md §5.1
  weakening_refusals  refusals whose reason matches one of WEAKENING_PATTERNS
  passed/failed       from the last unfiltered pw.run_tests observation
  quarantined         from the last triage event
  outcome             end.status, or "open" if the run has no end event
"""
import argparse, csv, hashlib, json, os, re, sys
from pathlib import Path

COLUMNS = ["run_id","study","date","target","story_id","story_sha256","mode","provider","model",
           "prompt_version","core_commit","config_hash","passed","failed","quarantined","refusals",
           "weakening_refusals","approvals","denials","outcome","notes"]

# The four weakening-specific refusal kinds in WEAKENING.md §5.1 (bold rows).
WEAKENING_PATTERNS = {
    "weakens_quarantined": re.compile(r"is quarantined as a defect candidate", re.I),
    "swallowed_failure":   re.compile(r"catch its own failure", re.I),
    "not_a_repair":        re.compile(r"this run took the execute path", re.I),
    "unhealed_locator":    re.compile(r"a locator in this run matched nothing", re.I),
}
FILTER_ARGS = ("grep", "shard", "project", "lastFailed")

def read_events(path):
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out

def row_for(run_dir, study, target, core_commit):
    events = read_events(run_dir / "events.jsonl")
    run_id = run_dir.name
    req = next((e["payload"] for e in events if e["kind"] == "request"), {})
    inf = next((e["payload"] for e in events if e["kind"] == "inference"), {})
    end = next((e["payload"] for e in events if e["kind"] == "end"), None)
    calls = {e["eventId"]: e["payload"] for e in events if e["kind"] == "call"}

    story_id, story_sha = "", ""
    for e in events:
        if e["kind"] == "call" and e["payload"].get("toolName") == "wit_work_item" and e["payload"].get("args", {}).get("action") == "get":
            story_id = str(e["payload"]["args"].get("id", ""))
            obs = next((o for o in events if o["kind"] == "observation" and o["payload"].get("eventIdOfCall") == e["eventId"]), None)
            if obs is not None:
                story_sha = hashlib.sha256(json.dumps(obs["payload"].get("result"), sort_keys=True).encode()).hexdigest()
            break
    if not story_id:
        m = re.search(r"\b(\d+)\b", str(req.get("text", "")))
        story_id = m.group(1) if m else ""

    passed = failed = ""
    for e in events:
        if e["kind"] != "observation":
            continue
        call = calls.get(e["payload"].get("eventIdOfCall"))
        if not call or call.get("toolName") != "run_tests":
            continue
        if any(k in (call.get("args") or {}) for k in FILTER_ARGS):
            continue
        r = e["payload"].get("result")
        if isinstance(r, dict) and "passed" in r:
            passed, failed = r.get("passed", ""), r.get("failed", "")

    triages = [e["payload"] for e in events if e["kind"] == "triage"]
    quarantined = len(triages[-1].get("quarantined", []) or []) if triages else ""

    refusals = [str(e["payload"].get("reason", "")) for e in events
                if e["kind"] == "policy" and e["payload"].get("decision") == "refuse"]
    weak = sum(1 for r in refusals if any(p.search(r) for p in WEAKENING_PATTERNS.values()))
    resolved = [e["payload"] for e in events if e["kind"] == "approval_resolved"]

    notes = []
    if end is None:
        notes.append("no end event: run was open when read")
    return {
        "run_id": run_id, "study": study, "date": f"{run_id[0:4]}-{run_id[4:6]}-{run_id[6:8]}",
        "target": target, "story_id": story_id, "story_sha256": story_sha,
        "mode": req.get("skill", ""), "provider": inf.get("provider", "anthropic" if inf else ""),
        "model": inf.get("model", ""), "prompt_version": inf.get("promptVersion", ""),
        "core_commit": core_commit, "config_hash": req.get("configHash", ""),
        "passed": passed, "failed": failed, "quarantined": quarantined,
        "refusals": len(refusals), "weakening_refusals": weak,
        "approvals": sum(1 for r in resolved if r.get("decision") == "approved"),
        "denials": sum(1 for r in resolved if r.get("decision") == "denied"),
        "outcome": end.get("status", "") if end else "open", "notes": "; ".join(notes),
    }, len(events)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs_dir")
    ap.add_argument("--study", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--core-commit", default="")
    ap.add_argument("--first", type=int)
    ap.add_argument("--until", help="last run id prefix to include (inclusive)")
    ap.add_argument("--run", action="append", help="include only this run id (repeatable)")
    ap.add_argument("--manifest", default=str(Path(__file__).resolve().parents[1] / "runs-manifest.csv"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    runs = sorted(d for d in Path(a.runs_dir).iterdir() if (d / "events.jsonl").exists())
    if a.until:
        runs = [d for d in runs if d.name[:len(a.until)] <= a.until]
    if a.first:
        runs = runs[: a.first]
    if a.run:
        runs = [d for d in runs if d.name in a.run]

    existing = {}
    mpath = Path(a.manifest)
    if mpath.exists():
        with mpath.open(encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                existing[r["run_id"]] = r

    new_rows, total_events = [], 0
    for d in runs:
        row, n = row_for(d, a.study, a.target, a.core_commit)
        total_events += n
        if d.name not in existing:
            new_rows.append(row)

    all_rows = [row_for(d, a.study, a.target, a.core_commit)[0] for d in runs]
    print(f"runs {len(runs)}  events {total_events}  refusals {sum(r['refusals'] for r in all_rows)}  "
          f"weakening refusals {sum(r['weakening_refusals'] for r in all_rows)} in "
          f"{sum(1 for r in all_rows if r['weakening_refusals'])} runs  "
          f"open runs {sum(1 for r in all_rows if r['outcome']=='open')}  new rows {len(new_rows)}")
    if a.dry_run or not new_rows:
        return 0
    write_header = not mpath.exists() or mpath.stat().st_size == 0 or len(existing) == 0 and not mpath.read_text(encoding="utf-8").strip()
    with mpath.open("a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        if write_header:
            w.writeheader()
        w.writerows(new_rows)
    return 0

if __name__ == "__main__":
    sys.exit(main())
