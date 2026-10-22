import { forReviewer } from "../design/test-design.js";
import type { AnyRunEvent } from "../types.js";
import { caseTally, renderCases, type CaseLine } from "../design/cases.js";

/**
 * The run's stages, said as they start and finish.
 *
 * The live lines say what each call did; a person following a run wants to
 * know where it is: designing, writing tests, building the spec, running it,
 * healing, analysing failures, filing defects, and the totals at the end.
 * This reads the same ledger events the live lines do and announces a stage
 * the first time the run enters it and again when it leaves. It never changes
 * the run; it only names what the ledger already shows.
 */

type Stage = "design" | "authoring" | "build" | "execution" | "healing" | "analysis" | "defects";

const LABEL: Record<Stage, string> = {
  design: "Test design",
  authoring: "Test case authoring",
  build: "Building the test script (bdd2pw)",
  execution: "Execution",
  healing: "Self-healing",
  analysis: "Defect analysis",
  defects: "Creating defects",
};

const BUG_TOOLS = new Set(["jira.create_bug", "ado.wit_work_item_write"]);
const SUITE = "pw.run_tests";

interface CallLite {
  toolName: string;
  args: Record<string, unknown>;
  origin?: string;
}

function toolOf(p: Record<string, unknown>): string {
  return `${String(p["server"] ?? "")}.${String(p["toolName"] ?? "")}`;
}

function isBug(c: { toolName: string; args: Record<string, unknown> }): boolean {
  if (c.toolName === "jira.create_bug") return true;
  return (
    c.toolName === "ado.wit_work_item_write" &&
    c.args["action"] === "create" &&
    c.args["workItemType"] === "Bug"
  );
}

export class StageTracker {
  private started = new Set<Stage>();
  private done = new Set<Stage>();
  private calls = new Map<number, CallLite>();
  private approvals = new Map<string, string[]>();
  private story = "";
  private route = "";
  private lastFull: { passed: number; failed: number; skipped: number } | undefined;
  private lastAny: { passed: number; failed: number; skipped: number } | undefined;
  private bugsFiled = 0;
  private bugsProposed = 0;
  private bugsDropped = 0;
  private analysis = "";
  private forReviewer: string[] = [];
  private forReview: string[] = [];
  private heldForBug: string[] = [];
  /** Filed bugs and the QA record, with the links a person opens. */
  private filed: Array<{ key: string; url: string; attached: number }> = [];
  private qaRecord: { key: string; url: string } | undefined;
  /** Failing tests of the last full run, with Playwright's screenshot of each. */
  private lastFailures: Array<{ title: string; screenshot?: string }> = [];
  private lastUnimplemented: string[] = [];

  /** Lines to print for this event — empty when it changes no stage. */
  line(e: AnyRunEvent): string {
    const p = (e.payload ?? {}) as unknown as Record<string, unknown>;
    const out: string[] = [];
    const start = (s: Stage, note = "") => {
      if (this.started.has(s)) return;
      this.started.add(s);
      out.push(`== ${LABEL[s]}: started${note ? ` — ${note}` : ""}`);
    };
    const finish = (s: Stage, note = "") => {
      if (!this.started.has(s) || this.done.has(s)) return;
      this.done.add(s);
      out.push(`== ${LABEL[s]}: done${note ? ` — ${note}` : ""}`);
    };

    switch (e.kind) {
      case "request": {
        const m = /\b([A-Z][A-Z0-9]+-\d+|AB#\d+|#\d+)\b/.exec(String(p["text"] ?? ""));
        if (m) this.story = m[1] as string;
        break;
      }
      case "route": {
        this.route = String(p["path"] ?? "");
        const because = (p["because"] ?? {}) as Record<string, unknown>;
        const carried = because["carriedDesign"] as Record<string, unknown> | undefined;
        const cases = Array.isArray(because["cases"])
          ? (because["cases"] as CaseLine[])
          : undefined;
        if (cases && !this.started.has("design"))
          out.push(
            cases.length === 0
              ? "== Test cases: none yet for this story"
              : `== Test cases: ${cases.length} existing (${caseTally(cases)})`,
            ...renderCases(cases).filter(() => cases.length > 0),
          );
        if (carried && !this.started.has("design")) {
          this.started.add("design").add("authoring").add("build");
          this.done.add("design").add("authoring").add("build");
          out.push(
            `== ${LABEL.design}: reused — the story is unchanged since run ${String(
              carried["runId"] ?? "?",
            )}; ` + "its approved design stays in force",
            `== ${LABEL.authoring}: skipped — this story's tests already exist`,
          );
          break;
        }
        start("design");
        break;
      }
      case "approval_requested": {
        const calls = Array.isArray(p["calls"]) ? (p["calls"] as CallLite[]) : [];
        const id = String(p["approvalId"] ?? "");
        this.approvals.set(
          id,
          calls.map((c) => c.toolName),
        );
        if (calls.some((c) => c.toolName === "aqa.test_design")) {
          start("design");
          out.push(`== ${LABEL.design}: ready — waiting for your approval`);
        }
        if (calls.some((c) => c.toolName === SUITE)) {
          this.closeWriting(out, finish);
          out.push(`== ${LABEL.execution}: waiting for your approval to run the suite`);
        }
        const bugs = calls.filter((c) => isBug(c)).length;
        if (bugs > 0) {
          this.bugsProposed += bugs;
          start("defects");
          out.push(`== ${LABEL.defects}: ${bugs} proposed — waiting for your approval`);
        }
        break;
      }
      case "approval_resolved": {
        const tools = this.approvals.get(String(p["approvalId"] ?? "")) ?? [];
        const decision = String(p["decision"] ?? "");
        if (tools.includes("aqa.test_design"))
          finish("design", decision === "approved" ? "approved" : `not approved (${decision})`);
        break;
      }
      case "call": {
        const c: CallLite = {
          toolName: toolOf(p),
          args: (p["args"] ?? {}) as Record<string, unknown>,
          ...(typeof p["origin"] === "string" ? { origin: p["origin"] as string } : {}),
        };
        this.calls.set(e.eventId, c);
        if (c.toolName === "fs.write_file" && /\.feature$/.test(String(c.args["path"] ?? ""))) {
          finish("design");
          start("authoring", `writing the scenarios in ${String(c.args["path"])}`);
        }
        if (c.toolName === "bdd2pw.scaffold") {
          finish("design");
          finish("authoring");
          start("build");
        }
        if (c.toolName === SUITE) {
          this.closeWriting(out, finish);
          start("execution");
        }
        break;
      }
      case "observation": {
        const c = this.calls.get(Number(p["eventIdOfCall"]));
        if (!c) break;
        const ok = p["ok"] === true;
        const r = (p["result"] ?? {}) as Record<string, unknown>;
        if (c.toolName === "bdd2pw.scaffold") finish("build", ok ? "spec generated" : "failed");
        if (c.toolName === SUITE && typeof r["passed"] === "number") {
          const res = {
            passed: Number(r["passed"]),
            failed: Number(r["failed"] ?? 0),
            skipped: Number(r["skipped"] ?? 0),
          };
          this.lastAny = res;
          if (c.args["grep"] === undefined) {
            this.lastFull = res;
            this.lastUnimplemented = Array.isArray(r["unimplemented"])
              ? (r["unimplemented"] as Array<{ title?: unknown }>).map((u) => String(u.title ?? ""))
              : [];
            this.lastFailures = (
              Array.isArray(r["failures"]) ? (r["failures"] as unknown[]) : []
            ).map((f) => {
              const x = (f ?? {}) as Record<string, unknown>;
              return {
                title: String(x["title"] ?? ""),
                ...(typeof x["screenshot"] === "string" ? { screenshot: x["screenshot"] } : {}),
              };
            });
          }
        }
        if (ok && isBug(c)) {
          this.bugsFiled++;
          const key = String(r["key"] ?? r["id"] ?? "");
          const links = (r["_links"] ?? {}) as { html?: { href?: string } };
          const url = String(r["url"] ?? links.html?.href ?? "");
          if (key || url)
            this.filed.push({
              key,
              url,
              attached: Array.isArray(r["attached"]) ? r["attached"].length : 0,
            });
        }
        if (ok && c.toolName === "jira.record_qa" && typeof r["url"] === "string" && r["qaKey"])
          this.qaRecord = { key: String(r["qaKey"]), url: r["url"] };
        break;
      }
      case "agent": {
        const role = String(p["role"] ?? "");
        if (role === "heal") {
          // A second heal after the first finished is the same stage again.
          this.done.delete("healing");
          this.started.delete("healing");
          start("healing", String(p["because"] ?? "").slice(0, 140));
        } else if (this.started.has("healing")) finish("healing");
        break;
      }
      case "triage": {
        const verdicts = Array.isArray(p["verdicts"])
          ? (p["verdicts"] as Array<{ category?: string }>)
          : [];
        if (verdicts.length === 0) break;
        const n = (cat: string) => verdicts.filter((v) => v.category === cat).length;
        const other = verdicts.length - n("real-defect") - n("flake");
        this.analysis =
          `${verdicts.length} failure(s): ` +
          [
            n("real-defect") ? `${n("real-defect")} possible product defect(s)` : "",
            n("flake") ? `${n("flake")} flaky` : "",
            other > 0 ? `${other} test or environment problem(s)` : "",
          ]
            .filter(Boolean)
            .join(", ");
        if (!this.started.has("analysis")) start("analysis", this.analysis);
        else out.push(`   ${LABEL.analysis}: ${this.analysis}`);
        break;
      }
      case "verify": {
        // What the run hands to a person: failures that used up their repairs,
        // and quarantined defect candidates (triage/quarantine.ts).
        const lim = Array.isArray(p["limitations"]) ? (p["limitations"] as string[]) : [];
        // A failing test with a bug held for the reviewer is listed with the
        // bugs, not as an open decision: once the bug is filed there is
        // nothing left to decide (20261021T232323Z said "needs your decision"
        // under bug #127, filed a line above).
        const heldForBug = /^"(.*)" fails, and a bug about it is put to the reviewer/;
        this.heldForBug = lim.map((l) => heldForBug.exec(l)?.[1]).filter((t): t is string => !!t);
        this.forReviewer = lim
          .filter((l) => !heldForBug.test(l))
          .filter((l) => /put to the reviewer|Triaged as a product defect/.test(l))
          .map((l) => l.split(" — ")[0]?.replace(/^"|"$/g, "") ?? l);
        // Tests weaker or broader than the design, after one fix attempt.
        this.forReview = lim
          .filter((l) => l.startsWith("for your review — "))
          .map((l) => forReviewer(l.slice("for your review — ".length)));
        break;
      }
      case "policy": {
        if (
          p["decision"] === "refuse" &&
          BUG_TOOLS.has(String(p["toolName"] ?? "")) &&
          String(p["reason"] ?? "").startsWith("dropped at end of run")
        )
          this.bugsDropped++;
        break;
      }
      case "end": {
        this.closeWriting(out, finish);
        if (this.started.has("execution")) finish("execution");
        if (this.started.has("healing")) finish("healing");
        if (this.started.has("analysis")) finish("analysis", `last result — ${this.analysis}`);
        if (!this.started.has("defects"))
          out.push(`== ${LABEL.defects}: none — no failure was put forward as a defect`);
        else finish("defects");
        const res = this.lastFull ?? this.lastAny;
        out.push("== Report");
        if (res) {
          out.push(`     Total scripts : ${res.passed + res.failed + res.skipped}`);
          out.push(`     Passed        : ${res.passed}`);
          out.push(`     Failed        : ${res.failed}`);
          for (const f of this.lastFailures)
            out.push(
              `       - ${f.title}${f.screenshot ? `\n         screenshot: ${f.screenshot}` : ""}`,
            );
          if (res.skipped) out.push(`     Skipped       : ${res.skipped}`);
          if (this.lastUnimplemented.length > 0) {
            out.push(
              `     Not implemented: ${this.lastUnimplemented.length} (steps left as TODO — they ran but checked nothing)`,
            );
            for (const t of this.lastUnimplemented) out.push(`       - ${t}`);
          }
        } else out.push("     The suite did not run.");
        out.push(
          `     Defects found : ${this.bugsFiled} filed` +
            (this.bugsProposed > this.bugsFiled
              ? `, ${this.bugsProposed - this.bugsFiled} proposed but not filed`
              : "") +
            (this.bugsDropped ? `, ${this.bugsDropped} dropped by the final result` : ""),
        );
        for (const f of this.filed)
          out.push(
            `       ${f.key}${f.url ? `  ${f.url}` : ""}` +
              (f.attached > 0
                ? `  (${f.attached} file${f.attached > 1 ? "s" : ""} attached: screenshot/trace)`
                : ""),
          );
        if (this.qaRecord)
          out.push(`     Test cases    : ${this.qaRecord.key}  ${this.qaRecord.url}`);
        if (this.forReview.length > 0) {
          out.push(
            `     Needs your review (${this.forReview.length}) — tests that work but check less than the design:`,
          );
          for (const t of this.forReview) out.push(`       - ${t}`);
        }
        // Held bugs that were not filed leave their tests red with nothing
        // reported: that IS a decision still open.
        const unfiled = this.bugsFiled === 0 ? this.heldForBug : [];
        for (const t of unfiled)
          this.forReviewer.push(`${t} — still failing; its bug was not filed`);
        if (this.forReviewer.length > 0) {
          out.push(`     Needs your decision (${this.forReviewer.length}):`);
          for (const t of this.forReviewer) out.push(`       - ${t}`);
        }
        const status = String(p["status"] ?? "");
        const who = this.story ? `Story ${this.story}` : "Story";
        out.push(
          status === "done"
            ? `== ${who}: completed`
            : `== ${who}: stopped (${status}) — ${String(p["summary"] ?? "").slice(0, 200)}`,
        );
        break;
      }
      default:
        break;
    }
    return out.length > 0 ? `${out.join("\n")}\n` : "";
  }

  /** Design and writing are over once the suite runs or is about to. */
  private closeWriting(out: string[], finish: (s: Stage, note?: string) => void): void {
    finish("design");
    if (this.route === "B" && !this.started.has("authoring")) {
      this.started.add("authoring").add("build");
      this.done.add("authoring").add("build");
      out.push(
        `== ${LABEL.authoring}: skipped — this story's tests already exist; running them as they are`,
      );
    }
    finish("authoring");
    finish("build");
  }
}
