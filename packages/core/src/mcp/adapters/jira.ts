import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import type { FetchLike } from "./tcg.js";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { AGENT_TAG } from "../../verify/story-to-tests.js";
import { QA_LABEL, QA_SUMMARY_PREFIX, type QaBlock } from "../../report/qa-record.js";

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
 * create an issue of type Bug and link it to the story. It can keep ONE QA
 * sub-task per story (ADR-004): create it, rewrite that sub-task's description
 * when the approved design changes, and add a comment with each run's results —
 * the runtime posts it, never the model. It cannot edit any other field or any
 * other issue, assign, transition or delete anything: those tools do not exist,
 * so no instruction or prompt can reach them (capability removal, AQ-01 §9).
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
  /**
   * The test project. A bug may carry evidence files (`attachments`), added by
   * the runtime from the failing test's own report; each must resolve inside
   * this folder and be a screenshot, video or trace, or it is not sent.
   */
  evidenceRoot?: string;
}

/** What may be attached to a bug: Playwright's evidence, nothing else. */
const EVIDENCE_EXT = /\.(png|jpe?g|webm|zip)$/i;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 5;

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export class JiraTools implements ToolClient {
  readonly server = "jira";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly api: string;

  constructor(private readonly conn: JiraConnection, opts: JiraOptions = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.api = `${conn.baseUrl.replace(/\/+$/, "")}/rest/api/${conn.apiVersion ?? 3}`;
    this.evidenceRoot = opts.evidenceRoot;
  }

  private readonly evidenceRoot: string | undefined;

  /** The issue's page in Jira, for people (the REST URL is for programs). */
  browseUrl(key: string): string {
    return `${this.conn.baseUrl.replace(/\/+$/, "")}/browse/${key}`;
  }

  /**
   * Attach evidence files to an issue. Only files inside the test project with
   * an evidence extension and a sane size; anything else is reported as
   * skipped, never sent.
   */
  private async attach(
    key: string,
    paths: string[],
  ): Promise<{ attached: string[]; skipped: Array<{ path: string; why: string }> }> {
    const attached: string[] = [];
    const skipped: Array<{ path: string; why: string }> = [];
    const root = this.evidenceRoot ? realpathSafe(this.evidenceRoot) : undefined;
    for (const raw of paths.slice(0, MAX_EVIDENCE_FILES)) {
      // Outside the project is refused before existence is checked, so the
      // answer is the same on every OS and says nothing about other files.
      // Compared with the root as given and as resolved, so a symlinked or
      // short-named workspace path does not make its own files look outside.
      if (root && this.evidenceRoot) {
        const outside = (base: string) => {
          const r = relative(base, resolve(base, raw));
          return r.startsWith("..") || isAbsolute(r);
        };
        if (outside(root) && outside(resolve(this.evidenceRoot))) {
          skipped.push({ path: raw, why: "outside the test project" });
          continue;
        }
      }
      const full = root ? realpathSafe(isAbsolute(raw) ? raw : join(root, raw)) : undefined;
      if (!root || !full) {
        skipped.push({ path: raw, why: root ? "not found" : "no test project to attach from" });
        continue;
      }
      const rel = relative(root, full);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        skipped.push({ path: raw, why: "outside the test project" });
        continue;
      }
      if (!EVIDENCE_EXT.test(full)) {
        skipped.push({ path: raw, why: "not a screenshot, video or trace" });
        continue;
      }
      const size = statSync(full).size;
      if (size > MAX_EVIDENCE_BYTES) {
        skipped.push({ path: raw, why: `larger than ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB` });
        continue;
      }
      const form = new FormData();
      form.append("file", new Blob([readFileSync(full)]), basename(full));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        // The shared fetch type carries text bodies; an upload is multipart.
        const upload = this.fetchImpl as unknown as (
          url: string,
          init: {
            method: string;
            headers: Record<string, string>;
            body: FormData;
            signal: AbortSignal;
          },
        ) => Promise<{ ok: boolean; status: number }>;
        const res = await upload(`${this.api}/issue/${encodeURIComponent(key)}/attachments`, {
          method: "POST",
          // Jira refuses an attachment upload without this header (XSRF check).
          headers: {
            accept: "application/json",
            "X-Atlassian-Token": "no-check",
            ...authHeader(this.conn.auth),
          },
          body: form,
          signal: controller.signal,
        });
        if (res.ok) attached.push(basename(full));
        else skipped.push({ path: raw, why: `Jira returned ${res.status}` });
      } catch (e) {
        skipped.push({ path: raw, why: (e as Error).message });
      } finally {
        clearTimeout(timer);
      }
    }
    for (const raw of paths.slice(MAX_EVIDENCE_FILES))
      skipped.push({ path: raw, why: `only ${MAX_EVIDENCE_FILES} files are attached` });
    return { attached, skipped };
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
      {
        server: this.server,
        name: "record_qa",
        description:
          "Posted by the runtime at the end of a run, never by the agent: keep the story's one QA " +
          "sub-task — test cases in its description, this run's results as a comment.",
        inputSchema: {
          type: "object",
          properties: {
            storyKey: key,
            projectKey: { type: "string" },
            summary: { type: "string" },
            designHash: { type: "string" },
            description: { type: "array" },
            comment: { type: "array" },
            mode: {
              type: "string",
              enum: ["cases", "results"],
              description:
                "cases: create or update the test cases only; results: also add this run's results",
            },
          },
          required: ["storyKey", "projectKey", "summary", "designHash", "description"],
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
        case "record_qa":
          return await this.recordQa(args);
        default:
          return fail(
            `unknown jira tool: ${name}. This adapter can read issues, comments and searches, create Bugs, and keep a story's QA sub-task; nothing else.`,
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
    const evidence = Array.isArray(args["attachments"])
      ? await this.attach(bugKey, (args["attachments"] as unknown[]).map(String))
      : undefined;
    return ok({
      key: bugKey,
      url: this.browseUrl(bugKey),
      storyKey,
      labels,
      linked: linked.ok,
      ...(evidence ? { attached: evidence.attached } : {}),
      ...(evidence && evidence.skipped.length > 0 ? { notAttached: evidence.skipped } : {}),
      ...(linked.ok
        ? {}
        : { linkError: (linked.result as { message?: string }).message ?? "link failed" }),
    });
  }

  /**
   * The story's one QA sub-task (ADR-004). Found by label under that story and
   * nowhere else; created when missing; its description rewritten only when
   * the design hash changed; one comment per call. If the project has no
   * sub-task type, the record goes to the story as a comment and says why.
   */
  private async recordQa(args: Record<string, unknown>): Promise<ToolResult> {
    const storyKey = issueKey(args["storyKey"]);
    const projectKey = typeof args["projectKey"] === "string" ? args["projectKey"] : "";
    const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
    const designHash = typeof args["designHash"] === "string" ? args["designHash"] : "";
    const description = blocks(args["description"]);
    const comment = blocks(args["comment"]);
    // "cases" right after the design is approved: the test cases, no comment.
    // "results" at the end of the run: the same, plus this run's results.
    const casesOnly = args["mode"] === "cases";
    if (!storyKey) return fail(`"storyKey" must be the story's issue key`);
    if (!/^[A-Z][A-Z0-9_]+$/.test(projectKey)) return fail(`"projectKey" must be a project key`);
    if (!summary.startsWith(QA_SUMMARY_PREFIX))
      return fail(`a QA sub-task's summary starts with "${QA_SUMMARY_PREFIX}"`);
    if (!designHash || description.length === 0)
      return fail(`"designHash" and "description" are required`);
    if (!casesOnly && comment.length === 0)
      return fail(`"comment" is required unless mode is "cases"`);
    const v3 = (this.conn.apiVersion ?? 3) === 3;
    const render = (b: QaBlock[]) => (v3 ? toAdfBlocks(b) : toWiki(b));

    // 1. Find it: this story's sub-task carrying our label, and only that.
    const jql = `parent = ${storyKey} AND labels = "${QA_LABEL}" ORDER BY created ASC`;
    const found = await this.request(
      "GET",
      v3
        ? `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=5&fields=description,labels,parent`
        : `/search?jql=${encodeURIComponent(jql)}&maxResults=5&fields=description,labels,parent`,
    );
    if (!found.ok) return found;
    const hits = ((found.body as { issues?: Array<Record<string, unknown>> }).issues ?? []).filter(
      (i) => {
        const f = (i["fields"] ?? {}) as Record<string, unknown>;
        const labels = Array.isArray(f["labels"]) ? (f["labels"] as unknown[]).map(String) : [];
        return (
          labels.includes(QA_LABEL) && str((f["parent"] as { key?: string })?.key) === storyKey
        );
      },
    );

    let qaKey = hits[0] ? str(hits[0]["key"]) : "";
    let created = false;
    let descriptionUpdated = false;
    if (!qaKey) {
      // 2. Create it.
      const type = await this.subtaskType(projectKey);
      if (!type) {
        const fallback = await this.request(
          "POST",
          `/issue/${encodeURIComponent(storyKey)}/comment`,
          {
            body: render([
              {
                kind: "paragraph",
                text: "This project has no sub-task type, so attestqa's QA record is posted here.",
              },
              ...description,
              ...(casesOnly ? [] : comment),
            ]),
          },
        );
        if (!fallback.ok) return fallback;
        return ok({
          storyKey,
          qaKey: null,
          postedTo: storyKey,
          reason: "no sub-task type in project",
        });
      }
      const res = await this.request("POST", `/issue`, {
        fields: {
          project: { key: projectKey },
          parent: { key: storyKey },
          issuetype: { id: type },
          summary,
          description: render(description),
          labels: [AGENT_TAG, QA_LABEL],
        },
      });
      if (!res.ok) return res;
      qaKey = str((res.body as { key?: string }).key);
      created = true;
    } else {
      // 3. Its description follows the approved design — rewritten only when that changed.
      const current = toText(
        ((hits[0]?.["fields"] ?? {}) as Record<string, unknown>)["description"],
      );
      if (!current.includes(`attestqa design ${designHash}`)) {
        const upd = await this.request("PUT", `/issue/${encodeURIComponent(qaKey)}`, {
          fields: { description: render(description) },
        });
        if (!upd.ok) return upd;
        descriptionUpdated = true;
      }
    }

    if (casesOnly)
      return ok({
        storyKey,
        qaKey,
        url: this.browseUrl(qaKey),
        created,
        descriptionUpdated,
        mode: "cases",
      });

    // 4. This run's results.
    const posted = await this.request("POST", `/issue/${encodeURIComponent(qaKey)}/comment`, {
      body: render(comment),
    });
    if (!posted.ok) return posted;
    return ok({
      storyKey,
      qaKey,
      url: this.browseUrl(qaKey),
      created,
      descriptionUpdated,
      commentId: str((posted.body as { id?: string }).id),
    });
  }

  /** The id of the project's sub-task issue type ("Subtask" or "Sub-task", by site). */
  private async subtaskType(projectKey: string): Promise<string | undefined> {
    const meta = await this.request(
      "GET",
      `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
    );
    const pick = (list: unknown): string | undefined => {
      const arr = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
      const t = arr.find((x) => x["subtask"] === true);
      return t ? str(t["id"]) : undefined;
    };
    if (meta.ok) {
      const b = meta.body as Record<string, unknown>;
      const found = pick(b["issueTypes"] ?? b["values"]);
      if (found) return found;
    }
    const all = await this.request("GET", `/issuetype`);
    return all.ok ? pick(all.body) : undefined;
  }

  // ---------------------------------------------------------------------------

  private async request(
    method: "GET" | "POST" | "PUT",
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
        // No body at all on a GET: real fetch refuses one, even "" (observed in
        // run 20261011T174437Z-e9488af3, where it left the story unread).
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

function blocks(v: unknown): QaBlock[] {
  return Array.isArray(v)
    ? (v as QaBlock[]).filter((b) => b && typeof b === "object" && "kind" in b)
    : [];
}

function adfText(text: string): Record<string, unknown> {
  return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
}

/** Atlassian Document Format (Cloud): headings, paragraphs, real tables, code. */
export function toAdfBlocks(doc: QaBlock[]): Record<string, unknown> {
  const cell = (type: "tableHeader" | "tableCell", text: string) => ({
    type,
    content: [adfText(text)],
  });
  return {
    type: "doc",
    version: 1,
    content: doc.map((b) => {
      switch (b.kind) {
        case "heading":
          return {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: b.text }],
          };
        case "code":
          return {
            type: "codeBlock",
            ...(b.language ? { attrs: { language: b.language } } : {}),
            content: b.text ? [{ type: "text", text: b.text }] : [],
          };
        case "table":
          return {
            type: "table",
            content: [
              { type: "tableRow", content: b.header.map((h) => cell("tableHeader", h)) },
              ...b.rows.map((r) => ({
                type: "tableRow",
                content: r.map((c) => cell("tableCell", c)),
              })),
            ],
          };
        default:
          return adfText(b.text);
      }
    }),
  };
}

/** Jira wiki markup (Data Center): the same document. */
export function toWiki(doc: QaBlock[]): string {
  const esc = (t: string) => t.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return doc
    .map((b) => {
      switch (b.kind) {
        case "heading":
          return `h3. ${b.text}`;
        case "code":
          // {noformat} keeps Gherkin as written on every Data Center version;
          // {code} would need a language it may not know.
          return `{noformat}\n${b.text}\n{noformat}`;
        case "table":
          return [
            `||${b.header.map(esc).join("||")}||`,
            ...b.rows.map((r) => `|${r.map((c) => esc(c) || " ").join("|")}|`),
          ].join("\n");
        default:
          return b.text;
      }
    })
    .join("\n\n");
}

function realpathSafe(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}
