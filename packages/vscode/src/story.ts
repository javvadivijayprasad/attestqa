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

/**
 * The story named somewhere in a sentence typed into Copilot Chat:
 * "write tests for SCRUM-6", "AB#44", "story #44". A bare number counts only
 * when it is the one number in the text, so "add 3 tests for SHOP-12" reads
 * SHOP-12 and "write 2 tests" reads nothing.
 */
export function findStoryRef(text: string): StoryRef | undefined {
  const jira = /\b([A-Za-z][A-Za-z0-9_]*-\d+)\b/.exec(text);
  if (jira?.[1]) return parseStoryRef(jira[1]);
  const tagged = /(?:\bAB)?#(\d+)\b/i.exec(text);
  if (tagged?.[1]) return parseStoryRef(tagged[1]);
  const numbers = text.match(/\b\d+\b/g) ?? [];
  if (numbers.length === 1 && /\b(story|item|work item|tests? for|ado)\b/i.test(text)) return parseStoryRef(numbers[0] as string);
  return undefined;
}
