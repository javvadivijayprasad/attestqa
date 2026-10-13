import { describe, it, expect } from "vitest";
import { JiraTools, toAdfBlocks, toWiki, type JiraConnection } from "../src/mcp/adapters/jira.js";
import type { FetchLike } from "../src/mcp/adapters/tcg.js";
import { composeQaRecord, QA_LABEL, QA_SUMMARY_PREFIX } from "../src/report/qa-record.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * ADR-004: one QA sub-task per Jira story — test cases in its description,
 * each run's results as a comment. Created once, found again by label, its
 * description rewritten only when the approved design changes.
 */

type Call = { url: string; method: string; body?: string };

function fake(
  routes: Array<[method: string, path: string, body: unknown]>,
  calls: Call[] = [],
): FetchLike {
  return async (url, init) => {
    calls.push({
      url,
      method: init.method,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const hit = routes.find(([m, p]) => m === init.method && url.includes(p));
    const body = hit ? hit[2] : { errorMessages: ["not found"] };
    return {
      ok: !!hit,
      status: hit ? 200 : 404,
      text: async () => JSON.stringify(body),
    };
  };
}

const CLOUD: JiraConnection = {
  baseUrl: "https://acme.atlassian.net",
  auth: { kind: "basic", email: "qa@acme.test", token: "tok" },
};

const args = (hash = "abc123") => ({
  storyKey: "QA-12",
  projectKey: "QA",
  summary: `${QA_SUMMARY_PREFIX} QA-12 — Sign in`,
  designHash: hash,
  description: [
    { kind: "paragraph", text: "Test cases" },
    { kind: "table", header: ["ID", "Expected"], rows: [["D1", "signed in"]] },
    { kind: "paragraph", text: `attestqa design ${hash}` },
  ],
  comment: [{ kind: "heading", text: "Run r1 — done" }],
});

const existing = (hash: string) => ({
  issues: [
    {
      key: "QA-99",
      fields: {
        labels: [QA_LABEL, "agentic-qa"],
        parent: { key: "QA-12" },
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: `attestqa design ${hash}` }] },
          ],
        },
      },
    },
  ],
});

describe("jira.record_qa", () => {
  it("creates the sub-task under the story, labelled, then comments the results", async () => {
    const calls: Call[] = [];
    const jira = new JiraTools(CLOUD, {
      fetch: fake(
        [
          ["GET", "/search/jql", { issues: [] }],
          [
            "GET",
            "/createmeta/QA/issuetypes",
            {
              issueTypes: [
                { id: "10001", name: "Bug" },
                { id: "10003", name: "Subtask", subtask: true },
              ],
            },
          ],
          ["POST", "/comment", { id: "500" }],
          ["POST", "/issue", { key: "QA-99" }],
        ],
        calls,
      ),
    });
    const r = await jira.call("jira", "record_qa", args());
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ qaKey: "QA-99", created: true, descriptionUpdated: false });
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/issue"));
    const fields = JSON.parse(create?.body ?? "{}").fields;
    expect(fields.parent).toEqual({ key: "QA-12" });
    expect(fields.issuetype).toEqual({ id: "10003" });
    expect(fields.labels).toContain(QA_LABEL);
    expect(fields.description.content.some((n: { type: string }) => n.type === "table")).toBe(true);
    expect(calls.some((c) => c.url.includes("/issue/QA-99/comment"))).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reuses the sub-task and leaves its description alone when the design is unchanged", async () => {
    const calls: Call[] = [];
    const jira = new JiraTools(CLOUD, {
      fetch: fake(
        [
          ["GET", "/search/jql", existing("abc123")],
          ["POST", "/comment", { id: "501" }],
        ],
        calls,
      ),
    });
    const r = await jira.call("jira", "record_qa", args("abc123"));
    expect(r.result).toMatchObject({ qaKey: "QA-99", created: false, descriptionUpdated: false });
    expect(
      calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.split("/api/3")[1]}`),
    ).toEqual(["POST /issue/QA-99/comment"]);
  });

  it("rewrites only the description, of only its own sub-task, when the design changed", async () => {
    const calls: Call[] = [];
    const jira = new JiraTools(CLOUD, {
      fetch: fake(
        [
          ["GET", "/search/jql", existing("old111")],
          ["PUT", "/issue/QA-99", {}],
          ["POST", "/comment", { id: "502" }],
        ],
        calls,
      ),
    });
    const r = await jira.call("jira", "record_qa", args("new222"));
    expect(r.result).toMatchObject({ descriptionUpdated: true });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toMatch(/\/issue\/QA-99$/);
    expect(Object.keys(JSON.parse(put?.body ?? "{}").fields)).toEqual(["description"]);
  });

  it("in cases mode posts the test cases and no comment", async () => {
    const calls: Call[] = [];
    const jira = new JiraTools(CLOUD, {
      fetch: fake(
        [
          ["GET", "/search/jql", { issues: [] }],
          ["GET", "/createmeta/QA/issuetypes", { issueTypes: [{ id: "10003", subtask: true }] }],
          ["POST", "/issue", { key: "QA-99" }],
        ],
        calls,
      ),
    });
    const noComment: Record<string, unknown> = { ...args(), mode: "cases" };
    delete noComment["comment"];
    const r = await jira.call("jira", "record_qa", noComment);
    expect(r.result).toMatchObject({ qaKey: "QA-99", created: true, mode: "cases" });
    expect(calls.some((c) => c.url.includes("/comment"))).toBe(false);
  });

  it("refuses anything that is not a QA sub-task summary", async () => {
    const jira = new JiraTools(CLOUD, { fetch: fake([]) });
    const r = await jira.call("jira", "record_qa", { ...args(), summary: "Rename the story" });
    expect(r.ok).toBe(false);
  });

  it("renders the same document as wiki markup for Data Center", () => {
    expect(toWiki([{ kind: "table", header: ["ID", "Result"], rows: [["D1", "Passed"]] }])).toBe(
      "||ID||Result||\n|D1|Passed|",
    );
    expect(JSON.stringify(toAdfBlocks([{ kind: "heading", text: "Run" }]))).toContain('"heading"');
  });

  it("is the runtime's to post: an agent proposal is refused", () => {
    expect(storyRefusal({ toolName: "jira.record_qa", args: args() }, [])).toMatch(
      /kept by the runtime/,
    );
  });
});

describe("composeQaRecord", () => {
  let id = 0;
  const call = (toolName: string, a: Record<string, unknown>, result: unknown): AnyRunEvent[] => {
    const callId = ++id;
    const [server, name] = toolName.split(".");
    return [
      { eventId: callId, kind: "call", payload: { server, toolName: name, args: a, startedAt: 0 } },
      {
        eventId: ++id,
        kind: "observation",
        payload: { eventIdOfCall: callId, ok: true, result, artefacts: [], durationMs: 1 },
      },
    ] as unknown as AnyRunEvent[];
  };
  const item = (i: string, covers: string) => ({
    id: i,
    covers,
    type: "functional",
    technique: "state-transition",
    conditions: ["valid account"],
    expected: "signed in",
    source: covers,
  });
  const events = [
    ...call(
      "aqa.story_context",
      {},
      {
        facts: {
          story: { id: "QA-12", title: "Sign in" },
          acceptanceCriteria: ["AC-1: signs in"],
          bugs: [],
          tasks: [],
        },
      },
    ),
    ...call("aqa.test_design", { items: [item("D1", "AC-1")], excluded: [] }, { recorded: true }),
    ...call(
      "pw.run_tests",
      {},
      { passed: 1, failed: 0, green: true, tests: [{ title: "AC-1: signs in", status: "passed" }] },
    ),
  ];
  const files = {
    features: [
      {
        path: "f.feature",
        text: "@story:QA-12 @ac:1 @design:D1\nScenario: AC-1: signs in\n  Given x",
      },
    ],
    specs: [
      {
        path: "t.spec.ts",
        text: '// @story:QA-12\n// @design:D1\ntest("AC-1: signs in", async () => {});',
      },
    ],
  };

  it("puts the test cases in the description and this run's results in the comment", () => {
    const r = composeQaRecord(events, { runId: "r1", storyKey: "QA-12", files, status: "done" })!;
    expect(r.summary).toBe(`${QA_SUMMARY_PREFIX} QA-12 — Sign in`);
    const table = r.description.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows[0]?.[0]).toBe("D1");
    expect(JSON.stringify(r.comment)).toContain("Passed");
    // Each case in BDD form: its Gherkin scenario, as the feature file has it.
    const gherkin = r.description.find((b) => b.kind === "code");
    expect(gherkin && gherkin.kind === "code" && gherkin.text).toBe(
      "Scenario: AC-1: signs in\n  Given x",
    );
    expect(JSON.stringify(r.comment)).toContain("Run r1 — done");
  });

  it("keeps the same design hash for the same approved design", () => {
    const a = composeQaRecord(events, { runId: "r1", storyKey: "QA-12", files })!;
    const b = composeQaRecord(events, { runId: "r2", storyKey: "QA-12", files })!;
    expect(a.designHash).toBe(b.designHash);
  });
});
