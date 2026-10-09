import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import type { AnyRunEvent } from "../../types.js";
import {
  asArray,
  artefacts,
  asRecord,
  completedCalls,
  numberField,
  successful,
  testedByIds,
} from "../../verify/evidence.js";
import { createdCaseIds } from "../../verify/story-to-tests.js";
import { lastFullRun, ownTestTitles } from "../../triage/settle.js";

export interface SummaryOptions {
  /** The story the run is scoped to, when there is one. */
  workItem?: string;
  /**
   * Things this environment could not do, stated up front — e.g. no Test Plans
   * access level. These are facts about the account rather than results, so
   * they are supplied rather than read out of the ledger.
   */
  limitations?: string[];
}

/** Just enough of the Ledger to read a run back; keeps this adapter testable. */
export interface LedgerView {
  readonly runId: string;
  read(): AnyRunEvent[];
}

/**
 * In-process `aqa` adapter: the run's own report, composed from the LEDGER.
 *
 * Everywhere else in this runtime the model proposes and code decides. The one
 * place that was not true was the comment posted back to the story: the model
 * wrote prose about its own work — "5 passed", "no duplicates were introduced"
 * — and nothing checked it. It happened to be accurate. It was still a claim
 * standing where evidence belongs, and it could disagree with `aqa replay`
 * without anyone noticing.
 *
 * So the numbers are counted here, from what was observed to happen, and the
 * agent's job is reduced to posting the text verbatim. It may add its own
 * commentary around it; it cannot restate the figures, because it no longer
 * has to.
 */
export class SummaryTools implements ToolClient {
  readonly server = "aqa";

  constructor(
    private readonly ledger: LedgerView,
    private readonly opts: SummaryOptions = {},
  ) {}

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "run_summary",
        description:
          "Compose this run's report from the ledger: the suite result, the test cases created " +
          "or already linked, the spec files written, and any checks the environment prevented. " +
          "Returns { text } — post that text verbatim; do not restate the figures yourself, " +
          "because these are counted from what actually happened rather than from memory. " +
          "Reads the ledger only; writes nothing.",
        inputSchema: { type: "object", properties: {}, required: [] },
        policyClass: "read",
      },
    ];
  }

  async call(server: string, name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || name !== "run_summary")
      return { ok: false, result: { message: `unknown aqa tool: ${name}` }, artefacts: [] };

    const report = composeRunReport(this.ledger.read(), this.ledger.runId, {
      ...(this.opts.workItem !== undefined ? { workItem: this.opts.workItem } : {}),
      limitations: this.opts.limitations ?? [],
    });
    return { ok: true, result: report, artefacts: [] };
  }
}

/**
 * The run report, composed from the LEDGER — never from the model's account of
 * its own work.
 *
 * Exported so the runtime can post it itself at the end of the run, after the
 * bug decision. The agent used to post it as a "last step" that was not the
 * last step: the verifier could send it back for another attempt, and the story
 * then carried a report of a run that had not finished (20260921T192908Z).
 */
export function composeRunReport(
  events: AnyRunEvent[],
  runId: string,
  opts: { workItem?: string; limitations?: string[]; agentNote?: string } = {},
): {
  text: string;
  runId: string;
  suite: Record<string, unknown> | null;
  createdCaseIds: number[];
  preexistingCaseIds: number[];
  bugsFiled: Array<{ id?: number; title: string }>;
  bugsDropped: string[];
  bugsDenied: string[];
  knownBugsNotReproduced: KnownBugPass[];
} {
  const calls = completedCalls(events);

  // The last UNFILTERED run: a `grep`-ed one is a working step and says
  // nothing about the tests it skipped.
  const runs = successful(calls, "pw.run_tests");
  const suite = asRecord(lastFullRun(events)?.result);
  const knownBugsNotReproduced = unexpectedPassesAcrossRuns(runs.map((r) => r.result));

  const created = [...createdCaseIds(events)].sort((a, b) => a - b);
  const story = opts.workItem;
  // The epic's spec runs every story's tests. A failure that belongs to
  // another story is said as exactly that, and never counted as this run's.
  const mine = ownTestTitles(events, story);
  const otherStoryFailures = mine
    ? asArray(suite?.["failures"])
        .map((f) => String(asRecord(f)?.["title"] ?? ""))
        .filter((t) => t && !mine.has(t))
    : [];
  const reads = story
    ? successful(calls, "ado.wit_work_item", "get").filter(
        (c) => String(c.args["id"] ?? "") === story,
      )
    : [];
  const preexisting = [...new Set(reads.flatMap((r) => testedByIds(r.result)))]
    .filter((id) => !created.includes(id))
    .sort((a, b) => a - b);

  const specs = artefacts(calls).filter((p) => /\.(spec|test)\.[cm]?[jt]sx?$/i.test(p));

  // The bug decision, as it actually went.
  const bugsFiled = successful(calls, "ado.wit_work_item_write", "create").map((c) => {
    const id = numberField(c.result, "id");
    return { ...(id !== undefined ? { id } : {}), title: bugTitleOf(c.args) };
  });
  const bugsDropped: string[] = [];
  const bugsDenied: string[] = [];
  // Defects this run reproduced that Azure DevOps already has a record of.
  //
  // `duplicateBug` refuses the second filing and tells the agent to say so in
  // its report instead — but the report is composed here, from the ledger, not
  // written by the agent, so that sentence had nowhere to go. The reader of
  // 20260928T095319Z saw two failing tests and no bug reference at all, which
  // understates what is known: both are recorded, confirmed and unfixed. The
  // refusal names the bug; this reads it back out.
  const bugsAlreadyFiled: string[] = [];
  // Proposals per approval, not approvals. One prompt can carry several bugs and
  // is answered once, so counting the answers under-reports what was refused:
  // 20260928T082428Z denied two bugs in one prompt and the report said "1
  // proposal(s) denied". A number a reader can check against the prompt they
  // answered is the whole point of counting from the ledger.
  const bugsPerApproval = new Map<string, number>();
  for (const e of events) {
    const p = e.payload as unknown as Record<string, unknown>;
    if (e.kind === "policy") {
      const reason = String(p["reason"] ?? "");
      if (reason.startsWith("dropped at end of run — ")) bugsDropped.push(reason.slice(24));
      const already = ALREADY_FILED.exec(reason);
      if (already?.[1] && already[2])
        bugsAlreadyFiled.push(`#${already[1]} [${already[2]}] ${already[3] ?? ""}`.trim());
      if (
        p["toolName"] === "ado.wit_work_item_write" &&
        p["decision"] === "ask" &&
        p["approvalId"]
      ) {
        const id = String(p["approvalId"]);
        bugsPerApproval.set(id, (bugsPerApproval.get(id) ?? 0) + 1);
      }
    }
    if (e.kind === "approval_resolved" && p["decision"] === "denied") {
      const id = String(p["approvalId"]);
      const n = bugsPerApproval.get(id) ?? 0;
      const reason = String(p["reason"] ?? "").trim();
      for (let i = 0; i < n; i++) bugsDenied.push(reason);
    }
  }

  // Did triage write the run off? Read from the latest triage event, which is
  // the same place the verifier reads it, so the two cannot disagree.
  const latestTriage = [...events].reverse().find((e) => e.kind === "triage");
  const tp = latestTriage
    ? (latestTriage.payload as unknown as Record<string, unknown>)
    : undefined;
  const level = typeof tp?.["runLevel"] === "string" ? String(tp["runLevel"]) : undefined;
  const runLevel = level
    ? {
        level,
        evidence: firstEvidence(asArray(tp?.["verdicts"]), level),
      }
    : undefined;

  const text = render({
    runId,
    ...(story !== undefined ? { workItem: story } : {}),
    ...(suite ? { suite } : {}),
    ...(runLevel ? { runLevel } : {}),
    created,
    preexisting,
    specs,
    limitations: opts.limitations ?? [],
    bugsFiled,
    bugsDropped,
    bugsDenied,
    bugsAlreadyFiled,
    knownBugsNotReproduced,
    otherStoryFailures,
    ...(opts.agentNote ? { agentNote: opts.agentNote } : {}),
  });
  return {
    text,
    runId,
    suite: suite ?? null,
    createdCaseIds: created,
    preexistingCaseIds: preexisting,
    bugsFiled,
    bugsDropped,
    bugsDenied,
    knownBugsNotReproduced,
  };
}

/**
 * `duplicateBug`'s refusal, read back out of the ledger.
 *
 * The rule writes `#83 [Active] already says this: "<title>"`, and this is the
 * only place that parses it. A refusal message is generated from code and is
 * stable per rule, which is what makes it safe to read as data — but the
 * coupling is real, so the shape is asserted in test/report.test.ts against the
 * rule's own output rather than against a copy of this string.
 */
const ALREADY_FILED = /^#(\d+) \[([^\]]+)\] already says this: "([^"]*)"/;

/** The first line of error text a contagious verdict matched on — the reason, in the suite's own words. */
function firstEvidence(verdicts: unknown[], level: string): string {
  for (const raw of verdicts) {
    const v = asRecord(raw);
    if (!v || v["category"] !== level) continue;
    const ev = v["evidence"];
    const text = typeof ev === "string" ? ev : JSON.stringify(ev ?? "");
    const line = text.split("\n").find((l) => l.trim()) ?? "";
    return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
  return "no matched text recorded";
}

/** A test marked expected-to-fail for a known bug that passed in some run. */
export interface KnownBugPass {
  title: string;
  note: string;
  /** True when a later run no longer had it marked — the marker was removed. */
  markerRemoved: boolean;
}

/**
 * Every known-bug test that passed in ANY suite run this run — not only the
 * last one.
 *
 * Reading only the final run let the finding disappear: in 20260921T203913Z
 * the AC-2b test for Active bug #48 passed on the first run, the agent then
 * removed its expected-to-fail marker, and the final run reported an ordinary
 * pass. The one thing a reader of the story most needed to know — the known
 * bug did not reproduce — was in the ledger and not in the report.
 */
export function unexpectedPassesAcrossRuns(results: unknown[]): KnownBugPass[] {
  const seen = new Map<string, KnownBugPass>();
  for (const res of results) {
    for (const u of asArray(asRecord(res)?.["unexpectedPasses"])) {
      const rec = asRecord(u) ?? {};
      const title = String(rec["title"] ?? "(untitled)");
      if (!seen.has(title))
        seen.set(title, { title, note: String(rec["note"] ?? "").trim(), markerRemoved: false });
    }
  }
  const last = asRecord(results[results.length - 1]);
  const lastTests = asArray(last?.["tests"]).map((t) => asRecord(t) ?? {});
  for (const k of seen.values()) {
    const now = lastTests.find((t) => String(t["title"] ?? "") === k.title);
    if (now && now["status"] !== "unexpected-pass") k.markerRemoved = true;
  }
  return [...seen.values()];
}

function bugTitleOf(args: Record<string, unknown>): string {
  const f = args["fields"];
  if (Array.isArray(f)) {
    for (const e of f) {
      const r = asRecord(e);
      if (r?.["name"] === "System.Title") return String(r["value"] ?? "");
    }
  }
  const v = asRecord(f)?.["System.Title"];
  return typeof v === "string" ? v : String(args["title"] ?? "(untitled)");
}

interface Rendered {
  runId: string;
  workItem?: string;
  suite?: Record<string, unknown>;
  created: number[];
  preexisting: number[];
  specs: string[];
  limitations: string[];
  bugsFiled?: Array<{ id?: number; title: string }>;
  bugsDropped?: string[];
  bugsDenied?: string[];
  bugsAlreadyFiled?: string[];
  knownBugsNotReproduced?: KnownBugPass[];
  otherStoryFailures?: string[];
  agentNote?: string;
  /** Set when triage wrote the run off: nothing in it measured the product. */
  runLevel?: { level: string; evidence: string };
}

/** Markdown, because the destination is an Azure DevOps work item comment. */
function render(r: Rendered): string {
  const lines: string[] = [];
  lines.push(`## agentic-qa run \`${r.runId}\``);
  lines.push("");

  if (r.suite) {
    const n = (k: string) => Number(r.suite?.[k] ?? 0);
    const writtenOff = r.runLevel !== undefined;
    if (r.runLevel) {
      // Triage wrote the run off. The one thing this report must not do is
      // read as a verdict on the product: 20261007T191743Z had eight of a
      // story's tests red on the same "Login endpoint returned 401 … a fixture
      // problem" and the report began "**Suite: NOT green** … 5 failed". Those
      // were not findings. The table stays, because it is what happened; the
      // sentence before it says what it means.
      lines.push(
        `**Nothing in this run measured the product.** Triage classified it \`${r.runLevel.level}\`: ` +
          "the environment failed before the tests reached the application — " +
          `\`${escapePipes(r.runLevel.evidence)}\`. The ${n("passed")} pass(es) and ${n("failed")} ` +
          "failure(s) below record the attempt, not a result about the product. Fix the " +
          "environment and run again; no verdict, bug or closed bug should be read from this.",
      );
    }
    // The headline reads on THIS STORY's tests.
    //
    // The epic's spec runs every story's tests, and counting all of them made a
    // story whose own tests all passed read "NOT green" because a neighbouring
    // story had a defect — the body of the report then said the opposite, two
    // paragraphs down (20260925T184615Z). What another story's tests did is
    // context, and is reported as context.
    const others = writtenOff ? [] : (r.otherStoryFailures ?? []);
    if (!writtenOff) {
      const failedHere = Math.max(0, n("failed") - others.length);
      const verdict = failedHere === 0 && n("skipped") === 0 ? "green" : "NOT green";
      const scope = r.workItem ? ` for story ${r.workItem}` : "";
      lines.push(
        `**Suite: ${verdict}**${scope} — ${n("passed")} passed, ${failedHere} failed, ` +
          `${n("skipped")} skipped` +
          (others.length > 0
            ? `; ${others.length} further failure(s) in this epic's spec belong to another story and ` +
              "are not counted here."
            : "."),
      );
    }
    // Every test, with its outcome — not only the failures.
    //
    // A green run used to reach the story as the count above and nothing else,
    // so a reader could see that five things passed but not WHICH acceptance
    // criteria were verified. That is the one thing a green run has to say.
    // Failures still get their message below; this table is what makes a pass
    // legible.
    const tests = r.suite["tests"];
    if (Array.isArray(tests) && tests.length > 0) {
      lines.push("");
      lines.push("| Test | Result | Time |");
      lines.push("| --- | --- | --- |");
      for (const t of tests) {
        const rec = asRecord(t) ?? {};
        const status = String(rec["status"] ?? "?");
        lines.push(
          `| ${escapePipes(String(rec["title"] ?? "(untitled)"))} | ${MARK[status] ?? status} | ` +
            `${seconds(rec["durationMs"])} |`,
        );
      }
      // A test that was expected to fail and passed is reported by Playwright
      // outside passed/failed, so the row count and the totals differ. Said,
      // rather than left for the reader to spot.
      const unexpectedRows = tests.filter(
        (t) => asRecord(t)?.["status"] === "unexpected-pass",
      ).length;
      if (unexpectedRows > 0)
        lines.push(
          "",
          `_${tests.length} tests listed; ${unexpectedRows} marked expected-to-fail ${
            unexpectedRows === 1 ? "is" : "are"
          } not counted in the totals above._`,
        );
      const omitted = Number(r.suite["testsOmitted"] ?? 0);
      if (omitted > 0) lines.push("", `…and ${omitted} more not listed.`);
    }

    // A known bug that did not reproduce — in ANY run of the suite this run.
    // Said as a finding, because that is what it is: the thing a person
    // reading this story most needs to act on, and the thing a failure count
    // would have hidden.
    // A pass in a run that measured nothing is not "did not reproduce".
    const known = writtenOff ? [] : (r.knownBugsNotReproduced ?? []);
    if (known.length > 0) {
      lines.push("");
      lines.push("**Known bugs that did NOT reproduce:**");
      for (const k of known) {
        lines.push(
          `- **${k.title}** was marked expected-to-fail` +
            (k.note ? ` (${k.note})` : "") +
            " and PASSED. The bug may be fixed — verify it and close it if so." +
            (k.markerRemoved
              ? " The agent then removed the expected-to-fail marker; the test now passes as an ordinary test."
              : ""),
        );
      }
    }

    const other = others;
    if (other.length > 0) {
      lines.push("");
      lines.push(
        `**Also failing in this epic's spec, belonging to another story:** ${other
          .map((t) => `_${t}_`)
          .join("; ")}. Not this run's tests, and not counted as this story's result.`,
      );
    }

    const failures = r.suite["failures"];
    if (Array.isArray(failures) && failures.length > 0) {
      lines.push("");
      lines.push("Failing tests:");
      for (const f of failures.slice(0, 20)) {
        const rec = asRecord(f) ?? {};
        const message = String(rec["message"] ?? "").trim();
        lines.push(
          `- **${String(rec["title"] ?? "(untitled)")}** — ${String(rec["file"] ?? "")}` +
            // The failure's own words. Without them the reader has the name of
            // something that went wrong and no idea what.
            (message ? `\n  ${failureLines(message)}` : ""),
        );
      }
    }
  } else {
    lines.push("**Suite: not run.**");
  }

  lines.push("");
  const target = r.workItem ? ` to work item ${r.workItem}` : "";
  if (r.created.length === 0 && r.preexisting.length === 0) {
    lines.push(`No test cases are linked${target}.`);
  } else {
    const parts: string[] = [];
    if (r.created.length > 0) parts.push(`created this run: ${r.created.join(", ")}`);
    if (r.preexisting.length > 0) parts.push(`already present: ${r.preexisting.join(", ")}`);
    lines.push(
      `**Test cases linked${target}: ${r.created.length + r.preexisting.length}** (${parts.join("; ")}).`,
    );
  }

  if (r.specs.length > 0) {
    lines.push("");
    lines.push(`Spec files written: ${r.specs.map((s) => `\`${s}\``).join(", ")}`);
  }

  // The bug decision, as it actually went — filed, denied, or dropped without
  // anyone being asked because the final result did not support it.
  const filed = r.bugsFiled ?? [];
  const dropped = r.bugsDropped ?? [];
  const denied = r.bugsDenied ?? [];
  const already = [...new Set(r.bugsAlreadyFiled ?? [])];
  if (filed.length + dropped.length + denied.length + already.length > 0) {
    lines.push("");
    lines.push("**Bugs:**");
    for (const b of filed)
      lines.push(`- filed${b.id !== undefined ? ` #${b.id}` : ""}: ${b.title}`);
    // A defect that reproduced and is already on record. This is the strongest
    // sentence the report can say about a failing test — not "something is
    // wrong" but "this exact defect was filed, is still open, and the suite
    // just reproduced it" — and it says it without filing anything twice.
    for (const a of already)
      lines.push(`- already recorded, reproduced again in this run: ${a} — confirmed and unfixed`);
    if (denied.length > 0) {
      // The reviewer's reason, when they gave one worth reading. A one-word
      // answer is recorded in the ledger and not repeated here as if it were an
      // explanation.
      const said = [...new Set(denied.filter((r) => r.length > 3))];
      lines.push(
        `- ${denied.length} bug proposal(s) denied by the reviewer` +
          (said.length > 0 ? ` — ${said.map((r) => `"${r}"`).join("; ")}` : ""),
      );
    }
    for (const d of dropped) lines.push(`- not proposed: ${d}`);
  }

  if (r.limitations.length > 0) {
    lines.push("");
    lines.push("**Checks not made in this environment:**");
    for (const l of r.limitations) lines.push(`- ${l}`);
  }

  if (r.agentNote) {
    lines.push(
      "",
      "---",
      "",
      "**Agent's note** _(its own words — the figures above are counted, this is not):_",
      "",
    );
    lines.push(r.agentNote.trim());
  }

  lines.push("");
  lines.push(
    `_Counted from the run ledger (\`${r.runId}\`), not from the agent's account of its own work._`,
  );
  return lines.join("\n");
}

/** Status marks for the per-test table. Words, not colours: this is Markdown. */
const MARK: Record<string, string> = {
  passed: "pass",
  failed: "**FAIL**",
  skipped: "skipped",
  flaky: "flaky",
  "unexpected-pass": "pass — **expected to fail**",
};

function seconds(ms: unknown): string {
  const n = typeof ms === "number" ? ms : 0;
  if (n <= 0) return "—";
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

/** A pipe inside a cell would split the row; Azure DevOps renders Markdown. */
function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * The lines of a failure that say what went wrong: the first line, and the
 * Expected / Received pair when Playwright gives one. Colour codes removed.
 */
export function failureLines(message: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = message.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/^…/, "");
  const all = plain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head = all[0] ?? "";
  const expectations = all.filter((l) => /^(Expected|Received)\b/.test(l));
  if (expectations.length > 0) {
    return [...new Set([head, ...expectations])].map((l) => `\`${firstLine(l)}\``).join(" · ");
  }
  // No Expected/Received pair — a thrown value, often JSON (axe reports its
  // violations that way). "Error: [" alone says nothing, so take the opening
  // of the message as one line, and pull out the rule ids when they are there.
  const ids = [...new Set([...plain.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))].slice(
    0,
    8,
  );
  const opening = firstLine(all.slice(0, 6).join(" ").replace(/\s+/g, " "));
  return (
    `\`${opening}\`` + (ids.length > 0 ? ` — rules: ${ids.map((i) => `\`${i}\``).join(", ")}` : "")
  );
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return escapePipes(line.length > 200 ? line.slice(0, 197) + "…" : line);
}
