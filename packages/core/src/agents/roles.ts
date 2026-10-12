/**
 * Roles: which agent the run is being, decided by code from the ledger.
 *
 * ── Why a role rather than a skill ──
 * One model has been carrying a 9,800-token instruction set covering design,
 * BDD vocabulary, page objects, healing, triage and bug filing, and re-reading
 * all of it on every turn. Most of it is irrelevant to the turn in front of it.
 * Worse, the instructions for one job are available as excuses in another: the
 * run that softened a quarantined test had "the pipeline is feature →
 * scaffold → implement" in front of it while trying to repair a locator.
 *
 * A role narrows BOTH halves at once: the tools the model is shown and the
 * instructions it is given. It is chosen here, in code, from what the run has
 * observed — never by the model electing to be something else — and each change
 * is an `agent` event in the ledger, so a replay says which agent did what.
 *
 * This is the first slice: `heal`, the smallest and most dangerous job, where a
 * model with the whole instruction set kept reaching for the wrong half of it.
 * Everything else stays with the default role, whose tools and instructions are
 * the skill's own.
 */

import type { AnyRunEvent } from "../types.js";
import { asArray, asRecord, completedCalls, successful } from "../verify/evidence.js";
import { CATCHES, stuckAction } from "../heal/locator.js";
import { isPartialRead, testsByTitle } from "../design/test-design.js";

export type RoleName = "heal" | "default";

export interface Role {
  name: RoleName;
  /** Tools this role may see. Empty for `default`, which keeps the skill's list. */
  tools: string[];
  /** Appended to the skill's instructions while the role is active. */
  instructions: string;
  /** One line for the ledger and the terminal: why this role, now. */
  because: string;
}

/**
 * The healer's whole brief. Twenty-odd lines, because the job is small: read
 * the page the failure handed you, choose a locator you did not invent, change
 * that line, run the test.
 */
const HEAL_INSTRUCTIONS = `YOU ARE THE HEAL AGENT. A test failed on a locator. Your job is that locator and
nothing else.

1. Call aqa.heal_locator with the failing test's title. It reads the page
   snapshot Playwright saved at the failure and returns the controls that were
   really there, as Playwright expressions, ranked against the selector that
   failed.
2. Change the LOCATOR LINE with fs.replace_in_file — never fs.write_file. Pass
   the exact old line as \`old\` and the new one as \`new\`; the edit is refused
   unless that text occurs exactly once, so include a neighbouring line if it
   is ambiguous. Rewriting the whole file means reproducing every line you
   cannot see, and what you fail to reproduce is lost.
   Quote the expression you chose and why. Nothing else may change: not an
   assertion, not a wait, not a comment about what the application "correctly"
   does. A test may be strengthened; it may not be softened.
3. Re-run that one test: pw.run_tests with grep set to its title.
4. If it passes, run the FULL suite — the report and the triage are counted from
   the last unfiltered run, so a filtered green proves nothing on its own.
5. If it still fails on a locator, call aqa.heal_locator again and take the next
   candidate. If it fails for a different reason, say so and stop: that is a new
   failure and not yours.

If aqa.heal_locator says no candidate matches — the control really is absent —
STOP. Do not reach for a selector that merely exists. Say what the page had
instead, and leave the failure standing: an honest red test is the finding.

If the failing test catches its own failure (try/catch, .catch), remove that
fallback FIRST and re-run: until it is gone the snapshot is of the wrong moment
and every conclusion from it is wrong.`;

const HEAL_TOOLS = [
  "aqa.heal_locator",
  "fs.read_file",
  // The edit tool, not the write tool: a heal changes one line.
  "fs.replace_in_file",
  "pw.run_tests",
  "pw.list_tests",
];

/**
 * Which role the run is in, from what it has observed.
 *
 * `heal` starts when a run has a failure that is a locator failure — or one
 * whose test recovers from its own break, which is the same problem wearing an
 * assertion's clothes — and ends when neither is true any more.
 */
export function roleFor(events: AnyRunEvent[]): Role {
  const healable = healableFailure(events);
  if (healable)
    return {
      name: "heal",
      tools: [...HEAL_TOOLS],
      instructions: HEAL_INSTRUCTIONS,
      because: `"${healable.title}" failed on ${
        healable.why === "locator"
          ? "an action that never completed — a locator that matched nothing"
          : "an assertion, and its code catches its own failure"
      }`,
    };
  return { name: "default", tools: [], instructions: "", because: "" };
}

function healableFailure(
  events: AnyRunEvent[],
): { title: string; why: "locator" | "fallback" } | undefined {
  const calls = completedCalls(events);
  const runs = successful(calls, "pw.run_tests");
  const last = runs[runs.length - 1];
  if (!last) return undefined;

  // The spec as the run last saw it — where a fallback would be.
  const specs = new Map<string, string>();
  for (const c of calls) {
    if (!c.ok) continue;
    const path = String(c.args["path"] ?? "");
    if (!/\.(spec|test)\.[cm]?[jt]sx?$/i.test(path)) continue;
    if (c.toolName === "fs.write_file") specs.set(path, String(c.args["content"] ?? ""));
    // A ranged read is a fragment; a fallback outside the window would look
    // absent and the role would be chosen from half a file.
    else if (c.toolName === "fs.read_file" && !isPartialRead(c.args, c.result)) {
      const content = asRecord(c.result)?.["content"];
      if (typeof content === "string") specs.set(path, content);
    }
  }
  const anySpec = [...specs.values()].join("\n");

  for (const raw of asArray(asRecord(last.result)?.["failures"])) {
    const f = asRecord(raw);
    const title = typeof f?.["title"] === "string" ? f["title"] : "";
    const message = typeof f?.["message"] === "string" ? f["message"] : "";
    if (!title) continue;
    if (stuckAction(message)) return { title, why: "locator" };
    // A test that recovers from its own break reports an assertion failure, so
    // the locator error never surfaces. Same job, one step earlier.
    // The fallback has to be in THAT test's own body. Matching the whole file
    // put every failing test into the heal role because a beforeEach dismissed
    // a pop-up with `.catch(() => {})` (run 20261012T001248Z): an assertion
    // failure was "healed" with five tools and no way to add the design's new
    // scenario.
    const body = anySpec ? (testsByTitle(anySpec).get(title) ?? "") : "";
    if (body && CATCHES.test(body)) return { title, why: "fallback" };
  }
  return undefined;
}
