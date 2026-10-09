/**
 * The defect-analysis service — the real one, at its real endpoint.
 *
 * `Application/defect-analysis-service` exposes `POST /analyze-report`, which
 * takes a test-execution report, auto-detects its format (`playwright-json` is
 * supported), parses it, and runs the whole pipeline: rules, LLM augmentation,
 * caching, grouping, retry planning and provenance. agentic-qa's job is to hand
 * it the report and use what comes back.
 *
 * ── What this replaced, and why it was wrong ──
 * The first version of this file POSTed a hand-built list of failures to
 * `/classify`, an endpoint that does not exist. It was written from the shape of
 * the in-process port rather than from the service's API, so it would have
 * 404'd on first contact and silently fallen back to the built-in rules
 * forever — the service would have looked "unreachable" rather than
 * misaddressed.
 *
 * ── What the service knows that the built-in rules cannot ──
 * The port in `classify.ts` is a mirror of `classifier.py`'s regex banks and
 * nothing else. The service adds four things that matter here and that no
 * amount of local pattern matching can produce:
 *
 *   - an LLM verdict on borderline failures, with a fix hint;
 *   - a FINGERPRINT per failure, stable across runs;
 *   - GROUPING by fingerprint, with the state of each group — including
 *     whether a bug has already been filed for it, and whether it has been
 *     suppressed;
 *   - a proposed bug summary and description, written from the failure.
 *
 * The third of those is the one that changes behaviour most. Without it, every
 * run proposes a bug for the same failure, and a reviewer approving twice files
 * the same defect twice. `existingBugKey` is how a run knows it has been here
 * before.
 *
 * The service remains an UPGRADE, never a dependency: unset `DEFECT_ANALYSIS_URL`
 * and triage runs entirely in-process with nothing leaving the machine.
 */

import { readFileSync } from "node:fs";
import type { TriageVerdict } from "./classify.js";
import { isTriageCategory } from "./patterns.js";

/** Minimal shape of `fetch`, so tests need no network and no globals. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ServiceOptions {
  /**
   * The service's base URL, e.g. `http://localhost:4200`.
   *
   * Read from the environment by the caller, NEVER from a work item, a spec, a
   * tool result or anything the model produced. An endpoint the agent could
   * choose is an exfiltration path with a friendly name.
   */
  url: string;
  fetch?: FetchLike;
  /**
   * How long to wait before falling back to the built-in rules.
   *
   * Longer than a plain classify call because `/analyze-report` may consult an
   * LLM, and short enough that a hung service cannot hang a run — the failure
   * mode that cost 26 minutes of silence before the model call was bounded.
   */
  timeoutMs?: number;
  /**
   * Send the report's PATH rather than its content.
   *
   * Only when the service shares this filesystem — the packaged EXE on the same
   * machine does, a container does not. Inline content is the default because
   * it works in both cases; a path that does not resolve server-side is a 404
   * the run cannot diagnose.
   */
  byPath?: boolean;
}

export const DEFAULT_SERVICE_TIMEOUT_MS = 30_000;

/** One group of failures sharing a fingerprint, with what is known about it. */
export interface AnalyzedGroup {
  fingerprint: string;
  category: string;
  count: number;
  firstTestId: string;
  sampleTestIds: string[];
  /** The service's own state for this fingerprint: new, filed, suppressed… */
  state?: string;
  /** Set when a bug already exists for this fingerprint. Do not file another. */
  existingBugKey?: string;
  existingBugUrl?: string;
  /** Set when a human has suppressed this fingerprint. Do not file, do not ask. */
  suppressedReason?: string;
  /** The service's proposed bug title and body, when it wrote one. */
  proposedSummary?: string;
  proposedDescription?: string;
}

export interface RetryPlan {
  testId: string;
  category: string;
  retryable: boolean;
  maxAttempts: number;
}

export interface AnalyzedReport {
  detectedFormat: string;
  /** Verdict per test id. */
  verdicts: Map<string, TriageVerdict>;
  /** Fingerprint per test id, stable across runs. */
  fingerprints: Map<string, string>;
  groups: AnalyzedGroup[];
  retryPlans: RetryPlan[];
  serviceVersion?: string;
}

/**
 * Hand the execution report to the service and map what comes back.
 *
 * Returns `undefined` on any failure to get a usable answer — unreachable,
 * non-200, malformed body, unparseable report. The caller's fallback is the
 * built-in verdicts it already computed, and there is no situation in which a
 * triage service being down should end a test run.
 */
export async function analyzeReport(
  args: { reportPath: string; runId: string },
  opts: ServiceOptions,
): Promise<AnalyzedReport | undefined> {
  const doFetch = opts.fetch ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!doFetch) return undefined;

  let body: string;
  try {
    body = JSON.stringify(
      opts.byPath
        ? {
            path: args.reportPath,
            run_id: args.runId,
            framework: "playwright",
          }
        : {
            format: "playwright-json",
            content: readFileSync(args.reportPath, "utf8"),
            run_id: args.runId,
            framework: "playwright",
          },
    );
  } catch {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS);

  try {
    const res = await doFetch(join(opts.url, "analyze-report"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return mapResponse((await res.json()) as Record<string, unknown>);
  } catch {
    // Timeout, abort, DNS, TLS, malformed JSON — all the same answer here. The
    // built-in verdicts stand and the report says the service did not answer.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function mapResponse(body: Record<string, unknown>): AnalyzedReport | undefined {
  const raw = body["classifications"];
  if (!Array.isArray(raw)) return undefined;

  const provenance = asRecord(body["provenance"]);
  const serviceVersion = str(provenance?.["service_version"]) ?? str(body["service_version"]);

  const verdicts = new Map<string, TriageVerdict>();
  const fingerprints = new Map<string, string>();

  for (const item of raw) {
    const c = asRecord(item);
    if (!c) continue;
    const test = str(c["test_id"]);
    const category = c["category"];
    // An out-of-vocabulary category is dropped rather than passed through, for
    // the same reason the defect profile rejects one: `runLevel` and the
    // quarantine are computed from these strings, and a verdict nobody can
    // compare against the next run's is not evidence.
    if (!test || !isTriageCategory(category)) continue;

    const fp = str(c["fingerprint"]);
    if (fp) fingerprints.set(test, fp);

    // The LLM's fix hint is appended to the rationale rather than dropped: it is
    // the most actionable sentence the service produces, and it has nowhere
    // else to go in the ledger.
    const rationale = str(c["rationale"]) ?? "";
    const hint = str(c["llm_fix_hint"]);
    verdicts.set(test, {
      test,
      category,
      confidence: typeof c["confidence"] === "number" ? c["confidence"] : 0,
      matchedPatterns: Array.isArray(c["matched_patterns"])
        ? c["matched_patterns"].filter((p): p is string => typeof p === "string")
        : [],
      evidence: str(c["evidence"]) ?? "",
      rationale: hint ? `${rationale} Fix hint: ${hint}` : rationale,
      triagedBy: "service",
      ...(serviceVersion !== undefined ? { serviceVersion } : {}),
    });
  }

  return {
    detectedFormat: str(body["detected_format"]) ?? "unknown",
    verdicts,
    fingerprints,
    groups: mapGroups(body["groups"]),
    retryPlans: mapPlans(body["retry_plans"]),
    ...(serviceVersion !== undefined ? { serviceVersion } : {}),
  };
}

function mapGroups(raw: unknown): AnalyzedGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: AnalyzedGroup[] = [];
  for (const item of raw) {
    const g = asRecord(item);
    const fingerprint = str(g?.["fingerprint"]);
    const category = str(g?.["category"]);
    if (!g || !fingerprint || !category) continue;
    out.push({
      fingerprint,
      category,
      count: typeof g["count"] === "number" ? g["count"] : 0,
      firstTestId: str(g["first_test_id"]) ?? "",
      sampleTestIds: Array.isArray(g["sample_test_ids"])
        ? g["sample_test_ids"].filter((s): s is string => typeof s === "string")
        : [],
      ...opt("state", str(g["state"])),
      ...opt("existingBugKey", str(g["existing_jira_key"])),
      ...opt("existingBugUrl", str(g["existing_jira_url"])),
      ...opt("suppressedReason", str(g["suppressed_reason"])),
      ...opt("proposedSummary", str(g["proposed_jira_summary"])),
      ...opt("proposedDescription", str(g["proposed_jira_description"])),
    });
  }
  return out;
}

function mapPlans(raw: unknown): RetryPlan[] {
  if (!Array.isArray(raw)) return [];
  const out: RetryPlan[] = [];
  for (const item of raw) {
    const p = asRecord(item);
    const testId = str(p?.["test_id"]);
    if (!p || !testId) continue;
    out.push({
      testId,
      category: str(p["category"]) ?? "",
      retryable: p["retryable"] === true,
      maxAttempts: typeof p["max_attempts"] === "number" ? p["max_attempts"] : 0,
    });
  }
  return out;
}

/**
 * Merge service verdicts over built-in ones, reporting where they disagreed.
 *
 * The service wins where it answered, because it is the implementation with the
 * learned path, the cache and the corpus behind it. But the built-in verdict is
 * not discarded silently: a disagreement is returned so the run can record it.
 * Disagreements are the training signal for the service and the drift alarm for
 * the port — the one thing having two implementations buys that having one does
 * not.
 */
export function merge(
  builtin: TriageVerdict[],
  fromService: Map<string, TriageVerdict>,
): {
  verdicts: TriageVerdict[];
  disagreements: Array<{ test: string; builtin: string; service: string }>;
} {
  const disagreements: Array<{ test: string; builtin: string; service: string }> = [];
  const verdicts = builtin.map((b) => {
    const s = fromService.get(b.test);
    if (!s) return b;
    if (s.category !== b.category) {
      disagreements.push({ test: b.test, builtin: b.category, service: s.category });
    }
    // The service's evidence field is not populated by /analyze-report, so the
    // built-in quote is kept: a verdict with no evidence is the unexplained
    // judgement this runtime refuses everywhere else.
    return s.evidence ? s : { ...s, evidence: b.evidence };
  });
  return { verdicts, disagreements };
}

/** Join a base URL and a path without doubling or dropping the separator. */
function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function opt<K extends string>(key: K, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, string>);
}
