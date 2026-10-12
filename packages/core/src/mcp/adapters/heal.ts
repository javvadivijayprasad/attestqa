import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { asArray, asRecord, completedCalls, successful } from "../../verify/evidence.js";
import { CATCHES, rankCandidates, selectorFromMessage, stuckAction } from "../../heal/locator.js";
import { isPartialRead } from "../../design/test-design.js";
import { secondOpinion } from "../../heal/second-opinion.js";
import type { LedgerView } from "./summary.js";

/**
 * In-process `aqa.heal_locator`: what is actually on the page where a test
 * failed, as Playwright expressions.
 *
 * ── Why this is a tool and not advice ──
 * "Look at the page snapshot before changing the selector" was in the skill
 * text, and the agent still wrote the same failing selector again, then a
 * `try/catch` fallback around it, then four bugs about a menu item that had
 * been on screen the whole time (runs 20260923T235843Z, 20260925T114717Z).
 *
 * So the candidates are derived by code from the snapshot Playwright wrote at
 * the moment of failure, and the agent's remaining freedom is to choose one of
 * them. It cannot invent a selector here, and it cannot be told by the page
 * which one to pick — the ranking is mechanical.
 *
 * Classed `read`: it reads the ledger and returns text. Nothing is healed by
 * calling it. The repair is an ordinary `fs.write_file` to the spec, which the
 * story rules still police — the locator may change, what a quarantined test
 * asserts may not.
 */
export class HealTools implements ToolClient {
  readonly server = "aqa";

  constructor(private readonly ledger: LedgerView) {}

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "heal_locator",
        description:
          "For a test that FAILED because a locator matched nothing: list what was actually addressable " +
          "on the page at the moment it failed, as ready-to-paste Playwright expressions, ranked by how " +
          "well they match the selector that failed. Read from Playwright's own accessibility snapshot " +
          "of that failure — not guessed. Call this BEFORE changing any selector, and before proposing a " +
          "bug for a locator failure: a locator that matched nothing is a test defect until this says the " +
          "control is absent from the page. Change the locator only; never the assertions, and never wrap " +
          "it in try/catch. Then rerun that one test (pw.run_tests with grep), then the full suite.",
        inputSchema: {
          type: "object",
          properties: {
            test: {
              type: "string",
              description: "The failing test's title, or enough of it to identify it uniquely.",
            },
            selector: {
              type: "string",
              description:
                "Optional. The selector that failed. Left out, it is read from Playwright's error message.",
            },
          },
          required: ["test"],
        },
        policyClass: "read",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || name !== "heal_locator")
      return { ok: false, result: { message: `unknown aqa tool: ${name}` }, artefacts: [] };

    const wanted = typeof args["test"] === "string" ? args["test"].trim() : "";
    if (!wanted)
      return {
        ok: false,
        result: { message: "which test failed? pass its title in `test`." },
        artefacts: [],
      };

    const failures = failuresFromLedger(this.ledger.read());
    if (failures.length === 0)
      return {
        ok: false,
        result: {
          message:
            "no failing test has been recorded this run, so there is no page to read. Run the suite first.",
        },
        artefacts: [],
      };

    const hit = pick(failures, wanted);
    if (!hit)
      return {
        ok: false,
        result: {
          message: `no failing test matches "${wanted}"`,
          failingTests: failures.map((f) => f.title),
        },
        artefacts: [],
      };

    if (!hit.pageAtFailure)
      return {
        ok: false,
        result: {
          message:
            `"${hit.title}" failed, but Playwright recorded no page snapshot for it, so the page cannot ` +
            "be read. This happens when the failure was not a timeout waiting for an element — read the " +
            "error message instead.",
          error: hit.message,
        },
        artefacts: [],
      };

    // A snapshot is only evidence about the step that broke. When the test
    // recovered from its own break, Playwright took the snapshot LATER — after
    // the fallback had navigated somewhere else — so the page in it is not the
    // page the locator was looking at.
    //
    // 20260925T174149Z: the fallback had loaded a route the application does
    // not have, the failure was an assertion, and this tool duly reported five
    // buttons from the wrong page and "the control may genuinely be absent".
    // The agent believed it, stopped trying to repair the selector and went
    // looking at the application by hand. An answer from the wrong page is
    // worse than no answer, so this refuses instead.
    if (!stuckAction(hit.message) && swallows(hit.title, this.ledger.read()))
      return {
        ok: false,
        result: {
          message:
            `"${hit.title}" did not fail on a locator — it failed on an assertion, and its code ` +
            "catches its own failure (try/catch or .catch) and carries on. So the page snapshot " +
            "Playwright saved is from AFTER the fallback ran, not from where the locator broke, and " +
            "nothing can be concluded from it about the control you were looking for.",
          do: [
            "Remove the try/catch and the fallback from the spec — the locator line may stay as it is.",
            "Re-run this one test (pw.run_tests with grep set to its title).",
            "Call aqa.heal_locator again: the failure will then be the locator itself, and the " +
              "snapshot will be the page at that moment.",
          ],
          error: hit.message,
        },
        artefacts: [],
      };

    const failedSelector =
      (typeof args["selector"] === "string" && args["selector"].trim()) ||
      selectorFromMessage(hit.message) ||
      "";

    const candidates = rankCandidates(hit.pageAtFailure, failedSelector);
    if (candidates.length === 0)
      return {
        ok: true,
        result: {
          test: hit.title,
          failedSelector,
          candidates: [],
          verdict:
            "NOTHING CLICKABLE OR TYPEABLE WAS ON THE PAGE when this test failed. The page was probably " +
            "not the one the test expected — check the navigation and the application state before it, " +
            "not the selector.",
        },
        artefacts: [],
      };

    const best = candidates[0];
    const matched = best && best.score >= 10;
    // pw-self-heal ranks the same candidates independently. It is recorded,
    // and shown to the agent, but the verdict below is still attestqa's own:
    // the comparison is evidence to collect, not yet a reason to change which
    // ranker decides.
    const second = await secondOpinion(failedSelector, candidates, best);
    return {
      ok: true,
      result: {
        test: hit.title,
        failedSelector: failedSelector || "(not named in the error message)",
        candidates,
        ...(second ? { secondOpinion: second } : {}),
        verdict: matched
          ? `The control this test was looking for IS on the page, as ${best?.role}` +
            (best?.name ? ` "${best.name}"` : "") +
            ". This is a TEST defect, not a product defect: the selector is wrong."
          : "No candidate shares a word with the selector that failed. The control may genuinely be " +
            "absent — say so in the bug, quoting what WAS on the page, and do not change the selector " +
            "to something that merely exists.",
        next:
          "Change the locator in the spec to one of these expressions — that line only, no new " +
          "assertions, no try/catch, nothing deleted. Then rerun this test alone " +
          "(pw.run_tests with grep set to its title), and if it passes, run the full suite.",
      },
      artefacts: [],
    };
  }
}

interface LedgerFailure {
  title: string;
  file: string;
  message: string;
  pageAtFailure?: string;
}

/**
 * Every failure the ledger holds, latest run last — so the newest record of a
 * test is the one that wins.
 *
 * Deliberately NOT restricted to the last FULL run: healing works one test at
 * a time, and the filtered rerun is where the fresh snapshot lives.
 */
export function failuresFromLedger(events: Parameters<typeof completedCalls>[0]): LedgerFailure[] {
  const byTitle = new Map<string, LedgerFailure>();
  for (const call of successful(completedCalls(events), "pw.run_tests")) {
    const rec = asRecord(call.result);
    for (const raw of asArray(rec?.["failures"])) {
      const f = asRecord(raw);
      const title = typeof f?.["title"] === "string" ? f["title"] : "";
      if (!title) continue;
      byTitle.set(title, {
        title,
        file: typeof f?.["file"] === "string" ? f["file"] : "",
        message: typeof f?.["message"] === "string" ? f["message"] : "",
        ...(typeof f?.["pageAtFailure"] === "string" ? { pageAtFailure: f["pageAtFailure"] } : {}),
      });
    }
  }
  return [...byTitle.values()];
}

/**
 * Whether the failing test, or a helper in the spec it lives in, recovers from
 * its own failure. Read from whatever spec text the run has seen.
 */
function swallows(title: string, events: Parameters<typeof completedCalls>[0]): boolean {
  for (const c of completedCalls(events)) {
    if (!c.ok) continue;
    const path = String(c.args["path"] ?? "");
    if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) continue;
    // A ranged read is a fragment: a try/catch outside the window would read as
    // absent, and this rule would then trust a snapshot taken at the wrong
    // moment. See `fileTextFromEvents`.
    if (c.toolName === "fs.read_file" && isPartialRead(c.args, c.result)) continue;
    const text =
      c.toolName === "fs.write_file"
        ? String(c.args["content"] ?? "")
        : typeof asRecord(c.result)?.["content"] === "string"
        ? String(asRecord(c.result)?.["content"])
        : "";
    if (!text) continue;
    const body = bodyOf(text, title);
    if (body !== undefined && CATCHES.test(body)) return true;
    // Helpers live outside every test body, and that is where the logout
    // fallback was.
    const firstTest = text.search(/\btest(?:\.(?:only|skip|fixme|fail|slow))?\s*\(/);
    const helpers = firstTest === -1 ? text : text.slice(0, firstTest);
    if (text.includes(title) && CATCHES.test(helpers)) return true;
  }
  return false;
}

/** One test's body, by title, from a spec's text. */
function bodyOf(spec: string, title: string): string | undefined {
  const at = spec.indexOf(title);
  if (at === -1) return undefined;
  const rest = spec.slice(at);
  const next = rest.slice(1).search(/\btest(?:\.(?:only|skip|fixme|fail|slow))?\s*\(/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Exact title first, then a unique substring — a partial match that is ambiguous is no match. */
function pick(failures: LedgerFailure[], wanted: string): LedgerFailure | undefined {
  const exact = failures.find((f) => f.title === wanted);
  if (exact) return exact;
  const needle = wanted.toLowerCase();
  const loose = failures.filter((f) => f.title.toLowerCase().includes(needle));
  return loose.length === 1 ? loose[0] : undefined;
}
