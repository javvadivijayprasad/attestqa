import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import {
  countProfile,
  profileProblems,
  rankedPairs,
  PROFILE_DIR,
  PROFILE_FILE,
  VOCABULARY_PROVENANCE,
  TECHNIQUE_MEANINGS,
  type DefectProfile,
  type DefectRecord,
} from "../../defects/taxonomy.js";

export interface DefectProfileOptions {
  /** Where the profile lives. Defaults to <workspace>/.aqa-profile/defects.json. */
  file?: string;
}

/**
 * In-process `aqa` adapter: what the product's own defect history says.
 *
 * The division of labour is the same one the rest of this runtime keeps.
 * Deciding that a bug about a stale button lived on the `locator` surface is a
 * judgement, and the model makes it. Deciding that such bugs are 41% of the
 * history is arithmetic, and the model must not do it — a model that both
 * classifies and tallies its own classifications has no independent check on
 * either, and the tally is the part a test designer will act on.
 *
 * So this reads the written records and counts them. It writes nothing, which
 * is why it is classed `read`.
 */
export class DefectProfileTools implements ToolClient {
  readonly server = "aqa";
  private readonly file: string;

  constructor(workspaceDir: string, opts: DefectProfileOptions = {}) {
    this.file = opts.file ?? join(resolve(workspaceDir), PROFILE_DIR, PROFILE_FILE);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "defect_profile",
        description:
          "Read this product's defect profile: how its closed bugs divide by surface (locator, " +
          "validator, schema, config, app_code, fixture) and failure signal (Paper F's exception " +
          "types). Returns counts and the ranked surface/exception pairs, " +
          "COUNTED from the classified records rather than recalled — use these figures as given " +
          "and do not restate your own. Returns { present: false } when no profile has been " +
          "built, which is not an error: design tests from the acceptance criteria as usual. " +
          "Reads one file; writes nothing.",
        inputSchema: { type: "object", properties: {}, required: [] },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "defect_context",
        description:
          "The individual past defects of this product, for designing tests against ONE story. " +
          "Returns every classified bug with its title, surface, the test technique that would " +
          "have caught it, and the quoted evidence. YOU decide which of them touch the story you " +
          "are writing tests for — that judgement is yours and is not made here — and you must " +
          "say which ones you judged related and why. A distribution tells you nothing about a " +
          "single story; these records do. Returns { present: false } when no profile exists. " +
          "Reads one file; writes nothing.",
        inputSchema: { type: "object", properties: {}, required: [] },
        policyClass: "read",
      },
    ];
  }

  async call(server: string, name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || (name !== "defect_profile" && name !== "defect_context"))
      return { ok: false, result: { message: `unknown aqa tool: ${name}` }, artefacts: [] };

    if (!existsSync(this.file)) {
      // Absent is a normal state, not a failure. A team that has not built a
      // profile still gets tests; they are just designed from the criteria
      // alone. Returning ok:false here would put a refusal in the ledger for
      // something nobody did wrong.
      return {
        ok: true,
        result: {
          present: false,
          message: "No defect profile has been built for this workspace.",
        },
        artefacts: [],
      };
    }

    let profile: DefectProfile;
    try {
      profile = JSON.parse(readFileSync(this.file, "utf8")) as DefectProfile;
      if (!Array.isArray(profile.records)) throw new Error("no records array");
    } catch (err) {
      return {
        ok: false,
        result: { message: `defect profile at ${this.file} could not be read: ${String(err)}` },
        artefacts: [],
      };
    }

    const counts = countProfile(profile.records);
    const problems = profileProblems(profile);

    if (name === "defect_context") {
      return {
        ok: true,
        result: {
          present: true,
          project: profile.project,
          total: counts.total,
          defects: profile.records.map(compact),
          techniques: TECHNIQUE_MEANINGS,
          guidance:
            "Judge which of these touch the story you are testing, and say which and why. " +
            "For each one you judge related, write a test that would have caught it — the " +
            "technique field names what was missing. Relevance is your judgement; do not " +
            "pretend it was counted.",
          ...(problems.length > 0 ? { problems } : {}),
        },
        artefacts: [],
      };
    }

    return {
      ok: true,
      result: {
        present: true,
        project: profile.project,
        generatedAt: profile.generatedAt,
        counts,
        ranked: rankedPairs(counts).slice(0, 8),
        text: render(profile, counts),
        // Surfaced rather than hidden: a profile with bad records still counts,
        // and the reader should know which part of it not to trust.
        ...(problems.length > 0 ? { problems } : {}),
      },
      artefacts: [],
    };
  }
}

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : "0%";
}

/** A short brief the test designer can act on, in the profile's own numbers. */
export function render(profile: DefectProfile, counts: ReturnType<typeof countProfile>): string {
  if (counts.total === 0) {
    return `No classified defects in the profile for ${profile.project}. Design from the acceptance criteria.`;
  }

  const surfaces = Object.entries(counts.bySurface)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${pct(n, counts.total)}`)
    .join(" · ");

  const top = rankedPairs(counts)
    .slice(0, 5)
    .map((p) => `- ${p.pair} — ${p.n} of ${counts.total} (${pct(p.n, counts.total)})`)
    .join("\n");

  const testSide =
    counts.testSideTotal > 0
      ? `\n${counts.testSideTotal} of these (${pct(counts.testSideTotal, counts.total)}) are \`fixture\` — test defects rather than product defects.`
      : "";

  return [
    `**Defect profile — ${profile.project}**, ${counts.total} classified bug${counts.total === 1 ? "" : "s"}.`,
    ``,
    `By surface: ${surfaces}`,
    ``,
    `Most frequent surface/failure pairs:`,
    top,
    testSide,
    ``,
    `_Counted from the classified records, not from the agent's recollection of them._`,
    `_Vocabulary: ${profile.vocabulary ?? VOCABULARY_PROVENANCE}_`,
  ].join("\n");
}

/** What a test designer needs per defect, and nothing else. */
function compact(r: DefectRecord): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    surface: r.surface,
    technique: r.technique,
    evidence: r.evidence,
    ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
  };
}
