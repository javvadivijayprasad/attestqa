import { createHash } from "node:crypto";

/**
 * A project document cut into passages (ADR-008 §4).
 *
 * A passage is what a search returns and what a design item cites, so three
 * things are fixed here and nowhere else: where a document is cut, how long a
 * passage may be, and what its id is. Change any of them and every recorded
 * citation stops matching — which is why the manifest records
 * `CHUNKER_VERSION`, and why this number goes up with any such change.
 */
export const CHUNKER_VERSION = 1;

/** The most a passage holds. A search returns five, so this is the budget. */
export const PASSAGE_CHARS = 1200;

export interface Passage {
  /** `<file>#<heading slug>@<first 8 hex of the content hash>`. */
  id: string;
  /** Workspace-relative, forward slashes. */
  file: string;
  /** The headings above the passage, outermost first. Empty before the first heading. */
  heading: string[];
  /** First and last line in the file, counted from 1. */
  lines: [number, number];
  /** When the file was last modified (ISO 8601), so a reader can see age. */
  modified: string;
  /** sha256 of `text`. */
  hash: string;
  text: string;
}

/** A heading as it appears in a passage id. */
export function headingSlug(heading: string): string {
  return heading
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function passageId(file: string, heading: readonly string[], hash: string): string {
  const last = heading[heading.length - 1];
  return `${file}#${(last ? headingSlug(last) : "") || "top"}@${hash.slice(0, 8)}`;
}

interface Unit {
  first: number;
  last: number;
  text: string;
}

/** An ATX heading: one to six `#`, a space, the title, an optional closing run. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The passages of one document.
 *
 * Markdown is cut at its headings (`#` to `######`; a `#` inside a fenced code
 * block is code). Plain text has no headings: it is one section. A section
 * longer than `PASSAGE_CHARS` is cut between paragraphs; a paragraph longer
 * than that between lines; a line longer than that at a space. A heading with
 * nothing under it gives no passage.
 */
export function passagesOf(
  file: string,
  content: string,
  modified: string,
  markdown = true,
): Passage[] {
  const lines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: Passage[] = [];
  const seen = new Set<string>();
  const stack: Array<{ level: number; title: string }> = [];
  let units: Unit[] = [];
  let para: Unit | undefined;
  let fence: string | undefined;

  const closePara = (): void => {
    if (para) units.push(...fit(para));
    para = undefined;
  };
  const closeSection = (): void => {
    closePara();
    const heading = stack.map((h) => h.title);
    for (const chunk of pack(units)) {
      const hash = createHash("sha256").update(chunk.text).digest("hex");
      const id = passageId(file, heading, hash);
      // The same words under the same heading twice are one passage.
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        file,
        heading,
        lines: [chunk.first, chunk.last],
        modified,
        hash,
        text: chunk.text,
      });
    }
    units = [];
  };

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\s+$/, "");
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      // Inside a code block every line is content, blank ones included.
      if (mark && mark.startsWith(fence) && line.trim() === mark) fence = undefined;
      para = para ? { ...para, last: n, text: `${para.text}\n${line}` } : unit(n, line);
      return;
    }
    const h = markdown ? HEADING.exec(line) : null;
    if (h) {
      closeSection();
      const level = (h[1] ?? "").length;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title: (h[2] ?? "").trim() });
      return;
    }
    if (markdown && mark) fence = mark;
    if (line.trim() === "") return closePara();
    para = para ? { ...para, last: n, text: `${para.text}\n${line}` } : unit(n, line);
  });
  closeSection();
  return out;
}

function unit(n: number, text: string): Unit {
  return { first: n, last: n, text };
}

/** One paragraph as units no longer than the limit: whole, else by line, else by word. */
function fit(p: Unit): Unit[] {
  if (p.text.length <= PASSAGE_CHARS) return [p];
  const out: Unit[] = [];
  let cur: Unit | undefined;
  p.text.split("\n").forEach((line, i) => {
    const n = p.first + i;
    for (const piece of cut(line)) {
      if (cur && cur.text.length + 1 + piece.length <= PASSAGE_CHARS) {
        cur = { ...cur, last: n, text: `${cur.text}\n${piece}` };
      } else {
        if (cur) out.push(cur);
        cur = unit(n, piece);
      }
    }
  });
  if (cur) out.push(cur);
  return out;
}

/** A line as pieces no longer than the limit, cut at the last space that fits. */
function cut(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > PASSAGE_CHARS) {
    const at = rest.lastIndexOf(" ", PASSAGE_CHARS);
    const end = at > 0 ? at : PASSAGE_CHARS;
    out.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Consecutive units joined while they fit, a blank line between paragraphs. */
function pack(units: readonly Unit[]): Unit[] {
  const out: Unit[] = [];
  let cur: Unit | undefined;
  for (const u of units) {
    if (u.text.trim() === "") continue;
    if (cur && cur.text.length + 2 + u.text.length <= PASSAGE_CHARS) {
      cur = { ...cur, last: u.last, text: `${cur.text}\n\n${u.text}` };
    } else {
      if (cur) out.push(cur);
      cur = u;
    }
  }
  if (cur) out.push(cur);
  return out;
}
