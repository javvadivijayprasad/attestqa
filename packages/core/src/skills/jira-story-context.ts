import type { PreflightDigest, PreflightRead } from "../types.js";
import { asArray, asRecord } from "../verify/evidence.js";
import { acLabels } from "../triage/settle.js";
import { featurePathFor, specPathFor, type StoryFacts } from "../design/test-design.js";
import { normId, type TrackerId } from "../design/ids.js";
import { renderProfile, surveyFramework } from "../framework/survey.js";
import {
  STATE_MEANING,
  clean,
  indent,
  isAgentBug,
  isRunReport,
  str,
  why,
} from "./story-context.js";

/**
 * Stage 1 for a Jira story: the same reading as `gatherStoryContext` does for
 * Azure DevOps, ending in the same `StoryFacts` and the same digest layout, so
 * nothing after stage 1 needs to know which tracker the story came from.
 *
 * What differs, and why:
 *   - Acceptance criteria come from the configured custom field, or else from
 *     a section of the description headed "Acceptance criteria". Jira has no
 *     standard field for them; the adapter says which source it used.
 *   - The parent is the issue's `parent` (an epic in company-managed and
 *     team-managed projects alike); its other children are found with
 *     `parent = KEY`.
 *   - Jira has no test-case work item, so there are no existing cases to list:
 *     the tests live in the repository and the epic's feature file says what
 *     exists.
 *   - Bug states are workflow-specific. They are mapped by name onto the three
 *     meanings the Azure DevOps states carry (claimed, known broken, claimed
 *     fixed); a status the map does not know is treated as a claim. Closed bugs
 *     are left out, as they are for Azure DevOps.
 *   - A bug this runtime filed carries the `agentic-qa` label (the adapter adds
 *     it to every Bug it creates), or a run id in its summary.
 */

export interface JiraStoryContextOptions {
  /** The story's issue key, e.g. SHOP-12. */
  workItem: string;
  workspaceDir?: string;
  /** Project key for the open-bug search; defaults to the story key's prefix. */
  projectKey?: string;
}

const MAX_SUBTASKS = 10;
const MAX_BUGS = 50;

/** Jira status names, by what they ask of a tester. */
const JIRA_STATE: Array<[RegExp, keyof typeof STATE_MEANING]> = [
  [/^(to do|open|new|backlog|selected for development|reported|triage)$/i, "New"],
  [/^(in progress|reopened|in development|in review|code review|blocked)$/i, "Active"],
  [/^(resolved|done|fixed|ready for qa|in qa|in test(ing)?|ready for test(ing)?)$/i, "Resolved"],
];

export function jiraStateMeaning(status: string): string {
  const hit = JIRA_STATE.find(([re]) => re.test(status.trim()));
  const meaning = hit ? STATE_MEANING[hit[1]] : undefined;
  return meaning ?? "State not recognised — treat as a claim.";
}

/** Closed is the one state that leaves a bug out of the context entirely. */
function isClosed(status: string): boolean {
  return /^(closed|won'?t (do|fix)|declined|rejected|duplicate|cancell?ed)$/i.test(status.trim());
}

export async function gatherJiraStoryContext(
  read: PreflightRead,
  opts: JiraStoryContextOptions,
): Promise<PreflightDigest> {
  const id = normId(opts.workItem);
  const out: string[] = [];
  const summary: Record<string, number> = {};
  const facts: StoryFacts = { acceptanceCriteria: [], bugs: [], tasks: [] };
  let frameworkLines: string[] = [];

  if (typeof id !== "string") {
    return {
      toolName: "aqa.story_context",
      text: `STORY ${opts.workItem}: not a Jira issue key (expected something like SHOP-12). Stop and report that.`,
      summary: { storyRead: 0 },
    };
  }
  const projectKey = opts.projectKey ?? id.slice(0, id.lastIndexOf("-"));

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
  const story = await read("jira.get_issue", { key: id });
  const s = asRecord(story.result);
  if (!story.ok || !s || !str(s["key"])) {
    out.push(`STORY ${id}: could not be read. Stop and report that rather than guessing.`);
    return { toolName: "aqa.story_context", text: out.join("\n"), summary: { storyRead: 0 } };
  }
  summary["storyRead"] = 1;
  facts.story = { id, title: str(s["summary"]) };
  out.push(`STORY ${id} [${str(s["type"])}, ${str(s["status"])}] ${str(s["summary"])}`);
  const ac = clean(s["acceptanceCriteria"], 4000);
  if (ac) out.push("Acceptance criteria:", indent(ac));
  else
    out.push(
      "Acceptance criteria: NONE RECORDED on this story.",
      '  Design from the description, the sub-tasks and the comments instead, cover "story", and cite',
      '  what you read ("story description"). Say in your final message that the story has no',
      "  acceptance criteria — a story without them is a finding in its own right. You may still",
      "  only use what is written down: the description, the sub-tasks, the comments and the bugs.",
      "  How the application happens to behave is not a requirement.",
    );
  facts.acceptanceCriteria = [
    ...new Set(
      ac
        .split("\n")
        .map((l) => /^\s*[-*]?\s*(AC[- ]?\d+[a-z]?)\s*[:.)\-–—]/i.exec(l)?.[1])
        .filter((x): x is string => !!x)
        .flatMap((x) => acLabels(x)),
    ),
  ];
  // The description minus the criteria section already shown.
  const desc = clean(
    str(s["acceptanceCriteriaSource"]) === "description"
      ? str(s["description"])
          .replace(str(s["acceptanceCriteria"]), "")
          .replace(/^\s*#*\s*acceptance\s+criteria\s*:?\s*$/im, "")
      : s["description"],
    700,
  );
  if (desc) out.push("Description:", indent(desc));
  out.push(
    "EXISTING TEST CASES: Jira keeps no test-case items; the tests that exist are the",
    "scenarios in this epic's feature file.",
    "",
  );

  // ---- the parent and its other children -----------------------------------
  const parent = normId(s["parent"]);
  if (typeof parent === "string") {
    const p = await read("jira.get_issue", { key: parent }, { linkedToStory: true });
    const pr = asRecord(p.result);
    if (p.ok && pr) {
      summary["epicRead"] = 1;
      facts.epic = { id: parent, title: str(pr["summary"]) };
      out.push(`PARENT ${parent} [${str(pr["type"])}] ${str(pr["summary"])}`);
      const d = clean(pr["description"], 700);
      if (d) out.push(indent(d));

      const sb = await read("jira.search", {
        jql: `parent = ${parent} AND key != ${id} ORDER BY key`,
        maxResults: 50,
      });
      const items = asArray(asRecord(sb.result)?.["issues"]).map((x) => asRecord(x) ?? {});
      summary["siblingsRead"] = items.length;
      if (!sb.ok || items.length > 0)
        out.push(
          "",
          `OTHER STORIES UNDER THIS ${str(pr["type"]).toUpperCase() || "PARENT"} — behaviour that belongs ` +
            "to one of these is NOT this story's to test. If an open bug below is about one of them, say " +
            "so and leave it:",
        );
      if (!sb.ok) out.push(`  NOT READ — ${why(sb.result)}`);
      for (const w of items)
        out.push(
          `  ${str(w["key"])} [${str(w["type"])}, ${str(w["status"])}] ${str(w["summary"])}`,
        );
    } else {
      summary["epicRefused"] = 1;
      out.push(`PARENT ${parent}: NOT READ — ${why(p.result)}`);
    }
  } else {
    out.push("PARENT: none — this story is not under an epic.");
  }
  out.push("");

  // ---- sub-tasks -------------------------------------------------------------
  const subtasks = asArray(s["subtasks"]).map((x) => asRecord(x) ?? {});
  const taskIds = subtasks
    .map((t) => normId(t["key"]))
    .filter((k): k is TrackerId => k !== undefined);
  facts.tasks = taskIds;
  if (subtasks.length === 0) {
    out.push("SUB-TASKS: none on this story.");
  } else {
    out.push(`SUB-TASKS (${subtasks.length}) — where the implementation facts usually are:`);
    let read_ = 0;
    for (const t of subtasks) {
      const key = str(t["key"]);
      out.push(`  ${key} [${str(t["status"])}] ${str(t["summary"])}`);
      if (read_ >= MAX_SUBTASKS) continue;
      const r = await read("jira.get_issue", { key }, { linkedToStory: true });
      read_ += 1;
      const d = r.ok ? clean(asRecord(r.result)?.["description"], 700) : "";
      if (d) out.push(indent(d, 4));
      else if (!r.ok) out.push(`    NOT READ — ${why(r.result)}`);
    }
    summary["tasksRead"] = read_;
  }
  out.push("");

  // ---- comments -------------------------------------------------------------
  const cm = await read("jira.list_comments", { key: id });
  const comments = asArray(asRecord(cm.result)?.["comments"]).map((x) => asRecord(x) ?? {});
  const human = comments.filter((x) => !isRunReport(str(x["text"])));
  summary["commentsRead"] = human.length;
  summary["commentsExcluded"] = comments.length - human.length;
  if (!cm.ok) out.push(`COMMENTS: NOT READ — ${why(cm.result)}`);
  else {
    out.push(
      `COMMENTS — ${human.length} from people` +
        (comments.length > human.length
          ? `; ${comments.length - human.length} run reports written by this runtime were left out:`
          : ":"),
    );
    if (human.length === 0) out.push("  (none)");
    // The adapter returns them oldest first already.
    for (const x of human)
      out.push(`  - ${str(x["author"]) || "someone"}:`, indent(clean(x["text"], 600), 4));
  }
  out.push("");

  // ---- open bugs ------------------------------------------------------------
  const q = await read("jira.search", {
    jql: `project = ${projectKey} AND issuetype = Bug ORDER BY updated DESC`,
    maxResults: MAX_BUGS,
  });
  if (!q.ok) {
    summary["openBugsRefused"] = 1;
    out.push(
      `OPEN BUGS: NOT READ — ${why(q.result)}`,
      "You do not know which bugs exist. Say so; do not guess.",
    );
  } else {
    const all = asArray(asRecord(q.result)?.["issues"])
      .map((x) => asRecord(x) ?? {})
      .map((w) => ({
        id: normId(w["key"]),
        key: str(w["key"]),
        title: str(w["summary"]),
        state: str(w["status"]),
        labels: asArray(w["labels"]).map(String).join(";"),
      }))
      .filter((x): x is typeof x & { id: TrackerId } => x.id !== undefined);
    const open = all.filter((x) => !isClosed(x.state));
    summary["openBugsFound"] = open.length;
    const humanBugs = open.filter((x) => !isAgentBug(x.labels, x.title));
    summary["openBugsRead"] = humanBugs.length;
    summary["openBugsExcluded"] = open.length - humanBugs.length;
    facts.bugs = humanBugs.map((x) => ({ id: x.id, state: x.state, title: x.title }));
    facts.filedBugs = open.map((x) => ({
      id: x.id,
      state: x.state,
      title: x.title,
      agent: isAgentBug(x.labels, x.title),
    }));
    if (open.length === 0) out.push("OPEN BUGS: none in this project.");
    else {
      out.push(
        `OPEN BUGS — ${humanBugs.length} filed by people` +
          (open.length > humanBugs.length
            ? `; ${open.length - humanBugs.length} proposed by this runtime and never confirmed were left out.`
            : "."),
        "Each state asks something different of you:",
      );
      for (const x of humanBugs)
        out.push(`  ${x.key} [${x.state}] ${x.title}`, `    ${jiraStateMeaning(x.state)}`);
      out.push(
        "",
        "For EACH open bug above, say in one line whether it touches THIS story's",
        "behaviour and why. Relevance is your judgement: a bug about a neighbouring",
        "story is not a reason to add a test here, and saying so is a finding.",
      );
    }
  }

  if (frameworkLines.length > 0) out.push("", ...frameworkLines);

  const feature = featurePathFor(facts);
  if (feature && facts.framework?.exists !== false) {
    out.push(
      "",
      `THIS EPIC'S TESTS LIVE IN ONE FILE: ${feature} (and the spec bdd2pw generates`,
      `from it, ${specPathFor(facts)}). Tests follow the application, not the backlog:`,
      "everything on these pages belongs together, where a tester can find it. Add YOUR",
      `story's scenarios to that file, each tagged @story:${id} alongside @ac:<n>,`,
      "@design:<id> and @bug:<id>. Scenarios tagged with another story are that story's:",
      "leave them exactly as they are — a write that drops them is refused, and so is a",
      "write to any other feature or spec path.",
    );
  }

  return { toolName: "aqa.story_context", text: out.join("\n"), summary, facts };
}
