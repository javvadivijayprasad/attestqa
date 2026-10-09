import { describe, it, expect } from "vitest";
import {
  gatherStoryContext,
  relations,
  isRunReport,
  isAgentBug,
} from "../src/skills/story-context.js";
import type { PreflightRead } from "../src/types.js";

/**
 * Shapes taken from a real ledger (run 20260921T133607Z-1470601c): the Azure
 * DevOps MCP server returns fenced JSON text, relations carry the linked id at
 * the end of the url, WIQL returns ids and nothing else, and comments arrive
 * newest first.
 */
const fence = (v: unknown) => `<<a1>>json\n${JSON.stringify(v)}\n<</a1>>`;
const rel = (kind: string, id: number) => ({
  rel: kind,
  url: `https://dev.azure.com/o/_apis/wit/workItems/${id}`,
  attributes: {},
});

const STORY = {
  id: 1,
  fields: {
    "System.WorkItemType": "User Story",
    "System.State": "New",
    "System.Title": "Login with valid credentials",
    "Microsoft.VSTS.Common.AcceptanceCriteria": "<div>AC-1: a registered user signs in</div>",
  },
  relations: [
    rel("Microsoft.VSTS.Common.TestedBy-Forward", 66),
    rel("Microsoft.VSTS.Common.TestedBy-Forward", 65),
    rel("System.LinkTypes.Hierarchy-Reverse", 42),
    rel("System.LinkTypes.Hierarchy-Forward", 47),
    rel("System.LinkTypes.Hierarchy-Forward", 45),
  ],
};

const EPIC = {
  id: 42,
  fields: {
    "System.WorkItemType": "Epic",
    "System.Title": "Customer account access",
    "System.Description": "<p>There is <b>no server-side session</b>.</p>",
  },
  relations: [
    rel("System.LinkTypes.Hierarchy-Forward", 1),
    rel("System.LinkTypes.Hierarchy-Forward", 44),
  ],
};

/** The story's siblings under the epic — here, the Logout story. */
const SIBLINGS = {
  value: [
    {
      id: 44,
      fields: {
        "System.WorkItemType": "User Story",
        "System.Title": "Log out of an account",
        "Microsoft.VSTS.Common.AcceptanceCriteria":
          "<p>AC-2: Logout returns the browser to the storefront home page.</p>",
      },
    },
  ],
};

const CASES = {
  value: [
    {
      id: 65,
      fields: {
        "System.WorkItemType": "Test Case",
        "System.Title": "AC-1: registered user signs in",
      },
    },
    {
      id: 66,
      fields: {
        "System.WorkItemType": "Test Case",
        "System.Title": "AC-2: wrong password shows error",
      },
    },
  ],
};

const TASKS = {
  value: [
    {
      id: 45,
      fields: {
        "System.WorkItemType": "Task",
        "System.State": "New",
        "System.Title": "Wire the login form to POST /rest/user/login",
        "System.Description": "<p>Not /api/Users/login — that is registration.</p>",
      },
    },
  ],
};

const COMMENTS = {
  totalCount: 3,
  comments: [
    {
      text: "## agentic-qa run `20260921T133607Z-1470601c`\n\n**Suite: green**",
      createdBy: { displayName: "Vijay" },
    },
    {
      text: "<p>PM decision: <b>no account lockout</b> this sprint.</p>",
      createdBy: { displayName: "Vijay" },
    },
    { text: "<p>Endpoint moved in 2.3.0.</p>", createdBy: { displayName: "Vijay" } },
  ],
};

const WIQL = { workItems: [{ id: 48 }, { id: 50 }, { id: 58 }, { id: 63 }] };

const BUGS = {
  value: [
    {
      id: 48,
      fields: {
        "System.Title": "Error message persists",
        "System.State": "Active",
        "System.Tags": "",
      },
    },
    {
      id: 50,
      fields: {
        "System.Title": "Session token survives logout",
        "System.State": "Resolved",
        "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>Sign in</li><li>Log out</li></ol>",
      },
    },
    // Filed by an earlier run before the tag existed: carries a run id.
    {
      id: 58,
      fields: {
        "System.Title": "Account menu hidden after login",
        "System.State": "New",
        "Microsoft.VSTS.TCM.ReproSteps":
          "<p>Run IDs where this failed: 20260918T231318Z-fb4f588c</p>",
      },
    },
    // Filed by a later run: tagged.
    {
      id: 63,
      fields: {
        "System.Title": "Playwright binaries missing",
        "System.State": "New",
        "System.Tags": "agentic-qa",
      },
    },
  ],
};

/** A read function that answers from fixtures and records what it was asked. */
function fakeRead(overrides: Partial<Record<string, unknown>> = {}) {
  const asked: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const read: PreflightRead = async (toolName, args) => {
    asked.push({ toolName, args });
    const key =
      toolName === "ado.wit_query"
        ? "wiql"
        : `${String(args["action"])}:${JSON.stringify(args["id"] ?? args["ids"] ?? "")}`;
    const table: Record<string, unknown> = {
      "get:1": STORY,
      "get_batch:[65,66]": CASES,
      "get:42": EPIC,
      "get_batch:[44]": SIBLINGS,
      "get_batch:[45,47]": TASKS,
      'list_comments:""': COMMENTS,
      wiql: WIQL,
      "get_batch:[48,50,58,63]": BUGS,
      ...overrides,
    };
    return key in table
      ? { ok: true, result: fence(table[key]) }
      : { ok: false, result: { message: `no fixture for ${key}` } };
  };
  return { read, asked };
}

describe("gatherStoryContext — stage 1, done by the runtime", () => {
  it("makes every read the skill used to leave to the model", async () => {
    // The ledger of the first green run: story, comments, the WIQL query — and
    // nothing else. The epic and the tasks were never read, and the open bugs
    // reached the model as bare ids.
    const { read, asked } = fakeRead();
    await gatherStoryContext(read, { workItem: "1", project: "sandbox" });
    const reads = asked.map((a) => `${a.toolName}:${String(a.args["action"])}`);
    expect(reads).toEqual([
      "ado.wit_work_item:get", // story
      "ado.wit_work_item:get_batch", // its existing test cases, by title
      "ado.wit_work_item:get", // epic
      "ado.wit_work_item:get_batch", // the epic's other stories
      "ado.wit_work_item:get_batch", // tasks
      "ado.wit_work_item:list_comments",
      "ado.wit_query:wiql",
      "ado.wit_work_item:get_batch", // the open bugs' CONTENT — the step that was skipped
    ]);
    // Every read carries the project.
    for (const a of asked) expect(a.args["project"]).toBe("sandbox");
  });

  it("carries the facts that live outside the acceptance criteria", async () => {
    const { read } = fakeRead();
    const d = await gatherStoryContext(read, { workItem: "1" });
    expect(d.text).toContain("AC-1: a registered user signs in");
    expect(d.text).toContain("no server-side session"); // epic
    expect(d.text).toContain("/rest/user/login"); // task
    expect(d.text).toContain("no account lockout"); // comment — the negative control
    expect(d.text).toContain("#65 AC-1: registered user signs in"); // existing cases, by title
    expect(d.text).toContain("Do NOT create another case");
    // The sibling story — without it, the agent put a logout test into the
    // login story and invented an expected behaviour the Logout story
    // contradicts (20260921T192908Z).
    expect(d.text).toContain("#44 [User Story] Log out of an account");
    expect(d.text).toContain("storefront home page");
    expect(d.text).not.toContain("<p>"); // HTML stripped
  });

  it("carries the criteria, bugs and tasks as facts for stage 2", async () => {
    const { read } = fakeRead();
    const d = await gatherStoryContext(read, { workItem: "1" });
    const f = d.facts as {
      acceptanceCriteria: string[];
      bugs: Array<{ id: number; state: string }>;
      tasks: number[];
    };
    expect(f.acceptanceCriteria).toEqual(["AC-1"]);
    expect(f.bugs.map((b) => `${b.id}:${b.state}`)).toContain("50:Resolved");
    expect(f.tasks.length).toBeGreaterThan(0);
  });

  it("gives each open bug its state and what that state asks for", async () => {
    const { read } = fakeRead();
    const d = await gatherStoryContext(read, { workItem: "1" });
    expect(d.text).toContain("#50 [Resolved] Session token survives logout");
    expect(d.text).toMatch(/RESOLVED — claimed fixed, never verified/);
    expect(d.text).toMatch(/ACTIVE — known broken[^\n]*must not become a bug/);
    // Relevance is left to the model, and it is asked to say so per bug.
    expect(d.text).toContain("For EACH open bug above");
  });

  it("leaves out everything this runtime wrote — in code, not by instruction", async () => {
    // Run reports and agent-proposed bugs are created with the operator's own
    // credentials, so the author field cannot separate them from a human's.
    const { read } = fakeRead();
    const d = await gatherStoryContext(read, { workItem: "1" });
    expect(d.text).not.toContain("Suite: green"); // run report
    expect(d.text).not.toContain("Playwright binaries missing"); // tagged
    expect(d.text).not.toContain("Account menu hidden"); // run id, from before the tag
    expect(d.summary).toMatchObject({
      commentsRead: 2,
      commentsExcluded: 1,
      openBugsRead: 2,
      openBugsExcluded: 2,
    });
  });

  it("says plainly when the story has no epic and no tasks", async () => {
    const { read } = fakeRead({ "get:1": { ...STORY, relations: [] } });
    const d = await gatherStoryContext(read, { workItem: "1" });
    expect(d.text).toContain("PARENT: none");
    expect(d.text).toContain("CHILD ITEMS: none linked");
  });

  it("stops the agent guessing when the story cannot be read", async () => {
    const read: PreflightRead = async () => ({ ok: false, result: { message: "401" } });
    const d = await gatherStoryContext(read, { workItem: "1" });
    expect(d.text).toContain("could not be read. Stop and report");
    expect(d.summary["storyRead"]).toBe(0);
  });
});

describe("relations", () => {
  it("finds the parent and the children, and ignores the rest", () => {
    expect(relations(STORY)).toEqual({ parent: 42, children: [45, 47] });
    expect(relations({})).toEqual({ children: [] });
  });
});

describe("provenance markers", () => {
  it("recognises a run report, including one wrapped in HTML", () => {
    expect(isRunReport("## agentic-qa run `x`")).toBe(true);
    expect(isRunReport("<div><p>## agentic-qa run `x`</p></div>")).toBe(true);
    expect(isRunReport("We discussed the agentic-qa run yesterday")).toBe(false);
  });

  it("recognises an agent-filed bug by tag or by run id, and nothing else", () => {
    expect(isAgentBug("agentic-qa", "")).toBe(true);
    expect(isAgentBug("login; Agentic-QA", "")).toBe(true);
    expect(isAgentBug("", "failed in 20260918T233715Z-f5c9f934")).toBe(true);
    expect(isAgentBug("agentic-qa-review", "")).toBe(false);
    expect(isAgentBug("", "failed on 2026-09-18 at 23:37")).toBe(false);
  });
});

describe("a refused read is reported as a refusal, never as an absence", () => {
  it("names the scope refusal for the epic, the tasks and the open bugs", async () => {
    // Observed: agent.scope.work_items was ["1", "29-34"], so the gate refused
    // the epic, the tasks and the open bugs — correctly. Preflight then
    // reported "epic none, 0 tasks, 0 open bugs": three refusals dressed as
    // three absences, telling the model there was nothing to know and the
    // operator there was nothing to fix.
    const refused = {
      ok: false,
      result: { message: 'work item "42" is not in the allowed work_items' },
    };
    const inner = fakeRead().read;
    const read: PreflightRead = async (toolName, args) => {
      const id = args["id"];
      if (args["action"] === "get" && id === 1) return inner(toolName, args);
      if (args["action"] === "list_comments" || toolName === "ado.wit_query")
        return inner(toolName, args);
      return refused;
    };
    const d = await gatherStoryContext(read, { workItem: "1" });
    expect(d.text).toMatch(/PARENT #42: NOT READ — outside agent\.scope\.work_items/);
    expect(d.text).toMatch(/CHILD ITEMS #45, #47: NOT READ/);
    expect(d.text).toMatch(/OPEN BUGS #48, #50, #58, #63: found but NOT READ/);
    expect(d.text).not.toContain("PARENT: none");
    expect(d.summary).toMatchObject({ epicRefused: 1, tasksRefused: 2, openBugsRefused: 4 });
  });
});
