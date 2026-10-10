import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import type { FetchLike } from "./tcg.js";
import { AGENT_TAG } from "../../verify/story-to-tests.js";

/**
 * In-process `jira` adapter: requirements from Jira, read-only, plus the one
 * write this runtime is allowed — a Bug, after a person approves it.
 *
 * ── Why in-process and not an MCP server ──
 * Azure DevOps is reached through Microsoft's own MCP server. Jira has two
 * worlds (Cloud with API tokens or OAuth, Data Center with personal access
 * tokens) and no single server that covers both without a second runtime to
 * install. A small adapter over the REST API covers both, needs nothing but
 * `fetch`, and still goes through the same gate and ledger as every other tool.
 *
 * ── What it can and cannot do ──
 * It can read an issue, its comments and links, and run a JQL search. It can
 * create an issue of type Bug and link it to the story. It cannot edit, assign,
 * transition, comment on or delete anything: those tools do not exist, so no
 * instruction or prompt can reach them (capability removal, AQ-01 §9).
 */

export interface JiraConnection {
  /** e.g. https://acme.atlassian.net or https://jira.acme.internal */
  baseUrl: string;
  /** Cloud: email + API token (basic). Data Center: personal access token (bearer). */
  auth: { kind: "basic"; email: string; token: string } | { kind: "bearer"; token: string };
  /** REST API version: 3 for Cloud (default), 2 for Data Center. */
  apiVersion?: 2 | 3;
  /** Custom field holding acceptance criteria, e.g. customfield_10042. */
  acceptanceCriteriaField?: string;
}

export interface JiraOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export class JiraTools implements ToolClient {
  readonly server = "jira";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly api: string;

  constructor(
    private readonly conn: JiraConnection,
    opts: JiraOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.api = `${conn.baseUrl.replace(/\/+$/, "")}/rest/api/${conn.apiVersion ?? 3}`;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const key = { type: "string", description: "Issue key, e.g. QA-12" };
    return [
      {
        server: this.server,
        name: "get_issue",
        description:
          "Read one Jira issue: summary, type, status, description, acceptance criteria, labels, links and sub-tasks.",
        inputSchema: { type: "object", properties: { key }, required: ["key"] },
        policyClass: "read",
        scopeArgs: { workItem: "key" },
      },
      {
        server: this.server,
        name: "list_comments",
        description: "Read the comments on a Jira issue, oldest first.",
        inputSchema: { type: "object", properties: { key }, required: ["key"] },
        policyClass: "read",
        scopeArgs: { workItem: "key" },
      },
      {
        server: this.server,
        name: "search",
        description:
          "Run a JQL query and return matching issues (key, type, status, summary, labels). Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            jql: { type: "string" },
            maxResults: { type: "integer", description: "At most 100; default 50" },
          },
          required: ["jql"],
        },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "create_bug",
        description:
          "Create a Bug in Jira and link it to the story it was found under. Needs a person's approval. Only Bugs can be created.",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: { type: "string" },
            summary: { type: "string" },
            description: { type: "string" },
            storyKey: key,
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["projectKey", "summary", "description", "storyKey"],
        },
        policyClass: "write_record",
        scopeArgs: { workItem: "storyKey" },
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`unknown server ${server}`);
    try {
      switch (name) {
        case "get_issue":
          return await this.getIssue(args);
        case "list_comments":
          return await this.listComments(args);
        case "search":
          return await this.search(args);
        case "create_bug":
          return await this.createBug(args);
        default:
          return fail(
            `unknown jira tool: ${name}. This adapter can read issues, comments and searches, and create Bugs; nothing else.`,
          );
      }
    } catch (e) {
      const err = e as Error;
      return fail(
        err.name === "AbortError" ? `Jira did not answer within ${this.timeoutMs} ms` : err.message,
      );
    }
  }

  // ---------------------------------------------------------------------------

  private async getIssue(args: Record<string, unknown>): Promise<ToolResult> {
    const key = issueKey(args["key"]);
    if (!key) return fail(`"key" must be an issue key like QA-12`);
    const acField = this.conn.acceptanceCriteriaField;
    const fields = [
      "summary",
      "issuetype",
      "status",
      "description",
      "labels",
      "issuelinks",
      "subtasks",
      "parent",
    ];
    if (acField) fields.push(acField);
    const res = await this.request(
      "GET",
      `/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`,
    );
    if (!res.ok) return res;
    const f = (res.body as { fields?: Record<string, unknown> }).fields ?? {};
    const description = toText(f["description"]);
    const fromField = acField ? toText(f[acField]) : "";
    return ok({
      key,
      summary: str(f["summary"]),
      type: str((f["issuetype"] as { name?: string } | undefined)?.name),
      status: str((f["status"] as { name?: string } | undefined)?.name),
      description,
      acceptanceCriteria: fromField || acceptanceSection(description),
      acceptanceCriteriaSource: fromField
        ? acField
        : acceptanceSection(description)
          ? "description"
          : "none",
      labels: Array.isArray(f["labels"]) ? (f["labels"] as unknown[]).map(String) : [],
      parent: str((f["parent"] as { key?: string } | undefined)?.key),
      links: links(f["issuelinks"]),
      subtasks: (Array.isArray(f["subtasks"])
        ? (f["subtasks"] as Array<Record<string, unknown>>)
        : []
      ).map((t) => ({
        key: str(t["key"]),
        summary: str((t["fields"] as Record<string, unknown> | undefined)?.["summary"]),
        status: str(
          ((t["fields"] as Record<string, unknown> | undefined)?.["status"] as { name?: string })
            ?.name,
        ),
      })),
    });
  }

  private async listComments(args: Record<string, unknown>): Promise<ToolResult> {
    const key = issueKey(args["key"]);
    if (!key) return fail(`"key" must be an issue key like QA-12`);
    const res = await this.request(
      "GET",
      `/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`,
    );
    if (!res.ok) return res;
    const comments = (
      (res.body as { comments?: Array<Record<string, unknown>> }).comments ?? []
    ).map((c) => ({
      id: str(c["id"]),
      author: str((c["author"] as { displayName?: string } | undefined)?.displayName),
      created: str(c["created"]),
      text: toText(c["body"]),
    }));
    return ok({ key, comments, count: comments.length });
  }

  private async search(args: Record<string, unknown>): Promise<ToolResult> {
    const jql = typeof args["jql"] === "string" ? args["jql"].trim() : "";
    if (!jql) return fail(`"jql" is required`);
    const max = Math.min(Math.max(Number(args["maxResults"] ?? 50) || 50, 1), 100);
    const fields = ["summary", "issuetype", "status", "labels"];
    // Cloud retired the old search endpoint for /search/jql; Data Center keeps /search.
    const res =
      (this.conn.apiVersion ?? 3) === 3
        ? await this.request("POST", `/search/jql`, { jql, maxResults: max, fields })
        : await this.request("POST", `/search`, { jql, maxResults: max, fields });
    if (!res.ok) return res;
    const issues = ((res.body as { issues?: Array<Record<string, unknown>> }).issues ?? []).map(
      (i) => {
        const f = (i["fields"] as Record<string, unknown> | undefined) ?? {};
        return {
          key: str(i["key"]),
          type: str((f["issuetype"] as { name?: string } | undefined)?.name),
          status: str((f["status"] as { name?: string } | undefined)?.name),
          summary: str(f["summary"]),
          labels: Array.isArray(f["labels"]) ? (f["labels"] as unknown[]).map(String) : [],
        };
      },
    );
    return ok({ jql, issues, count: issues.length });
  }

  private async createBug(args: Record<string, unknown>): Promise<ToolResult> {
    const storyKey = issueKey(args["storyKey"]);
    const projectKey = typeof args["projectKey"] === "string" ? args["projectKey"] : "";
    const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
    const description = typeof args["description"] === "string" ? args["description"] : "";
    if (!storyKey)
      return fail(`"storyKey" must be the issue key of the story this bug was found under`);
    if (!/^[A-Z][A-Z0-9_]+$/.test(projectKey))
      return fail(`"projectKey" must be a Jira project key like QA`);
    if (!summary) return fail(`"summary" is required`);
    const labels = [
      ...new Set([
        AGENT_TAG,
        ...(Array.isArray(args["labels"]) ? (args["labels"] as unknown[]).map(String) : []),
      ]),
    ].map((l) => l.replace(/\s+/g, "-"));
    const v3 = (this.conn.apiVersion ?? 3) === 3;
    const created = await this.request("POST", `/issue`, {
      fields: {
        project: { key: projectKey },
        issuetype: { name: "Bug" },
        summary,
        description: v3 ? toAdf(description) : description,
        labels,
      },
    });
    if (!created.ok) return created;
    const bugKey = str((created.body as { key?: string }).key);
    const linked = await this.request("POST", `/issueLink`, {
      type: { name: "Relates" },
      inwardIssue: { key: bugKey },
      outwardIssue: { key: storyKey },
    });
    return ok({
      key: bugKey,
      storyKey,
      labels,
      linked: linked.ok,
      ...(linked.ok
        ? {}
        : { linkError: (linked.result as { message?: string }).message ?? "link failed" }),
    });
  }

  // ---------------------------------------------------------------------------

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ToolResult & { body?: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...authHeader(this.conn.auth),
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchImpl(`${this.api}${path}`, {
        method,
        headers,
        body: body === undefined ? "" : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? " — check JIRA_EMAIL/JIRA_API_TOKEN (Cloud) or JIRA_PAT (Data Center), and that the account can see this project"
            : "";
        return {
          ...fail(`Jira returned ${res.status}${hint}: ${errorText(text)}`),
          body: undefined,
        };
      }
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          return fail(`Jira returned non-JSON: ${text.slice(0, 200)}`);
        }
      }
      return { ok: true, result: parsed, artefacts: [], body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }
}

// -----------------------------------------------------------------------------

function authHeader(a: JiraConnection["auth"]): Record<string, string> {
  return a.kind === "basic"
    ? { authorization: `Basic ${Buffer.from(`${a.email}:${a.token}`).toString("base64")}` }
    : { authorization: `Bearer ${a.token}` };
}

function issueKey(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return KEY.test(s) ? s : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function ok(result: unknown): ToolResult {
  return { ok: true, result, artefacts: [] };
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}

function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [
      ...(j.errorMessages ?? []),
      ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
    ];
    if (parts.length) return parts.join("; ");
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

/**
 * Plain text from a Jira field: a string (API v2) or an Atlassian Document
 * Format tree (API v3). Paragraphs, headings and list items each end a line, so
 * "AC-1: …" at the start of a list item stays at the start of a line — which is
 * what the acceptance-criteria parser looks for.
 */
export function toText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (!v || typeof v !== "object") return "";
  const lines: string[] = [];
  let line = "";
  const BLOCK = new Set([
    "paragraph",
    "heading",
    "listItem",
    "codeBlock",
    "blockquote",
    "tableRow",
  ]);
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; text?: string; content?: unknown[] };
    if (node.type === "text" && typeof node.text === "string") line += node.text;
    else if (node.type === "hardBreak") {
      lines.push(line);
      line = "";
    }
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
    if (node.type && BLOCK.has(node.type) && line.trim() !== "") {
      lines.push(line);
      line = "";
    }
  };
  walk(v);
  if (line.trim()) lines.push(line);
  return lines
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/** A minimal ADF document from plain text, one paragraph per line. */
export function toAdf(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\r?\n/)
      .map((l) =>
        l ? { type: "paragraph", content: [{ type: "text", text: l }] } : { type: "paragraph" },
      ),
  };
}

/**
 * Jira has no standard acceptance-criteria field. When no custom field is
 * configured, the criteria are read from a section of the description headed
 * "Acceptance criteria" (any case, with or without a colon), up to the next
 * heading-like line.
 */
export function acceptanceSection(description: string): string {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => /^\s*#*\s*acceptance\s+criteria\s*:?\s*$/i.test(l));
  if (start < 0) return "";
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#+\s/.test(l) || /^\s*[A-Z][A-Za-z ]{2,40}:\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

function links(v: unknown): Array<{
  type: string;
  direction: "inward" | "outward";
  key: string;
  summary: string;
  status: string;
  issueType: string;
}> {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const l of v as Array<Record<string, unknown>>) {
    const t = l["type"] as { inward?: string; outward?: string } | undefined;
    for (const dir of ["inwardIssue", "outwardIssue"] as const) {
      const i = l[dir] as Record<string, unknown> | undefined;
      if (!i) continue;
      const f = (i["fields"] as Record<string, unknown> | undefined) ?? {};
      out.push({
        type: str(dir === "inwardIssue" ? t?.inward : t?.outward),
        direction: dir === "inwardIssue" ? ("inward" as const) : ("outward" as const),
        key: str(i["key"]),
        summary: str(f["summary"]),
        status: str((f["status"] as { name?: string } | undefined)?.name),
        issueType: str((f["issuetype"] as { name?: string } | undefined)?.name),
      });
    }
  }
  return out;
}
