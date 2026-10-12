/**
 * The story reference a person types, as the engine reads it. Kept free of the
 * `vscode` module so it can be tested without an editor.
 *
 * A Jira key (SHOP-12) means Jira; a number (123, #123, AB#123) means Azure
 * DevOps — the same rule as `aqa run`, which decides from the request text.
 */
export type StoryRef = { tracker: "jira"; key: string; label: string } | { tracker: "ado"; id: number; label: string };

export function parseStoryRef(raw: string): StoryRef | undefined {
  const text = raw.trim();
  const jira = /^([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(text);
  if (jira?.[1]) {
    const key = jira[1].toUpperCase();
    return { tracker: "jira", key, label: key };
  }
  const ado = /^(?:AB)?#?(\d+)$/i.exec(text);
  if (ado?.[1]) {
    const id = Number(ado[1]);
    return { tracker: "ado", id, label: `AB#${id}` };
  }
  return undefined;
}

export function requestFor(story: StoryRef): string {
  return story.tracker === "jira" ? `Write tests for ${story.key}` : `Write tests for AB#${story.id}`;
}
