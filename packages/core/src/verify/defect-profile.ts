import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Gap, Verifier, VerifierInput, VerifyPayload } from "../types.js";
import { completedCalls, successful } from "./evidence.js";
import {
  countProfile,
  profileProblems,
  PROFILE_DIR,
  PROFILE_FILE,
  type DefectProfile,
} from "../defects/taxonomy.js";

export interface DefectProfileVerifierOptions {
  /** Minimum classified records before a profile is worth acting on. Default 1. */
  minRecords?: number;
  /** Override the profile path; defaults to <workspace>/.aqa-profile/defects.json. */
  file?: string;
}

/**
 * Decides "done" for the defect-profile skill.
 *
 * The checks ask what is TRUE of the workspace, not what this run did — the
 * lesson the story-to-tests verifier learned the expensive way. A run that
 * finds an existing, valid profile covering the bugs the query returned has
 * nothing to do, and must be allowed to say so. A verifier that demanded
 * classification work would get classification work: the same bugs re-read and
 * re-classified on every run, with the wording drifting each time, which is
 * precisely what makes two profiles incomparable.
 *
 *   1. bugs were queried          (a successful ado.wit_query)
 *   2. a profile exists on disk   (whenever it was written)
 *   3. it is in-vocabulary        (Paper F surface + exception type, with evidence)
 *   4. it covers what was queried (no bug returned by the query left unclassified)
 */
export class DefectProfileVerifier implements Verifier {
  readonly name = "defect-profile";

  constructor(private readonly opts: DefectProfileVerifierOptions = {}) {}

  async verify(input: VerifierInput): Promise<VerifyPayload> {
    const gaps: Gap[] = [];
    const limitations: string[] = [];
    const calls = completedCalls(input.events);

    const queries = successful(calls, "ado.wit_query");
    if (queries.length === 0) {
      gaps.push({
        code: "bugs-not-queried",
        message: "No successful ado.wit_query — the bug history was never read.",
        evidence: { toolsCalled: [...new Set(calls.map((c) => c.toolName))] },
      });
    }

    const file = this.opts.file ?? join(resolve(input.workspaceDir), PROFILE_DIR, PROFILE_FILE);
    if (!existsSync(file)) {
      gaps.push({
        code: "no-profile",
        message: `No defect profile at ${file}.`,
        evidence: { expectedAt: file },
      });
      // Nothing further is checkable without the file.
      return { done: false, gaps, ...(limitations.length > 0 ? { limitations } : {}) };
    }

    let profile: DefectProfile;
    try {
      profile = JSON.parse(readFileSync(file, "utf8")) as DefectProfile;
      if (!Array.isArray(profile.records)) throw new Error("records is not an array");
    } catch (err) {
      gaps.push({
        code: "profile-unreadable",
        message: `The profile at ${file} is not readable as a defect profile: ${String(err)}`,
        evidence: { file },
      });
      return { done: false, gaps, ...(limitations.length > 0 ? { limitations } : {}) };
    }

    const counts = countProfile(profile.records);
    const minRecords = this.opts.minRecords ?? 1;
    const refusedIds = new Set(Array.isArray(profile.outOfScope) ? profile.outOfScope : []);

    // A project with no closed bugs is a fact about the project, not a failure
    // of the run. Recording it as a limitation says "this check was not made,
    // and here is why" rather than pretending a profile of nothing is useful.
    const queried = Array.isArray(profile.queried) ? profile.queried : [];
    if (counts.total === 0 && queried.length === 0) {
      limitations.push(
        "defect profile — the query returned no closed bugs, so there is no history to profile " +
          "in this project yet; test design falls back to the acceptance criteria alone",
      );
    } else if (
      counts.total === 0 &&
      queried.length > 0 &&
      queried.every((id) => refusedIds.has(id))
    ) {
      // Distinguished from "too small" because the count is not the problem and
      // the agent cannot act on it. Observed on run 20260917T224804Z-4d55f794:
      // six bugs found, all six refused, and the verifier reported "0 bugs, at
      // least 1 required" — true, and useless to the person reading it. A gap
      // whose message does not name the fix sends someone to the wrong place.
      gaps.push({
        code: "all-bugs-out-of-scope",
        message:
          `All ${queried.length} bug(s) the query returned are outside agent.scope.work_items, ` +
          "so none could be read or classified. This is a configuration decision, not something " +
          "the agent can resolve: widen agent.scope.work_items to cover these ids and run again.",
        evidence: { queried, suggestedScope: suggestRange(queried) },
      });
    } else if (counts.total < minRecords) {
      gaps.push({
        code: "profile-too-small",
        message: `The profile classifies ${counts.total} bug(s); at least ${minRecords} is required.`,
        evidence: { total: counts.total, queried: queried.length },
      });
    }

    const problems = profileProblems(profile);
    if (problems.length > 0) {
      gaps.push({
        code: "profile-out-of-vocabulary",
        message:
          "The profile contains classifications outside the agreed vocabulary, or without " +
          "evidence. A classification nobody can compare against the next run's is not evidence.",
        evidence: { problems: problems.slice(0, 10), problemCount: problems.length },
      });
    }

    const classified = new Set(profile.records.map((r) => r.id));
    // Ids the gate refused as out of scope are accounted for, not counted
    // against the run. `scope.work_items` is the operator's statement of what
    // the agent may read, and an agent cannot classify a bug it was correctly
    // forbidden to open.
    const refused = refusedIds;
    const missed = queried.filter((id) => !classified.has(id) && !refused.has(id));

    if (refused.size > 0) {
      limitations.push(
        `defect profile — ${refused.size} bug(s) returned by the query are outside ` +
          "`scope.work_items`, so they were refused and could not be classified; the " +
          "distribution is drawn from the bugs in scope rather than from the whole history",
      );
    }

    if (missed.length > 0) {
      gaps.push({
        code: "bugs-left-unclassified",
        message:
          `${missed.length} bug(s) returned by the query are absent from the profile and were ` +
          "not recorded as out of scope. A profile that quietly drops what it could not " +
          "classify reports a distribution that is not the product's.",
        evidence: { missed: missed.slice(0, 20), queried: queried.length, outOfScope: refused.size },
      });
    }

    return {
      done: gaps.length === 0,
      gaps,
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  }
}

/**
 * The scope entry that would have admitted these ids, so the gap tells the
 * reader what to paste rather than leaving them to work it out from a list.
 */
function suggestRange(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  if (lo === undefined || hi === undefined) return "";
  return lo === hi ? `"${lo}"` : `"${lo}-${hi}"`;
}
