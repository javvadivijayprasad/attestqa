import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFECT_PROFILE_TOOLS,
  JIRA_PROFILE_MAX_BUGS,
  defectProfileInstructions,
  defectProfileSkill,
  defectProfileSources,
  defectProfileTools,
} from "../src/skills/defect-profile.js";
import { DefectProfileVerifier } from "../src/verify/defect-profile.js";
import { DefectProfileTools } from "../src/mcp/adapters/defect-profile.js";
import {
  PROFILE_DIR,
  PROFILE_FILE,
  isBugId,
  profileProblems,
  type DefectProfile,
  type DefectRecord,
} from "../src/defects/taxonomy.js";
import { jiraProfileProject } from "../src/cli.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * The defect profile for both trackers (2.5.0).
 *
 * The skill read Azure DevOps bug history and nothing else; `aqa run --skill
 * defect-profile --tracker jira` was refused at the command line. The profile
 * itself — the file, the vocabulary, what story-to-tests reads back — never
 * depended on the tracker. Only three things did: the two reads, the shape of a
 * bug's id, and the name of the project. These tests hold those three for Jira
 * and hold everything else still for Azure DevOps.
 */

type Tracker = "ado" | "jira";

function ledgerOf(tools: string[]): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  let id = 0;
  const base = { tool: "attestqa" as const, runId: "r", timestamp: 1 };
  for (const tool of tools) {
    const callId = ++id;
    events.push({
      ...base,
      eventId: callId,
      kind: "call",
      payload: {
        server: tool.split(".")[0] as string,
        toolName: tool.slice(tool.indexOf(".") + 1),
        args: {},
        startedAt: 0,
      },
    } as unknown as AnyRunEvent);
    events.push({
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: { eventIdOfCall: callId, ok: true, result: {}, artefacts: [], durationMs: 1 },
    } as unknown as AnyRunEvent);
  }
  return events;
}

const record = (id: number | string): DefectRecord => ({
  id,
  title: "Registration accepts a customer aged 75",
  surface: "validator",
  technique: "boundary-value-analysis",
  exceptionType: "Other",
  evidence: '"a customer aged 75 is accepted"',
});

const QUERY: Record<Tracker, string> = { ado: "ado.wit_query", jira: "jira.search" };
const IDS: Record<Tracker, [number | string, number | string]> = {
  ado: [101, 102],
  jira: ["TOOL-36", "TOOL-38"],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aqa-profile-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProfile(profile: Partial<DefectProfile>): void {
  mkdirSync(join(dir, PROFILE_DIR), { recursive: true });
  writeFileSync(
    join(dir, PROFILE_DIR, PROFILE_FILE),
    JSON.stringify({ project: "p", query: "q", generatedAt: "2026-11-24", ...profile }),
  );
}

const verify = (tracker: Tracker, tools: string[]) =>
  new DefectProfileVerifier(tracker === "jira" ? { tracker } : {}).verify({
    events: ledgerOf(tools),
    workspaceDir: dir,
  });

describe("defect profile: what a run is given, per tracker", () => {
  it("offers a Jira run the two Jira reads and no Azure DevOps tool", () => {
    const jira = defectProfileTools("jira");
    expect(jira.filter((t) => t.startsWith("ado."))).toEqual([]);
    expect(jira.filter((t) => t.startsWith("jira.")).sort()).toEqual([
      "jira.get_issue",
      "jira.search",
    ]);
    // Everything that is not a tracker read is the same list.
    const rest = (tools: string[]) => tools.filter((t) => !/^(ado|jira)\./.test(t));
    expect(rest(jira)).toEqual(rest(DEFECT_PROFILE_TOOLS));
    expect(defectProfileSources("jira")).toEqual(["jira.search", "jira.get_issue"]);
  });

  it("offers no tool that writes to a tracker, in either", () => {
    for (const t of ["ado", "jira"] as const)
      expect(defectProfileTools(t).filter((x) => /create|write|record_qa/.test(x))).toEqual([
        "fs.write_file",
      ]);
  });

  it("leaves an Azure DevOps run exactly what it had", () => {
    expect(defectProfileTools("ado")).toBe(DEFECT_PROFILE_TOOLS);
    const skill = defectProfileSkill({ project: "attestqa-booker" });
    expect(skill.allowedTools).toBe(DEFECT_PROFILE_TOOLS);
    expect(skill.sourceTools).toEqual(["ado.wit_query", "ado.wit_work_item"]);
    expect(skill.instructions).toBe(defectProfileInstructions("attestqa-booker", 200));
    expect(skill.instructions).toContain("[System.TeamProject] = 'attestqa-booker'");
    expect(skill.instructions).not.toMatch(/jira|JQL/i);
  });

  it("tells a Jira run how to find and read Jira bugs, in Jira's words only", () => {
    const text = defectProfileSkill({ project: "TOOL", tracker: "jira" }).instructions;
    expect(text).toContain("project = TOOL AND issuetype = Bug AND statusCategory = Done");
    expect(text).toContain("jira.get_issue, one key per call");
    expect(text).toContain('"id": "TOOL-42"');
    expect(text).toContain("<the JQL you ran>");
    expect(text).not.toMatch(/ado\.|WIQL|System\.|Microsoft\.VSTS|get_batch|"closedAt":/);
  });

  it("caps a Jira profile at what one search returns", () => {
    const asked = (maxBugs?: number) =>
      defectProfileSkill({
        project: "TOOL",
        tracker: "jira",
        ...(maxBugs !== undefined ? { maxBugs } : {}),
      }).instructions;
    expect(asked()).toContain(`maxResults ${JIRA_PROFILE_MAX_BUGS}`);
    expect(asked(500)).toContain(`maxResults ${JIRA_PROFILE_MAX_BUGS}`);
    expect(asked(20)).toContain("maxResults 20");
  });
});

describe("defect profile: the file takes either tracker's ids", () => {
  it("accepts a work item number and a Jira key, and nothing else", () => {
    expect([7, "TOOL-36", "SHOP_2-1"].map(isBugId)).toEqual([true, true, true]);
    expect(["36", "tool-36", "TOOL-", "", undefined, null, NaN].map(isBugId)).toEqual(
      Array(7).fill(false),
    );
  });

  it("finds no problem in a profile of Jira bugs, and names a bug classified twice by its key", () => {
    const profile = (records: DefectRecord[]): DefectProfile => ({
      project: "TOOL",
      query: "q",
      generatedAt: "2026-11-24",
      queried: records.map((r) => r.id),
      records,
    });
    expect(profileProblems(profile([record("TOOL-36"), record("TOOL-38")]))).toEqual([]);
    expect(profileProblems(profile([record("TOOL-36"), record("TOOL-36")]))).toEqual([
      "work item TOOL-36 is classified more than once",
    ]);
    expect(profileProblems(profile([record("thirty-six")]))[0]).toMatch(/a record has no id/);
  });

  it("gives story-to-tests the Jira bugs back with their keys", async () => {
    writeProfile({ queried: ["TOOL-36"], records: [record("TOOL-36")] });
    const tools = new DefectProfileTools(dir);
    const context = await tools.call("aqa", "defect_context", {});
    expect(context.ok).toBe(true);
    const result = context.result as { defects: Array<{ id: unknown }>; total: number };
    expect(result.total).toBe(1);
    expect(result.defects[0]?.id).toBe("TOOL-36");
  });
});

describe("defect profile: the verifier decides the same things for both trackers", () => {
  for (const t of ["ado", "jira"] as const) {
    const [a, b] = IDS[t];

    it(`${t}: done when the history was queried and every bug is classified`, async () => {
      writeProfile({ queried: [a, b], records: [record(a), record(b)] });
      expect(await verify(t, [QUERY[t]])).toEqual({ done: true, gaps: [] });
    });

    it(`${t}: not done when the history was never queried, and says which read is missing`, async () => {
      writeProfile({ queried: [a], records: [record(a)] });
      const out = await verify(t, ["fs.write_file"]);
      expect(out.gaps.map((g) => g.code)).toEqual(["bugs-not-queried"]);
      expect(out.gaps[0]?.message).toContain(QUERY[t]);
    });

    it(`${t}: a bug the query returned and the profile dropped is a gap`, async () => {
      writeProfile({ queried: [a, b], records: [record(a)] });
      const out = await verify(t, [QUERY[t]]);
      expect(out.gaps.map((g) => g.code)).toEqual(["bugs-left-unclassified"]);
      expect((out.gaps[0]?.evidence as { missed: unknown[] }).missed).toEqual([b]);
    });

    it(`${t}: a bug the gate refused is a limitation, not a gap`, async () => {
      writeProfile({ queried: [a, b], records: [record(a)], outOfScope: [b] });
      const out = await verify(t, [QUERY[t]]);
      expect(out.done).toBe(true);
      expect(out.limitations?.join()).toMatch(/1 bug\(s\) returned by the query are outside/);
    });

    it(`${t}: a project with no closed bugs finishes, and says there is no history`, async () => {
      writeProfile({ queried: [], records: [] });
      const out = await verify(t, [QUERY[t]]);
      expect(out.done).toBe(true);
      expect(out.limitations?.join()).toMatch(/the query returned no closed bugs/);
    });
  }

  it("a Jira run that only queried Azure DevOps has not queried its bugs", async () => {
    writeProfile({ queried: ["TOOL-36"], records: [record("TOOL-36")] });
    expect((await verify("jira", ["ado.wit_query"])).gaps.map((g) => g.code)).toEqual([
      "bugs-not-queried",
    ]);
  });

  it("names the scope entry to add when every bug was refused: a range, or the Jira project", async () => {
    const suggested = async (t: Tracker) => {
      writeProfile({ queried: IDS[t], records: [], outOfScope: IDS[t] });
      const gap = (await verify(t, [QUERY[t]])).gaps.find(
        (g) => g.code === "all-bugs-out-of-scope",
      );
      return (gap?.evidence as { suggestedScope: string }).suggestedScope;
    };
    expect(await suggested("ado")).toBe('"101-102"');
    expect(await suggested("jira")).toBe('"TOOL-*"');
  });
});

describe("defect profile: which Jira project a run reads", () => {
  it("takes the project named on the command line, upper-cased", () => {
    expect(jiraProfileProject("tool", ["SHOP-*"])).toEqual({ project: "TOOL" });
  });

  it("takes the one Jira project the scope allows, as a pattern or as single keys", () => {
    expect(jiraProfileProject(undefined, ["TOOL-*"])).toEqual({ project: "TOOL" });
    expect(jiraProfileProject(undefined, ["TOOL-6", "TOOL-34", "100-199"])).toEqual({
      project: "TOOL",
    });
  });

  it("refuses to guess between two projects, or with none", () => {
    const two = jiraProfileProject(undefined, ["TOOL-*", "SHOP-*"]);
    expect("error" in two && two.error).toMatch(/allows 2 Jira projects \(TOOL, SHOP\)/);
    const none = jiraProfileProject(undefined, ["100-199"]);
    expect("error" in none && none.error).toMatch(/pass --project <KEY>/);
    const bad = jiraProfileProject("my project", ["TOOL-*"]);
    expect("error" in bad && bad.error).toMatch(/not a Jira project key/);
  });
});
