import type { PreflightDigest, PreflightRead } from "../types.js";
import { asArray, asRecord, testedByIds } from "../verify/evidence.js";
import { stripHtml } from "../runtime/render-approval.js";
import { AGENT_TAG } from "../verify/story-to-tests.js";
import { acLabels } from "../triage/settle.js";
import { featurePathFor, specPathFor, type StoryFacts } from "../design/test-design.js";
import { renderProfile, surveyFramework } from "../framework/survey.js";

/**
 * Stage 1 of the workflow: everything around a story that a tester would read
 * before designing a test for it — gathered by the RUNTIME, not left to the
 * model.
 *
 * ── Why it moved out of the instructions ──
 * Step 1a of the skill told the agent to read the epic, the tasks, the comments
 * and the open bugs. The ledger of the first fully green run showed what it
 * actually did: read the story, read the comments, ran the open-bug query —
 * which returns ids and nothing else — and never read one of them, and never
 * touched the epic or the tasks. So the one Resolved bug in the project, the
 * clearest case there is for a regression test, reached the model as a bare
 * number.
 *
 * ── What is left out, and why it is done here ──
 * This runtime writes to the same work items it reads: a run report as a
 * comment, a proposed defect as a Bug. Both are created with the operator's own
 * credentials, so the author field cannot tell them from a human's. Read back as
 * context, they turn the agent's past guesses into present "facts" about the
 * product — observed, as a story carrying twelve run reports and three open bugs
 * the agent had filed itself. The instruction to ignore them was the part most
 * likely to be skipped, so the filtering is code:
 *   - a comment beginning "## agentic-qa run" is a run report;
 *   - a Bug tagged "agentic-qa" was proposed by the agent;
 *   - a Bug whose text carries a run id (e.g. 20260918T233715Z-f5c9f934) was
 *     proposed by the agent before the tag existed — the skill has always
 *     required the run id in a filed bug, which makes it a reliable marker.
 */

export interface StoryContextOptions {
  workItem: string;
  /** The workspace whose test framework stage 0 surveys. */
  workspaceDir?: string;
  /** Azure DevOps project, passed on every read when known. */
  project?: string;
}

/** A run id as this runtime writes it: 20260918T233715Z-f5c9f934. */
const RUN_ID = /\b\d{8}T\d{6}Z-[0-9a-f]{8}\b/;

/** Per-item text caps. Enough to carry the facts; short enough to leave room. */
const DESCRIPTION_CHARS = 700;
const COMMENT_CHARS = 600;
const REPRO_CHARS = 600;

export async function gatherStoryContext(
  read: PreflightRead,
  opts: StoryContextOptions,
): Promise<PreflightDigest> {
  const base: Record<string, unknown> = opts.project ? { project: opts.project } : {};
  const id = Number(opts.workItem);
  const out: string[] = [];
  const summary: Record<string, number> = {};
  // The same facts, structured, for stage 2: a test design is checked against
  // the criteria, bugs and tasks read here — not against the model's memory of
  // them.
  const facts: StoryFacts = { acceptanceCriteria: [], bugs: [], tasks: [] };
  let frameworkLines: string[] = [];

  // ---- stage 0: the framework already here ---------------------------------
  if (opts.workspaceDir) {
    const profile = surveyFramework(opts.workspaceDir);
    facts.framework = profile;
    summary["frameworkFound"] = profile.exists ? 1 : 0;
    summary["existingSpecs"] = profile.specs.length;
    frameworkLines = renderProfile(profile);
  }

  out.push(
    "STORY CONTEXT — read by the runtime before your first turn, through the same",
    "governed tools you use, and recorded in the ledger. Do not read these items",
    "again. Anything this runtime wrote itself has already been removed.",
    "",
  );

  // ---- the story -----------------------------------------------------------
  const story = await read("ado.wit_work_item", {
    ...base,
    action: "get",
    id,
    expand: "Relations",
  });
  const s = asRecord(story.result);
  const sf = asRecord(s?.["fields"]) ?? {};
  if (!story.ok || !s) {
    out.push(`STORY AB#${id}: could not be read. Stop and report that rather than guessing.`);
    return { toolName: "aqa.story_context", text: out.join("\n"), summary: { storyRead: 0 } };
  }
  summary["storyRead"] = 1;
  facts.story = { id, title: str(sf["System.Title"]) };
  out.push(
    `STORY AB#${id} [${str(sf["System.WorkItemType"])}, ${str(sf["System.State"])}] ${str(
      sf["System.Title"],
    )}`,
  );
  const ac = clean(sf["Microsoft.VSTS.Common.AcceptanceCriteria"], 4000);
  if (ac) out.push("Acceptance criteria:", indent(ac));
  else
    out.push(
      "Acceptance criteria: NONE RECORDED on this story.",
      '  Design from the description, the tasks and the comments instead, cover "story", and cite',
      '  what you read ("story description"). Say in your final message that the story has no',
      "  acceptance criteria — a story without them is a finding in its own right. You may still",
      "  only use what is written down: the description, the tasks, the comments and the bugs.",
      "  How the application happens to behave is not a requirement.",
    );
  facts.acceptanceCriteria = criteriaLabels(ac);
  const desc = clean(sf["System.Description"], DESCRIPTION_CHARS);
  if (desc) out.push("Description:", indent(desc));

  const rel = relations(s);
  const existing = testedByIds(s);
  summary["existingTestCases"] = existing.length;
  if (existing.length === 0) {
    out.push("EXISTING TEST CASES: none linked to this story yet.", "");
  } else {
    // Read by TITLE, because the title names the acceptance criterion a case
    // covers. Without this the agent knew only that ids 65-68 existed, and
    // created 69-72 for the same four criteria (20260921T192908Z).
    const tc = await read(
      "ado.wit_work_item",
      {
        ...base,
        action: "get_batch",
        ids: existing,
        fields: ["System.Id", "System.Title", "System.WorkItemType"],
      },
      { linkedToStory: true },
    );
    const cases = workItems(tc.result);
    out.push(
      `EXISTING TEST CASES (${existing.length}) — one per acceptance criterion is the rule. Do NOT create ` +
        "another case for a criterion listed here; the runtime refuses a duplicate:",
    );
    if (!tc.ok || cases.length === 0) {
      out.push(`  ${existing.map((n) => `#${n}`).join(", ")} — titles not read: ${why(tc.result)}`);
    } else {
      for (const w of cases) {
        const f = asRecord(w["fields"]) ?? {};
        out.push(`  #${str(w["id"] ?? f["System.Id"])} ${str(f["System.Title"])}`);
      }
    }
    out.push("");
  }

  // ---- the epic, one level up ---------------------------------------------
  if (rel.parent !== undefined) {
    const p = await read(
      "ado.wit_work_item",
      { ...base, action: "get", id: rel.parent, expand: "Relations" },
      { linkedToStory: true },
    );
    const pr = asRecord(p.result);
    const pf = asRecord(pr?.["fields"]) ?? {};
    if (p.ok) {
      summary["epicRead"] = 1;
      facts.epic = { id: Number(rel.parent), title: str(pf["System.Title"]) };
      out.push(
        `PARENT #${rel.parent} [${str(pf["System.WorkItemType"])}] ${str(pf["System.Title"])}`,
      );
      const d = clean(pf["System.Description"], DESCRIPTION_CHARS);
      if (d) out.push(indent(d));

      // ---- the story's SIBLINGS: the epic's other stories ------------------
      // Without them the agent cannot tell which story a behaviour belongs
      // to. Observed in 20260921T192908Z: given open bug #50 ("session token
      // survives logout") and no idea a Logout story existed, the agent put a
      // logout test into the LOGIN story, invented an expected behaviour for it
      // ("redirect to /#/login") that the Logout story contradicts, and
      // proposed a bug when the app correctly did otherwise.
      const siblings = relations(pr).children.filter((n) => n !== id);
      if (siblings.length > 0) {
        const sb = await read(
          "ado.wit_work_item",
          {
            ...base,
            action: "get_batch",
            ids: siblings,
            fields: [
              "System.Id",
              "System.Title",
              "System.WorkItemType",
              "System.State",
              "Microsoft.VSTS.Common.AcceptanceCriteria",
            ],
          },
          { linkedToStory: true },
        );
        const items = workItems(sb.result);
        summary["siblingsRead"] = items.length;
        out.push(
          "",
          `OTHER STORIES UNDER THIS ${
            str(pf["System.WorkItemType"]).toUpperCase() || "PARENT"
          } — behaviour ` +
            "that belongs to one of these is NOT this story's to test. If an open bug below is about one " +
            "of them, say so and leave it:",
        );
        if (!sb.ok)
          out.push(`  ${siblings.map((n) => `#${n}`).join(", ")}: NOT READ — ${why(sb.result)}`);
        for (const w of items) {
          const f = asRecord(w["fields"]) ?? {};
          out.push(
            `  #${str(w["id"] ?? f["System.Id"])} [${str(f["System.WorkItemType"])}] ${str(
              f["System.Title"],
            )}`,
          );
          const sac = clean(f["Microsoft.VSTS.Common.AcceptanceCriteria"], DESCRIPTION_CHARS);
          if (sac) out.push(indent(sac, 4));
        }
      }
    } else {
      summary["epicRefused"] = 1;
      out.push(`PARENT #${rel.parent}: NOT READ — ${why(p.result)}`);
    }
  } else {
    out.push("PARENT: none — this story is not under an epic or feature.");
  }
  out.push("");

  // ---- the tasks, one level down ------------------------------------------
  if (rel.children.length > 0) {
    const c = await read(
      "ado.wit_work_item",
      {
        ...base,
        action: "get_batch",
        ids: rel.children,
        fields: [
          "System.Id",
          "System.Title",
          "System.WorkItemType",
          "System.State",
          "System.Description",
        ],
      },
      { linkedToStory: true },
    );
    const items = workItems(c.result);
    summary["tasksRead"] = items.length;
    facts.tasks = rel.children;
    if (!c.ok) {
      summary["tasksRefused"] = rel.children.length;
      out.push(
        `CHILD ITEMS ${rel.children.map((n) => `#${n}`).join(", ")}: NOT READ — ${why(c.result)}`,
      );
    } else {
      out.push(`CHILD ITEMS (${items.length}) — where the implementation facts usually are:`);
    }
    for (const w of items) {
      const f = asRecord(w["fields"]) ?? {};
      out.push(
        `  #${str(w["id"] ?? f["System.Id"])} [${str(f["System.WorkItemType"])}, ${str(
          f["System.State"],
        )}] ${str(f["System.Title"])}`,
      );
      const d = clean(f["System.Description"], DESCRIPTION_CHARS);
      if (d) out.push(indent(d, 4));
    }
  } else {
    out.push("CHILD ITEMS: none linked to this story.");
  }
  out.push("");

  // ---- comments -------------------------------------------------------------
  const cm = await read("ado.wit_work_item", { ...base, action: "list_comments", workItemId: id });
  const comments = asArray(asRecord(cm.result)?.["comments"]).map((x) => asRecord(x) ?? {});
  const human = comments.filter((x) => !isRunReport(str(x["text"])));
  summary["commentsRead"] = human.length;
  summary["commentsExcluded"] = comments.length - human.length;
  out.push(
    `COMMENTS — ${human.length} from people` +
      (comments.length > human.length
        ? `; ${comments.length - human.length} run reports written by this runtime were left out:`
        : ":"),
  );
  if (human.length === 0) out.push("  (none)");
  // Oldest first: a decision is usually recorded, then refined.
  for (const x of [...human].reverse()) {
    const who = str(asRecord(x["createdBy"])?.["displayName"]) || "someone";
    out.push(`  - ${who}:`, indent(clean(x["text"], COMMENT_CHARS), 4));
  }
  out.push("");

  // ---- open bugs ------------------------------------------------------------
  const q = await read("ado.wit_query", {
    ...base,
    action: "wiql",
    wiql:
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project " +
      "AND [System.WorkItemType] = 'Bug' AND [System.State] <> 'Closed' ORDER BY [System.Id]",
  });
  const bugIds = asArray(asRecord(q.result)?.["workItems"])
    .map((w) => Number(asRecord(w)?.["id"]))
    .filter((n) => Number.isFinite(n));
  summary["openBugsFound"] = bugIds.length;

  if (bugIds.length === 0) {
    out.push("OPEN BUGS: none in this project.");
  } else {
    // The query returns ids only. Reading them is the step that was skipped.
    // A RUNTIME read of what the project's own open-bug query returned, like
    // the epic and the tasks. Listing every bug id in agent.scope.work_items
    // cannot be done in advance — and once this runtime files a bug, the next
    // run's query returns an id nobody listed, which refused the whole batch
    // and left a run knowing nothing about any bug (20260923T234233Z).
    const b = await read(
      "ado.wit_work_item",
      {
        ...base,
        action: "get_batch",
        ids: bugIds.slice(0, 50),
        fields: [
          "System.Id",
          "System.Title",
          "System.State",
          "System.Tags",
          "Microsoft.VSTS.TCM.ReproSteps",
        ],
      },
      { linkedToStory: true },
    );
    if (!b.ok) {
      summary["openBugsRefused"] = bugIds.length;
      out.push(
        `OPEN BUGS ${bugIds.map((n) => `#${n}`).join(", ")}: found but NOT READ — ${why(b.result)}`,
        "You know these bugs exist and nothing about them. Say so; do not guess at their content.",
      );
      return { toolName: "aqa.story_context", text: out.join("\n"), summary, facts };
    }
    const bugs = workItems(b.result).map((w) => {
      const f = asRecord(w["fields"]) ?? {};
      return {
        id: str(w["id"] ?? f["System.Id"]),
        title: str(f["System.Title"]),
        state: str(f["System.State"]),
        tags: str(f["System.Tags"]),
        repro: clean(f["Microsoft.VSTS.TCM.ReproSteps"], REPRO_CHARS),
      };
    });
    const humanBugs = bugs.filter((x) => !isAgentBug(x.tags, x.repro));
    summary["openBugsRead"] = humanBugs.length;
    facts.bugs = humanBugs.map((x) => ({ id: Number(x.id), state: x.state, title: x.title }));
    // Every bug, provenance recorded, for the rules only — never for the prompt.
    // `duplicateBug` needs to know what this runtime already filed; the model
    // must not, or it reads its own guesses back as requirements.
    facts.filedBugs = bugs.map((x) => ({
      id: Number(x.id),
      state: x.state,
      title: x.title,
      agent: isAgentBug(x.tags, x.repro),
    }));
    summary["openBugsExcluded"] = bugs.length - humanBugs.length;
    out.push(
      `OPEN BUGS — ${humanBugs.length} filed by people` +
        (bugs.length > humanBugs.length
          ? `; ${
              bugs.length - humanBugs.length
            } proposed by this runtime and never confirmed were left out.`
          : "."),
      "Each state asks something different of you:",
    );
    for (const x of humanBugs) {
      out.push(
        `  #${x.id} [${x.state}] ${x.title}`,
        `    ${STATE_MEANING[x.state] ?? "State not recognised — treat as a claim."}`,
      );
      if (x.repro) out.push(indent(x.repro, 4));
    }
    out.push(
      "",
      "For EACH open bug above, say in one line whether it touches THIS story's",
      "behaviour and why. Relevance is your judgement: a bug about a neighbouring",
      "story is not a reason to add a test here, and saying so is a finding.",
    );
  }

  if (frameworkLines.length > 0) out.push("", ...frameworkLines);

  const feature = featurePathFor(facts);
  if (feature && facts.framework?.exists !== false) {
    out.push(
      "",
      `THIS EPIC'S TESTS LIVE IN ONE FILE: ${feature} (and the spec bdd2pw generates`,
      `from it, ${specPathFor(facts)}). Tests follow the application, not the backlog:`,
      "login, logout and everything else on these pages belong together, where a tester",
      "can find them. Add YOUR story's scenarios to that file, each tagged",
      `@story:${facts.story?.id ?? ""} alongside @ac:<n>, @design:<id> and @bug:<id>.`,
      "Scenarios tagged with another story are that story's: leave them exactly as they",
      "are — a write that drops them is refused, and so is a write to any other feature",
      "or spec path.",
    );
  }

  return { toolName: "aqa.story_context", text: out.join("\n"), summary, facts };
}

export const STATE_MEANING: Record<string, string> = {
  New: "NEW — reported, not confirmed. A claim, not a fact.",
  Active:
    "ACTIVE — known broken and being worked. A test for it is EXPECTED to fail; that failure is not a new defect and must not become a bug.",
  Resolved:
    "RESOLVED — claimed fixed, never verified. If it touches this story, write the regression test and tag the scenario @bug:<id>.",
};

// ---------------------------------------------------------------- parsing

export interface Relations {
  parent?: number;
  children: number[];
}

/** The parent and child ids from a work item's relations. */
export function relations(item: unknown): Relations {
  const out: Relations = { children: [] };
  for (const r of asArray(asRecord(item)?.["relations"])) {
    const rec = asRecord(r);
    const kind = str(rec?.["rel"]);
    const id = Number(/\/(\d+)\s*$/.exec(str(rec?.["url"]))?.[1]);
    if (!Number.isFinite(id)) continue;
    if (kind === "System.LinkTypes.Hierarchy-Reverse") out.parent = id;
    else if (kind === "System.LinkTypes.Hierarchy-Forward") out.children.push(id);
  }
  out.children = [...new Set(out.children)].sort((a, b) => a - b);
  return out;
}

/** A get_batch result as a list of work items, whatever envelope it came in. */
function workItems(result: unknown): Array<Record<string, unknown>> {
  const rec = asRecord(result);
  const list = rec ? rec["value"] ?? rec["workItems"] : result;
  return asArray(list).map((x) => asRecord(x) ?? {});
}

/** A run report this runtime posted as a comment. */
export function isRunReport(text: string): boolean {
  return /^\s*(<[^>]+>\s*)*##\s*agentic-qa run\b/i.test(text);
}

/** A bug this runtime proposed: tagged, or carrying a run id from before the tag existed. */
export function isAgentBug(tags: string, text: string): boolean {
  if (tags.split(";").some((t) => t.trim().toLowerCase() === AGENT_TAG)) return true;
  return RUN_ID.test(text);
}

export function clean(v: unknown, max: number): string {
  const t = stripHtml(str(v))
    .replace(/\n{2,}/g, "\n")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function indent(text: string, by = 2): string {
  const pad = " ".repeat(by);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/**
 * Why a read did not happen, in words the model and the operator can act on.
 *
 * A refused read must never look like an empty one. The first version of this
 * reported three scope refusals as "epic none, 0 tasks, 0 open bugs" — a
 * refusal dressed as an absence, which tells the model there is nothing to know
 * and tells the operator there is nothing to fix.
 */
export function why(result: unknown): string {
  const m = str(asRecord(result)?.["message"]);
  if (/not in the allowed work_items/i.test(m)) {
    return `outside agent.scope.work_items (${m}). The governance gate refused it; widen the scope in the config if this item should be read.`;
  }
  return m || "the read failed.";
}

/**
 * The criterion labels in a story's acceptance criteria: the label at the start
 * of a line ("AC-1: …"), not every mention of one inside another criterion's
 * text. A line may start with a list bullet or number, because stripHtml turns
 * "<li>" into "• " — and Azure DevOps keeps criteria as an HTML list. Without
 * that, a story whose criteria were all present read as having none, and every
 * design item was refused as "not one of the story's criteria ()" (AB#91 in
 * 20261020T195435Z, attestqa 2.0.0).
 */
export function criteriaLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((l) => /^\s*(?:[•·*\-–—]\s*|\d+[.)]\s*)?(AC[- ]?\d+[a-z]?)\s*[:.)\-–—]/i.exec(l)?.[1])
        .filter((x): x is string => !!x)
        .flatMap((x) => acLabels(x)),
    ),
  ];
}
