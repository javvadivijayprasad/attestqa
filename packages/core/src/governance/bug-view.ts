import { asRecord } from "../verify/evidence.js";

/** The label every bug this runtime files carries (verify/story-to-tests AGENT_TAG). */
const AGENT_TAG = "agentic-qa";

/**
 * One shape for a proposed Bug, whichever tracker it is going to.
 *
 * Every rule about bugs — held until the run ends, never shared with another
 * approval, refused while triage says the environment was down, refused as a
 * duplicate, refused when it claims what its test does not show — was written
 * against `ado.wit_work_item_write` with workItemType "Bug". A Jira bug must
 * meet exactly the same rules, and the safe way to guarantee that is not to
 * copy each rule but to show each rule the Jira call in the shape it already
 * checks: summary as the title, description as the repro steps, storyKey as
 * the parent, and the label the adapter always adds as the tag.
 *
 * This is a view for judging the call. It is never what is sent: the gate,
 * the approval and the ledger keep the call the model actually proposed.
 *
 * From 2.5.0 there are two views here. The refusal rules in
 * `skills/story-rules.ts` read `proposedBug`, which names no tracker. The
 * end-of-run settlement and the approval prompt still read `asAdoBug`, the
 * older view that dresses a Jira bug as an Azure DevOps one; they move to
 * `proposedBug` in their own change.
 */
export interface CallLike {
  toolName: string;
  args: Record<string, unknown>;
}

export const ADO_BUG_TOOL = "ado.wit_work_item_write";
export const JIRA_BUG_TOOL = "jira.create_bug";

/** A proposal to create a Bug, in either tracker. */
export function isBugCreate(call: CallLike): boolean {
  if (call.toolName === JIRA_BUG_TOOL) return true;
  return (
    call.toolName === ADO_BUG_TOOL &&
    call.args["action"] === "create" &&
    call.args["workItemType"] === "Bug"
  );
}

/**
 * A proposed Bug in words that belong to no tracker.
 *
 * The rules in `skills/story-rules.ts` judge this and nothing else about a bug:
 * they do not name a tool, a work item type or a field. Adding a tracker means
 * adding a branch to `proposedBug`, not reading every rule.
 */
export interface ProposedBug {
  /** Which tracker the run is writing to, so a refusal can name the agent's own argument. */
  tracker: "ado" | "jira";
  /** The title, wherever the model put it. Empty when there is none. */
  title: string;
  /** The steps to reproduce as written: HTML from Azure DevOps, text from Jira. Empty when there are none. */
  repro: string;
  /** The story the bug is linked to, as the call gives it; undefined when it gives none. */
  story: unknown;
  /** The tags or labels the tracker will hold, as the call gives them. */
  tags: unknown;
}

/** One named field of an Azure DevOps write, from either form of `fields` (a list of name/value, or an object). */
export function fieldValue(
  call: { args: Record<string, unknown> },
  name: string,
): string | undefined {
  const f = call.args["fields"];
  if (Array.isArray(f)) {
    for (const e of f) {
      const r = asRecord(e);
      if (r?.["name"] === name) return String(r["value"] ?? "");
    }
  }
  const v = asRecord(f)?.[name];
  return typeof v === "string" ? v : undefined;
}

/** The call as a proposed Bug, or undefined when it is not a proposal to create one. */
export function proposedBug(call: CallLike): ProposedBug | undefined {
  const a = call.args;
  if (call.toolName === JIRA_BUG_TOOL) {
    // The adapter adds the label to every Bug it creates, whatever the model
    // passes, so a rule asking "is it tagged?" gets the answer the tracker will hold.
    const labels = Array.isArray(a["labels"]) ? a["labels"].map(String) : [];
    return {
      tracker: "jira",
      title: typeof a["summary"] === "string" ? a["summary"] : "",
      repro: typeof a["description"] === "string" ? a["description"] : "",
      story: a["storyKey"],
      tags: [...new Set([AGENT_TAG, ...labels])].join("; "),
    };
  }
  if (call.toolName !== ADO_BUG_TOOL || a["action"] !== "create") return undefined;
  if (String(a["workItemType"] ?? "") !== "Bug") return undefined;
  return {
    tracker: "ado",
    title: String(a["title"] ?? fieldValue(call, "System.Title") ?? ""),
    repro: fieldValue(call, "Microsoft.VSTS.TCM.ReproSteps") ?? "",
    story: a["parentId"],
    tags: a["tags"] ?? fieldValue(call, "System.Tags"),
  };
}

/**
 * A tracker item as its own tracker writes it: "#83" for an Azure DevOps id,
 * the key alone ("TOOL-83") for Jira. A refusal that says "#TOOL-83" names
 * nothing a Jira user can search for.
 */
export function itemRef(id: number | string): string {
  return /^\d+$/.test(String(id)) ? `#${id}` : String(id);
}

/** The call as the Azure DevOps bug rules expect to see it. Non-Jira calls come back unchanged. */
export function asAdoBug<T extends CallLike>(call: T): T {
  if (call.toolName !== JIRA_BUG_TOOL) return call;
  const a = call.args;
  const title = typeof a["summary"] === "string" ? a["summary"] : "";
  const repro = typeof a["description"] === "string" ? a["description"] : "";
  // The adapter adds the label to every Bug it creates, whatever the model
  // passes — so the view carries it too, and a rule asking "is it tagged?"
  // gets the answer the tracker will hold.
  const labels = Array.isArray(a["labels"]) ? a["labels"].map(String) : [];
  const tags = [...new Set([AGENT_TAG, ...labels])].join("; ");
  return {
    ...call,
    toolName: ADO_BUG_TOOL,
    args: {
      action: "create",
      workItemType: "Bug",
      title,
      parentId: a["storyKey"],
      tags,
      ...(a["projectKey"] !== undefined ? { project: a["projectKey"] } : {}),
      fields: {
        "System.Title": title,
        "Microsoft.VSTS.TCM.ReproSteps": repro,
        "System.Tags": tags,
      },
    },
  };
}
