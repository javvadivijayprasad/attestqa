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
