import type { ApprovalDecision } from "../types.js";
import type { ProposedCall } from "./model.js";

export interface ApprovalRequest {
  approvalId: string;
  summary: string;
  calls: ProposedCall[];
  /** Context shown ABOVE the calls — e.g. the final run's still-failing tests. */
  note?: string;
  /**
   * For a test design: which of its items already have tests. Supplied by the
   * skill, shown beside each item so the reviewer can see what is new.
   */
  covered?: Map<string, { scenario: string; how: string }>;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  by: string;
  at: string;
  /**
   * Why the reviewer said no, in their words. A denial without one tells the
   * agent that something was wrong and nothing about what, so it guesses —
   * and a design it cannot correct costs the whole run (20260922T231736Z).
   */
  reason?: string;
}

/** Asks a human. `terminal` and `file` implementations arrive in A3. */
export interface Approver {
  ask(request: ApprovalRequest): Promise<ApprovalResult>;
}

/** Answers from a fixed list (or a single default). Records what it was asked. */
export class ScriptedApprover implements Approver {
  readonly asked: ApprovalRequest[] = [];
  private i = 0;
  constructor(
    private readonly answers: ApprovalResult[],
    private readonly fallback?: ApprovalResult,
  ) {}
  async ask(request: ApprovalRequest): Promise<ApprovalResult> {
    this.asked.push(request);
    const a = this.answers[this.i++] ?? this.fallback;
    if (!a) throw new Error(`ScriptedApprover: no answer scripted for ${request.approvalId}`);
    return a;
  }
}

/** Builds the one-sentence summary shown to the approver (and stored in the ledger). */
export function summarizeCalls(calls: ProposedCall[]): string {
  const parts = calls.map((c) => {
    const keys = Object.keys(c.args);
    const shown = keys
      .slice(0, 3)
      .map((k) => `${k}=${short(c.args[k])}`)
      .join(", ");
    return `${c.toolName}(${shown}${keys.length > 3 ? ", …" : ""})`;
  });
  return `Approve ${calls.length} call${calls.length === 1 ? "" : "s"}: ${parts.join("; ")}`;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}
