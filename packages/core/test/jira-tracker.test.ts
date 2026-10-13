import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJiraEnv, ConfigError } from "../src/config.js";
import { parseJiraKey, pickTracker } from "../src/cli.js";
import { asAdoBug, isBugCreate } from "../src/governance/bug-view.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import { bugTitle } from "../src/triage/settle.js";
import { storyToTestsSkill, trackerTools } from "../src/skills/story-to-tests.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";
import { renderApproval } from "../src/runtime/render-approval.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Jira switched on end to end (decision D17): the .env decides the connection,
 * the work item's shape decides the tracker, and every rule about bugs holds a
 * Jira Bug exactly as it holds an Azure DevOps one.
 */

describe("Jira from the environment", () => {
  const cloud = {
    JIRA_BASE_URL: "https://acme.atlassian.net/",
    JIRA_EMAIL: "qa@acme.test",
    JIRA_API_TOKEN: "t0ken",
  };

  it("is off when JIRA_BASE_URL is unset or empty", () => {
    expect(readJiraEnv({})).toBeUndefined();
    expect(readJiraEnv({ JIRA_BASE_URL: "" })).toBeUndefined();
  });

  it("reads Cloud as basic auth on REST v3, and Data Center as a bearer PAT on v2", () => {
    expect(readJiraEnv(cloud)).toEqual({
      baseUrl: "https://acme.atlassian.net",
      auth: { kind: "basic", email: "qa@acme.test", token: "t0ken" },
      apiVersion: 3,
    });
    expect(readJiraEnv({ JIRA_BASE_URL: "https://jira.acme.test", JIRA_PAT: "p" })).toEqual({
      baseUrl: "https://jira.acme.test",
      auth: { kind: "bearer", token: "p" },
      apiVersion: 2,
    });
    expect(
      readJiraEnv({ ...cloud, JIRA_API_VERSION: "2", JIRA_AC_FIELD: "customfield_10042" }),
    ).toMatchObject({ apiVersion: 2, acceptanceCriteriaField: "customfield_10042" });
  });

  it("refuses what would leak a token or cannot work", () => {
    const bad: Array<Record<string, string>> = [
      { ...cloud, JIRA_BASE_URL: "http://acme.atlassian.net" },
      { ...cloud, JIRA_BASE_URL: "not a url" },
      { JIRA_BASE_URL: "https://acme.atlassian.net" },
      { ...cloud, JIRA_PAT: "p" },
      { ...cloud, JIRA_API_VERSION: "4" },
      { ...cloud, JIRA_AC_FIELD: "Acceptance Criteria" },
    ];
    for (const env of bad) expect(() => readJiraEnv(env)).toThrow(ConfigError);
    // Plain http is fine for a local Jira.
    expect(readJiraEnv({ ...cloud, JIRA_BASE_URL: "http://localhost:8080" })?.baseUrl).toBe(
      "http://localhost:8080",
    );
  });

  it("finds an upper-case key in a request, and nothing in ordinary text", () => {
    expect(parseJiraKey("Write tests for SHOP-12 please")).toBe("SHOP-12");
    expect(parseJiraKey("tests for AB#44")).toBeUndefined();
    expect(parseJiraKey("encode as utf-8")).toBeUndefined();
  });
});

const JIRA_BUG = {
  toolName: "jira.create_bug",
  args: {
    projectKey: "SHOP",
    storyKey: "SHOP-12",
    summary: "AC-1: saved card is not offered at checkout",
    description: "Steps…\nEXPECTED card listed\nACTUAL empty list\nConfidence: low.",
  },
};

describe("one view of a proposed bug", () => {
  it("recognises a bug in either tracker and nothing else", () => {
    expect(isBugCreate(JIRA_BUG)).toBe(true);
    expect(
      isBugCreate({
        toolName: "ado.wit_work_item_write",
        args: { action: "create", workItemType: "Bug" },
      }),
    ).toBe(true);
    expect(isBugCreate({ toolName: "jira.get_issue", args: { key: "SHOP-12" } })).toBe(false);
    expect(
      isBugCreate({
        toolName: "ado.wit_work_item_write",
        args: { action: "create", workItemType: "Task" },
      }),
    ).toBe(false);
  });

  it("shows the Jira call to the bug rules in the shape they check, labelled as the adapter will", () => {
    const v = asAdoBug(JIRA_BUG);
    expect(v.toolName).toBe("ado.wit_work_item_write");
    expect(v.args).toMatchObject({
      action: "create",
      workItemType: "Bug",
      title: JIRA_BUG.args.summary,
      parentId: "SHOP-12",
      tags: "agentic-qa",
    });
    expect(bugTitle(JIRA_BUG)).toBe(JIRA_BUG.args.summary);
    // Anything that is not a Jira bug is passed through untouched.
    const other = { toolName: "fs.write_file", args: { path: "x" } };
    expect(asAdoBug(other)).toBe(other);
  });

  it("refuses a duplicate Jira bug exactly as it refuses a duplicate Azure DevOps bug", () => {
    const facts = {
      acceptanceCriteria: ["AC-1"],
      bugs: [],
      filedBugs: [
        {
          id: "SHOP-20",
          state: "In Progress",
          title: "AC-1: saved card is not offered at checkout",
          agent: true,
        },
      ],
      tasks: [],
      story: { id: "SHOP-12", title: "Pay with a saved card" },
      epic: { id: "SHOP-1", title: "Checkout" },
    };
    const events = [
      {
        tool: "attestqa",
        runId: "r",
        timestamp: 1,
        eventId: 1,
        kind: "call",
        payload: { server: "aqa", toolName: "story_context", args: {}, startedAt: 0 },
      },
      {
        tool: "attestqa",
        runId: "r",
        timestamp: 1,
        eventId: 2,
        kind: "observation",
        payload: {
          eventIdOfCall: 1,
          ok: true,
          result: { kind: "preflight", summary: {}, text: "", facts },
          artefacts: [],
          durationMs: 1,
        },
      },
    ] as unknown as AnyRunEvent[];
    expect(storyRefusal(JIRA_BUG, events)).toMatch(/^#SHOP-20 \[In Progress\] already says this/);
  });

  it("puts a Jira bug to the reviewer as a BUG, linked by its key", () => {
    const text = renderApproval([JIRA_BUG]);
    expect(text).toContain("BUG AC-1: saved card is not offered at checkout");
    expect(text).toContain("linked to story SHOP-12");
    expect(text).not.toContain("AB#SHOP");
    expect(text).not.toContain('missing the "agentic-qa" tag');
  });
});

describe("the story-to-tests skill against Jira", () => {
  const skill = storyToTestsSkill({ workItem: "SHOP-12", tracker: "jira" });

  it("shows the Jira tools and none of the Azure DevOps ones", () => {
    expect(skill.allowedTools).toEqual(
      expect.arrayContaining(["jira.get_issue", "jira.search", "jira.create_bug"]),
    );
    expect(skill.allowedTools.some((t) => t.startsWith("ado."))).toBe(false);
    expect(skill.sourceTools).toContain("jira.get_issue");
    expect(skill.sourceTools).not.toContain("jira.create_bug");
    expect(skill.sourceTools).not.toContain("jira.record_qa");
    // Azure DevOps keeps exactly the list it had.
    const ado = storyToTestsSkill({ workItem: "44" });
    expect(ado.allowedTools.some((t) => t.startsWith("jira."))).toBe(false);
    expect(trackerTools("ado", ["a", "ado.x"])).toEqual(["a", "ado.x"]);
    expect(trackerTools("jira", ["a", "ado.x", "ado.y", "b"])).toEqual([
      "a",
      "jira.get_issue",
      "jira.list_comments",
      "jira.search",
      "jira.create_bug",
      "jira.record_qa",
      "b",
    ]);
  });

  it("tells the agent how Jira differs, and nothing about Test Plans", () => {
    expect(skill.instructions).toContain("jira.create_bug");
    expect(skill.instructions).toContain("Jira keeps no test cases");
    expect(skill.instructions).toContain("@story:SHOP-12");
    expect(skill.instructions).not.toMatch(/ado\.testplan|wit_work_item_write|System\.Tags/);
    const ado = storyToTestsSkill({ workItem: "44" }).instructions;
    expect(ado).toContain("ado.testplan_test_case_write");
    expect(ado).not.toContain("jira.");
  });
});

describe("the verifier against Jira", () => {
  const ws = () => {
    const dir = mkdtempSync(join(tmpdir(), "aqa-jira-"));
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "checkout.spec.ts"),
      "// Generated by agentic-qa (bdd2pw) from features/checkout.feature.\n",
    );
    return dir;
  };
  function ledger(
    entries: Array<{
      tool: string;
      args?: Record<string, unknown>;
      result?: unknown;
      artefacts?: string[];
    }>,
  ): AnyRunEvent[] {
    const out: AnyRunEvent[] = [];
    let id = 0;
    const base = { tool: "attestqa" as const, runId: "r", timestamp: 1 };
    for (const e of entries) {
      const callId = ++id;
      out.push({
        ...base,
        eventId: callId,
        kind: "call",
        payload: {
          server: e.tool.split(".")[0] as string,
          toolName: e.tool.slice(e.tool.indexOf(".") + 1),
          args: e.args ?? {},
          startedAt: 0,
        },
      } as AnyRunEvent);
      out.push({
        ...base,
        eventId: ++id,
        kind: "observation",
        payload: {
          eventIdOfCall: callId,
          ok: true,
          result: e.result ?? {},
          artefacts: e.artefacts ?? [],
          durationMs: 1,
        },
      } as AnyRunEvent);
    }
    return out;
  }
  const GREEN = { passed: 2, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] };
  const verify = (events: AnyRunEvent[], dir: string) =>
    new StoryToTestsVerifier({ workItem: "SHOP-12", tracker: "jira" }).verify({
      events,
      workspaceDir: dir,
    });

  it("is done with the story read, a generated spec and a green suite — no test cases asked for", async () => {
    const dir = ws();
    const v = await verify(
      ledger([
        { tool: "jira.get_issue", args: { key: "shop-12" }, result: { key: "SHOP-12" } },
        { tool: "fs.write_file", args: { path: "features/checkout.feature" } },
        { tool: "bdd2pw.to_spec", args: {}, artefacts: ["tests/checkout.spec.ts"] },
        { tool: "pw.run_tests", args: {}, result: GREEN },
      ]),
      dir,
    );
    expect(v.gaps).toEqual([]);
    expect(v.done).toBe(true);
  });

  it("says the story was never read when the Jira read is missing", async () => {
    const dir = ws();
    const v = await verify(ledger([{ tool: "pw.run_tests", args: {}, result: GREEN }]), dir);
    expect(v.gaps.map((g) => g.code)).toContain("story-not-read");
    expect(v.gaps.map((g) => g.code)).not.toContain("no-test-cases");
  });

  it("gaps a Jira bug linked to the wrong story", async () => {
    const dir = ws();
    const v = await verify(
      ledger([
        { tool: "jira.get_issue", args: { key: "SHOP-12" }, result: { key: "SHOP-12" } },
        { tool: "bdd2pw.to_spec", args: {}, artefacts: ["tests/checkout.spec.ts"] },
        { tool: "pw.run_tests", args: {}, result: GREEN },
        {
          tool: "jira.create_bug",
          args: { ...JIRA_BUG.args, storyKey: "SHOP-99" },
          result: { key: "SHOP-30" },
        },
      ]),
      dir,
    );
    expect(v.gaps.map((g) => g.code)).toContain("bug-not-linked-to-story");
  });
});

describe("one tracker choice for the real run and the dry run", () => {
  const jira = readJiraEnv({
    JIRA_BASE_URL: "https://acme.atlassian.net",
    JIRA_EMAIL: "qa@acme.test",
    JIRA_API_TOKEN: "t",
  });
  const withJira = { anthropicApiKey: "", sandbox: false, ...(jira ? { jira } : {}) };
  const noJira = { anthropicApiKey: "", sandbox: false };

  it("reads a Jira key in the request as Jira only when Jira is configured", () => {
    expect(pickTracker([], "Write tests for SCRUM-8", withJira)).toMatchObject({ tracker: "jira" });
    expect(pickTracker([], "Write tests for SCRUM-8", noJira)).toMatchObject({ tracker: "ado" });
    expect(pickTracker([], "Write tests for AB#44", withJira)).toMatchObject({ tracker: "ado" });
  });

  it("follows --work-item and --tracker, and says what is missing", () => {
    expect(pickTracker(["--work-item", "scrum-8"], "x", withJira)).toMatchObject({
      tracker: "jira",
    });
    expect(pickTracker(["--work-item", "44"], "x", withJira)).toMatchObject({ tracker: "ado" });
    expect(pickTracker(["--tracker", "jira"], "x", noJira)).toMatchObject({
      error: expect.stringContaining("JIRA_BASE_URL"),
    });
    expect(pickTracker(["--tracker", "github"], "x", withJira)).toMatchObject({
      error: expect.stringContaining("--tracker must be one of"),
    });
  });
});
