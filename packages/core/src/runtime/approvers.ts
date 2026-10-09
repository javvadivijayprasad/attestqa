import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ApprovalRequest, ApprovalResult, Approver } from "./approval.js";
import { renderApproval } from "./render-approval.js";

/**
 * `--approval terminal`: prints the request and reads y/n from stdin.
 * Streams are injectable for tests.
 */
export class TerminalApprover implements Approver {
  constructor(
    private readonly io: { input: Readable; output: Writable } = {
      input: process.stdin,
      output: process.stdout,
    },
    private readonly who: string = process.env["USER"] ?? process.env["USERNAME"] ?? "terminal",
  ) {}

  async ask(request: ApprovalRequest): Promise<ApprovalResult> {
    const out = this.io.output;
    out.write(`\n[aqa] approval ${request.approvalId} requested\n`);
    if (request.note) out.write(`\n  ${request.note.replace(/\n/g, "\n  ")}\n`);
    out.write(
      renderApproval(request.calls, request.covered ? { covered: request.covered } : {}) + "\n",
    );
    // "v" shows the arguments verbatim. The full call is in the ledger either
    // way; this is for the reader who wants it without leaving the prompt.
    let answer = await this.prompt("  approve? [y/N/v=verbose] ");
    if (/^v(erbose)?$/i.test(answer.trim())) {
      out.write(
        renderApproval(request.calls, {
          verbose: true,
          ...(request.covered ? { covered: request.covered } : {}),
        }) + "\n",
      );
      answer = await this.prompt("  approve? [y/N] ");
    }
    const approved = /^y(es)?$/i.test(answer.trim());
    // A denial that says why is worth far more than one that does not: the
    // agent is told, in the reviewer's words, what to change.
    // Only where someone is actually sitting there: a piped or ended stdin
    // has no second answer to give, and waiting for one would hang the run.
    const interactive = (this.io.input as { isTTY?: boolean }).isTTY === true;
    const reason =
      approved || !interactive
        ? ""
        : (await this.prompt("  why not? (optional, Enter to skip) ")).trim();
    return {
      decision: approved ? "approved" : "denied",
      by: this.who,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
  }

  private prompt(q: string): Promise<string> {
    const rl = createInterface({ input: this.io.input, output: this.io.output, terminal: false });
    return new Promise((resolve) => {
      let answered = false;
      rl.question(q, (a) => {
        answered = true;
        resolve(a);
        rl.close();
      });
      // stdin closed without an answer (e.g. piped run) → treat as "no".
      rl.on("close", () => {
        if (!answered) resolve("");
      });
    });
  }
}

export interface FileApprovalRecord {
  approvalId: string;
  summary: string;
  calls: ApprovalRequest["calls"];
  requestedAt: string;
  /** Filled in by the platform (handoff B4). `null` until decided. */
  decision: "approved" | "denied" | null;
  by?: string;
  at?: string;
}

export interface FileApproverOptions {
  /** Directory where `<approvalId>.json` files live (the run's `approvals/`). */
  dir: string;
  /** Poll interval in ms. Default 1000. */
  pollMs?: number;
  /** Give up after this many ms and treat as denied. Default 30 minutes (handoff B4). */
  timeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `--approval file` (PLAN §0.4): writes `approvals/<id>.json` with `decision: null`
 * and polls until someone sets `decision`. On timeout the answer is `denied` with
 * `by: "timeout"`, which the loop turns into a `blocked` run.
 */
export class FileApprover implements Approver {
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: FileApproverOptions) {
    this.pollMs = opts.pollMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  path(approvalId: string): string {
    return join(this.opts.dir, `${approvalId}.json`);
  }

  async ask(request: ApprovalRequest): Promise<ApprovalResult> {
    mkdirSync(this.opts.dir, { recursive: true });
    const file = this.path(request.approvalId);
    const record: FileApprovalRecord = {
      approvalId: request.approvalId,
      summary: request.summary,
      calls: request.calls,
      requestedAt: new Date(this.now()).toISOString(),
      decision: null,
    };
    writeFileSync(file, JSON.stringify(record, null, 2), "utf8");

    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      const decided = readDecision(file);
      if (decided) return decided;
      if (this.now() >= deadline) {
        return { decision: "denied", by: "timeout", at: new Date(this.now()).toISOString() };
      }
      await this.sleep(this.pollMs);
    }
  }
}

function readDecision(file: string): ApprovalResult | undefined {
  if (!existsSync(file)) return undefined;
  let rec: Partial<FileApprovalRecord>;
  try {
    rec = JSON.parse(readFileSync(file, "utf8")) as Partial<FileApprovalRecord>;
  } catch {
    return undefined; // partial write in progress
  }
  if (rec.decision !== "approved" && rec.decision !== "denied") return undefined;
  return {
    decision: rec.decision,
    by: typeof rec.by === "string" && rec.by ? rec.by : "unknown",
    at: typeof rec.at === "string" && rec.at ? rec.at : new Date().toISOString(),
  };
}
