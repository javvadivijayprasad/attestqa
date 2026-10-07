import type { AnyRunEvent } from "../types.js";

/**
 * Render a ledger as a human-readable Markdown report with zero network and
 * zero tool calls. Also the source of the one-line messages the platform shows
 * on its run page (handoff §5) — keep `renderLine` stable.
 */
export function renderLine(e: AnyRunEvent): string {
  switch (e.kind) {
    case "request":
      return `Agent started: "${e.payload.text}" (skill ${e.payload.skill})`;
    case "plan": {
      const first = e.payload.steps.slice(0, 3).join(" · ");
      return `Plan: ${e.payload.steps.length} steps — ${first}`;
    }
    case "context":
      return `Context assembled: ${e.payload.sections.length} sections, ${e.payload.totalTokens} tokens`;
    case "inference":
      return e.payload.toolName === null
        ? `Agent declared goal reached`
        : `Agent chose ${e.payload.toolName}`;
    case "policy":
      return `Gate: ${e.payload.class} → ${e.payload.decision} (${e.payload.reason})`;
    case "approval_requested":
      return `Approval needed: ${e.payload.summary}`;
    case "approval_resolved":
      return `Approval ${e.payload.decision} by ${e.payload.by}`;
    case "call":
      return `Calling ${e.payload.server}.${e.payload.toolName}`;
    case "observation": {
      const target = `call #${e.payload.eventIdOfCall}`;
      if (e.payload.ok) return `${target} → ok (${e.payload.durationMs} ms)`;
      const first = firstLine(e.payload.result);
      return `${target} → failed: ${first}`;
    }
    case "triage": {
      // The run-level verdict leads, because "nothing here was measured" is a
      // different kind of news from "two tests found bugs" and a reader
      // scanning the line should not have to work that out from a count.
      if (e.payload.runLevel !== null) {
        return `Triage: ${e.payload.runLevel} — nothing in this run was measured`;
      }
      const n = e.payload.verdicts.length;
      const q = e.payload.quarantined.length;
      const kinds = [...new Set(e.payload.verdicts.map((v) => v.category))].join(", ");
      return `Triage: ${n} failure(s) — ${kinds}${q > 0 ? `; ${q} quarantined` : ""}`;
    }
    case "verify":
      return e.payload.done
        ? `Verifier: done${
            e.payload.limitations?.length
              ? ` (${e.payload.limitations.length} check(s) not made)`
              : ""
          }`
        : `Verifier: ${e.payload.gaps.length} gaps — ${e.payload.gaps[0]?.message ?? ""}`;
    case "route":
      return `Route ${e.payload.path}: ${e.payload.reason}`;
    case "agent":
      return e.payload.role === "default"
        ? "Agent: back to the skill's own tools"
        : `Agent: ${e.payload.role} — ${e.payload.because}`;
    case "end":
      return `Agent finished: ${e.payload.status} — ${e.payload.summary}`;
  }
}

function firstLine(result: unknown): string {
  const text =
    typeof result === "string"
      ? result
      : result && typeof result === "object" && "message" in result
        ? String((result as { message: unknown }).message)
        : JSON.stringify(result);
  return (text ?? "").split(/\r?\n/)[0] ?? "";
}

export interface ReplayStats {
  events: number;
  inferences: number;
  calls: number;
  failedCalls: number;
  approvals: number;
  refusals: number;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache totals. Both stay 0 when the provider reports no caching. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  wallMs: number;
  status: string;
}

export function computeStats(events: AnyRunEvent[]): ReplayStats {
  const first = events[0];
  const last = events[events.length - 1];
  const s: ReplayStats = {
    events: events.length,
    inferences: 0,
    calls: 0,
    failedCalls: 0,
    approvals: 0,
    refusals: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    wallMs: first && last ? last.timestamp - first.timestamp : 0,
    status: "incomplete",
  };
  for (const e of events) {
    switch (e.kind) {
      case "inference":
        s.inferences++;
        s.inputTokens += e.payload.usage.inputTokens;
        s.outputTokens += e.payload.usage.outputTokens;
        s.cacheReadTokens += e.payload.usage.cacheReadTokens ?? 0;
        s.cacheCreationTokens += e.payload.usage.cacheCreationTokens ?? 0;
        break;
      case "call":
        s.calls++;
        break;
      case "observation":
        if (!e.payload.ok) s.failedCalls++;
        break;
      case "approval_requested":
        s.approvals++;
        break;
      case "policy":
        if (e.payload.decision === "refuse") s.refusals++;
        break;
      case "end":
        s.status = e.payload.status;
        break;
      default:
        break;
    }
  }
  return s;
}

export function renderMarkdown(events: AnyRunEvent[]): string {
  if (events.length === 0) return "# agentic-qa replay\n\n_Empty ledger._\n";
  const runId = events[0]!.runId;
  const stats = computeStats(events);
  const request = events.find((e) => e.kind === "request");
  const lines: string[] = [];
  lines.push(`# agentic-qa replay — run ${runId}`);
  lines.push("");
  if (request && request.kind === "request") {
    lines.push(`**Request:** ${request.payload.text}  `);
    lines.push(`**Skill:** ${request.payload.skill}  `);
  }
  lines.push(`**Status:** ${stats.status}  `);
  lines.push(
    `**Events:** ${stats.events} · **Inferences:** ${stats.inferences} · **Tool calls:** ${stats.calls} (${stats.failedCalls} failed) · **Approvals:** ${stats.approvals} · **Refusals:** ${stats.refusals}  `,
  );
  lines.push(
    `**Tokens:** ${stats.inputTokens} in / ${stats.outputTokens} out${renderCache(stats)} · **Wall:** ${formatMs(stats.wallMs)}`,
  );
  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  lines.push("| # | t+ms | kind | event |");
  lines.push("|---|---|---|---|");
  const t0 = events[0]!.timestamp;
  for (const e of events) {
    lines.push(`| ${e.eventId} | ${e.timestamp - t0} | ${e.kind} | ${escapeCell(renderLine(e))} |`);
  }
  const verify = [...events].reverse().find((e) => e.kind === "verify");
  if (verify && verify.kind === "verify" && verify.payload.gaps.length > 0) {
    lines.push("");
    lines.push("## Verifier gaps");
    lines.push("");
    for (const g of verify.payload.gaps) lines.push(`- \`${g.code}\` — ${g.message}`);
  }
  // The defect candidates, from the LAST triage — a flake retry produces a
  // second one, and the first is history rather than the run's conclusion.
  // This section is the part of the report a tester reads first, so it goes
  // above "checks not made" and below the gaps that explain why the run stopped.
  const triage = [...events].reverse().find((e) => e.kind === "triage");
  if (triage && triage.kind === "triage") {
    if (triage.payload.runLevel !== null) {
      lines.push("");
      lines.push("## Nothing was measured");
      lines.push("");
      lines.push(
        `The run was triaged \`${triage.payload.runLevel}\`: the system under test or the ` +
          "harness failed, so no result in this run says anything about the product — " +
          "including the results that passed. There are no defect candidates.",
      );
    } else if (triage.payload.quarantined.length > 0) {
      lines.push("");
      lines.push("## Defect candidates");
      lines.push("");
      lines.push("_Quarantined: these tests were not edited, and must not be._");
      lines.push("");
      for (const v of triage.payload.verdicts.filter((x) => x.category === "real-defect")) {
        lines.push(`- **${v.test}** — ${v.evidence} _(${v.triagedBy}, ${v.confidence})_`);
      }
    }
  }

  // A run can be done without being complete. What was NOT checked belongs in
  // the report next to what was, or the reader has to infer it from silence.
  if (verify && verify.kind === "verify" && (verify.payload.limitations?.length ?? 0) > 0) {
    lines.push("");
    lines.push("## Checks not made");
    lines.push("");
    for (const l of verify.payload.limitations ?? []) lines.push(`- ${l}`);
  }
  lines.push("");
  lines.push("_Rendered by `aqa replay` from the ledger only — no tool or model calls were made._");
  lines.push("");
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/**
 * The cache clause of the stats line, omitted entirely when nothing was cached.
 *
 * Reported as counts rather than as money saved: the price per token is not
 * this project's to assert, and a run report that quotes a figure it cannot
 * derive from its own ledger is the kind of claim the verifier exists to stop.
 */
function renderCache(stats: ReplayStats): string {
  const { cacheReadTokens: read, cacheCreationTokens: written } = stats;
  if (read === 0 && written === 0) return "";
  const total = read + stats.inputTokens;
  const share = total > 0 ? Math.round((read / total) * 100) : 0;
  return ` · **Cache:** ${read} read (${share}% of input), ${written} written`;
}
