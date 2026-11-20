import { isAbsolute } from "node:path";

/**
 * Why a path in `agent.knowledge.paths` cannot be used, or undefined.
 *
 * On its own page because the config loader needs it and must not pull in the
 * index builder to get it. A document folder is inside the workspace: the
 * config is committed, and a path that leaves the checkout would index
 * whatever is on the machine that runs it.
 */
export function knowledgePathProblem(p: string): string | undefined {
  if (p.trim() === "") return "is empty";
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("\\\\"))
    return "must be relative to the workspace";
  if (p.split(/[\\/]/).includes("..")) return 'must stay inside the workspace (no "..")';
  return undefined;
}
