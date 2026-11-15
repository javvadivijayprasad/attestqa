/**
 * An in-place edit, read the way `fs.replace_in_file` applies it — for the
 * tool itself and for everything that replays an edit from the ledger or
 * judges one before it runs. One reading, so the rules and the tool cannot
 * disagree about what an edit does.
 */

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `old` as a pattern: each line break matches CRLF or LF. */
const across = (old: string) => escapeRegExp(old.replace(/\r\n/g, "\n")).replace(/\n/g, "\\r?\\n");

/** Mask tokens the scrub writes into what the model sees, and what each stands for. */
const MASK_PATTERNS: Array<[string, string]> = [
  ["[EMAIL]", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"],
  ["[IP]", "(?:\\d{1,3}\\.){3}\\d{1,3}"],
];

/**
 * `old` with mask tokens resolved against the file: the one place in the file
 * that matches `old` with each token read as the value it hides. Returns the
 * literal `old` and `new` to use, or undefined when `old` has no token, matches
 * the file as it is, or matches it in no place or in several.
 */
export function unmask(
  text: string,
  before: string,
  after: string,
): { before: string; after: string } | undefined {
  const used = MASK_PATTERNS.filter(([token]) => before.includes(token));
  if (used.length === 0 || text.includes(before)) return undefined;
  let source = "";
  let rest = before;
  const order: string[] = [];
  while (rest.length > 0) {
    let at = -1;
    let hit: [string, string] | undefined;
    for (const m of used) {
      const i = rest.indexOf(m[0]);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = m;
      }
    }
    if (!hit) {
      source += across(rest);
      break;
    }
    // Line breaks in `old` match CRLF or LF here too: a rule reads the file
    // with LF, the tool reads it as it is on disk, and both must find the place.
    source += across(rest.slice(0, at)) + "(" + hit[1] + ")";
    order.push(hit[0]);
    rest = rest.slice(at + hit[0].length);
  }
  const matches = [...text.matchAll(new RegExp(source, "g"))];
  if (matches.length !== 1) return undefined;
  const m = matches[0]!;
  // Each token in `new` becomes the value its first occurrence in `old` stood for.
  const values = new Map<string, string>();
  order.forEach((token, i) => {
    if (!values.has(token)) values.set(token, m[i + 1] ?? token);
  });
  let next = after;
  for (const [token, value] of values) next = next.split(token).join(value);
  return { before: m[0], after: next };
}

/**
 * `text` after the edit: each line break in `old` matches CRLF or LF, `new`
 * goes in with the text's own line ending, and a mask token in `old` stands
 * for the value it hides. Undefined when `old` is not in the text.
 *
 * The tool has matched across line endings since F-0137 and resolved mask
 * tokens since 20261024T182800Z; the places that replay an edit compared
 * bytes. On a file checked out with CRLF and an edit written with LF
 * (20261115T004103Z) the replay found nothing: the run had "no view" of a spec
 * it had just edited, and "no edit" of a test it had just changed. And an edit
 * whose `old` held "[IP]" could not be turned into the write it amounts to, so
 * no write rule looked at it at all (20261115T124325Z: eight edits to another
 * story's tests went through).
 */
export function applyEdit(
  text: string,
  old: string,
  next: string,
  all = false,
): string | undefined {
  if (old === "") return undefined;
  const resolved = unmask(text, old, next);
  if (resolved) ({ before: old, after: next } = resolved);
  const pattern = across(old);
  if (!new RegExp(pattern).test(text)) return undefined;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const written = next.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  // A function replacer: `$&` or `$1` in the new text is text, not a pattern.
  return text.replace(new RegExp(pattern, all ? "g" : ""), () => written);
}

/** How many places in `text` the edit's `old` matches, read the same way. */
export function editHits(text: string, old: string, next = ""): number {
  if (old === "") return 0;
  const resolved = unmask(text, old, next);
  if (resolved) old = resolved.before;
  return (text.match(new RegExp(across(old), "g")) ?? []).length;
}
