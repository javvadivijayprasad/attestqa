import { describe, it, expect } from "vitest";
import {
  JiraTools,
  acceptanceSection,
  toAdf,
  toText,
  type JiraConnection,
} from "../src/mcp/adapters/jira.js";
import type { FetchLike } from "../src/mcp/adapters/tcg.js";
import { ScopedGate } from "../src/governance/policy.js";
import { DEFAULT_POLICY } from "../src/types.js";

/**
 * Jira as a requirements source (AQ-04 §2.7, decision D17).
 *
 * Read the story, its comments and links; search with JQL; create a Bug after
 * approval. Nothing else exists — no edit, no transition, no comment — so no
 * prompt can reach those actions.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fake(
  routes: Record<string, { status?: number; body: unknown }>,
  calls: Call[] = [],
): FetchLike {
  return async (url, init) => {
    // Behave like Node's fetch: a GET or HEAD with any body, even "", throws.
    // The first fake accepted one, and the first real run left its story unread.
    if ((init.method === "GET" || init.method === "HEAD") && init.body !== undefined)
      throw new TypeError("Request with GET/HEAD method cannot have body.");
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const r = hit?.[1] ?? { status: 404, body: { errorMessages: ["not found"] } };
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
}

const CLOUD: JiraConnection = {
  baseUrl: "https://acme.atlassian.net/",
  auth: { kind: "basic", email: "qa@acme.test", token: "tok" },
};

const adf = (...paras: string[]) => ({
  type: "doc",
  version: 1,
  content: paras.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
});

const ISSUE = {
  key: "QA-12",
  fields: {
    summary: "Log out",
    issuetype: { name: "Story" },
    status: { name: "In Progress" },
    description: adf(
      "As a shopper I can log out.",
      "Acceptance criteria",
      "AC-1: Logout is in the account menu",
      "AC-2: Logout lands on the login page",
      "Notes:",
      "later",
    ),
    labels: ["checkout"],
    issuelinks: [
      {
        type: { inward: "is blocked by", outward: "blocks" },
        inwardIssue: {
          key: "QA-9",
          fields: { summary: "Session bug", status: { name: "Open" }, issuetype: { name: "Bug" } },
        },
      },
    ],
    subtasks: [{ key: "QA-13", fields: { summary: "Write tests", status: { name: "To Do" } } }],
  },
};

describe("reading", () => {
  it("reads an issue with basic auth on Cloud (API v3) and turns ADF into lines", async () => {
    const calls: Call[] = [];
    const t = new JiraTools(CLOUD, { fetch: fake({ "/issue/QA-12?": { body: ISSUE } }, calls) });
    const r = await t.call("jira", "get_issue", { key: "qa-12" });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toMatch(
      /^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/QA-12\?fields=/,
    );
    expect(calls[0]!.headers["authorization"]).toBe(
      `Basic ${Buffer.from("qa@acme.test:tok").toString("base64")}`,
    );
    const res = r.result as Record<string, unknown>;
    expect(res["type"]).toBe("Story");
    expect(res["acceptanceCriteria"]).toBe(
      "AC-1: Logout is in the account menu\nAC-2: Logout lands on the login page",
    );
    expect(res["acceptanceCriteriaSource"]).toBe("description");
    expect(res["links"]).toEqual([
      {
        type: "is blocked by",
        direction: "inward",
        key: "QA-9",
        summary: "Session bug",
        status: "Open",
        issueType: "Bug",
      },
    ]);
    expect(res["subtasks"]).toEqual([{ key: "QA-13", summary: "Write tests", status: "To Do" }]);
  });

  it("prefers a configured acceptance-criteria field", async () => {
    const issue = {
      key: "QA-12",
      fields: { ...ISSUE.fields, customfield_10042: adf("AC-1: from the field") },
    };
    const t = new JiraTools(
      { ...CLOUD, acceptanceCriteriaField: "customfield_10042" },
      { fetch: fake({ "/issue/QA-12?": { body: issue } }) },
    );
    const res = (await t.call("jira", "get_issue", { key: "QA-12" })).result as Record<
      string,
      unknown
    >;
    expect(res["acceptanceCriteria"]).toBe("AC-1: from the field");
    expect(res["acceptanceCriteriaSource"]).toBe("customfield_10042");
  });

  it("uses a bearer token and API v2 on Data Center, where text fields are plain strings", async () => {
    const calls: Call[] = [];
    const t = new JiraTools(
      {
        baseUrl: "https://jira.acme.internal",
        auth: { kind: "bearer", token: "pat" },
        apiVersion: 2,
      },
      {
        fetch: fake(
          {
            "/comment": {
              body: {
                comments: [
                  {
                    id: "1",
                    author: { displayName: "PO" },
                    created: "2026-10-02",
                    body: "AC-3 stands.",
                  },
                ],
              },
            },
          },
          calls,
        ),
      },
    );
    const r = await t.call("jira", "list_comments", { key: "QA-12" });
    expect(calls[0]!.url).toContain("/rest/api/2/issue/QA-12/comment");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer pat");
    expect((r.result as { comments: unknown[] }).comments).toEqual([
      { id: "1", author: "PO", created: "2026-10-02", text: "AC-3 stands." },
    ]);
  });

  it("searches with the Cloud /search/jql endpoint", async () => {
    const calls: Call[] = [];
    const t = new JiraTools(CLOUD, {
      fetch: fake(
        {
          "/search/jql": {
            body: {
              issues: [
                {
                  key: "QA-12",
                  fields: {
                    summary: "Log out",
                    issuetype: { name: "Story" },
                    status: { name: "Done" },
                    labels: [],
                  },
                },
              ],
            },
          },
        },
        calls,
      ),
    });
    const r = await t.call("jira", "search", { jql: "sprint in openSprints()", maxResults: 500 });
    expect(r.ok).toBe(true);
    expect(JSON.parse(calls[0]!.body ?? "null")).toMatchObject({
      jql: "sprint in openSprints()",
      maxResults: 100,
    });
    expect((r.result as { count: number }).count).toBe(1);
  });

  it("explains a 401 in terms of the variables to check", async () => {
    const t = new JiraTools(CLOUD, {
      fetch: fake({ "/issue/": { status: 401, body: { errorMessages: ["Unauthorized"] } } }),
    });
    const r = await t.call("jira", "get_issue", { key: "QA-12" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.result)).toContain("JIRA_API_TOKEN");
  });

  it("refuses a malformed key before calling Jira", async () => {
    const calls: Call[] = [];
    const t = new JiraTools(CLOUD, { fetch: fake({}, calls) });
    expect((await t.call("jira", "get_issue", { key: "12; DROP" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("the one write: a Bug, linked to its story", () => {
  it("creates an issue of type Bug only, tags it, and links it to the story", async () => {
    const calls: Call[] = [];
    const t = new JiraTools(CLOUD, {
      fetch: fake(
        {
          "/issueLink": { status: 201, body: "" },
          "/issue": { status: 201, body: { key: "QA-20" } },
        },
        calls,
      ),
    });
    const r = await t.call("jira", "create_bug", {
      projectKey: "QA",
      summary: "Logout lands on home, not login",
      description: "Steps: …\nRun 20261007T203629Z-20f31b80",
      storyKey: "QA-12",
      issuetype: "Story",
    });
    expect(r.ok).toBe(true);
    const created = JSON.parse(calls[0]!.body ?? "null");
    expect(created.fields.issuetype).toEqual({ name: "Bug" });
    expect(created.fields.labels).toContain("agentic-qa");
    expect(created.fields.description.type).toBe("doc");
    expect(JSON.parse(calls[1]!.body ?? "null")).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "QA-20" },
      outwardIssue: { key: "QA-12" },
    });
    expect(r.result).toMatchObject({ key: "QA-20", storyKey: "QA-12", linked: true });
  });

  it("offers no tool that edits, transitions, comments on or deletes anything", async () => {
    const names = (await new JiraTools(CLOUD).listTools()).map((d) => d.name).sort();
    expect(names).toEqual(["create_bug", "get_issue", "list_comments", "search"]);
    const r = await new JiraTools(CLOUD, { fetch: fake({}) }).call("jira", "edit_issue", {
      key: "QA-12",
    });
    expect(r.ok).toBe(false);
  });

  it("is governed like Azure DevOps: reads in scope execute, the Bug asks, out of scope is refused", async () => {
    const tools = await new JiraTools(CLOUD).listTools();
    const tool = (n: string) => tools.find((t) => t.name === n);
    const gate = new ScopedGate(DEFAULT_POLICY, {
      work_items: ["QA-12"],
      repos: [],
      test_plans: [],
      branches_writable: [],
      urls: [],
    });
    expect(
      gate.judge({ toolName: "jira.get_issue", args: { key: "QA-12" } }, tool("get_issue"))
        .decision,
    ).toBe("execute");
    expect(
      gate.judge({ toolName: "jira.get_issue", args: { key: "QA-99" } }, tool("get_issue"))
        .decision,
    ).toBe("refuse");
    expect(
      gate.judge(
        {
          toolName: "jira.create_bug",
          args: { projectKey: "QA", summary: "s", description: "d", storyKey: "QA-12" },
        },
        tool("create_bug"),
      ).decision,
    ).toBe("ask");
  });
});

describe("text helpers", () => {
  it("round-trips plain text through ADF", () => {
    expect(toText(toAdf("line one\nline two"))).toBe("line one\nline two");
  });
  it("finds the acceptance criteria section and stops at the next heading", () => {
    expect(acceptanceSection("Intro\n## Acceptance Criteria\nAC-1: a\nAC-2: b\n## Notes\nx")).toBe(
      "AC-1: a\nAC-2: b",
    );
    expect(acceptanceSection("no section here")).toBe("");
  });
});
