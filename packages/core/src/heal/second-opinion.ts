import {
  DEFAULT_CONFIG,
  Ranker,
  descriptorToMeta,
  intentBoost,
  type CandidateElement,
  type LocatorDescriptor,
  type LocatorKind,
} from "@vijaypjavvadi/pw-self-heal";
import type { LocatorCandidate } from "./locator.js";

/**
 * A second, independent ranking of the same candidates, by pw-self-heal's
 * trained-feature heuristic — suggest-only.
 *
 * ── Why a second opinion, and why it decides nothing ──
 * attestqa's own ranker (`rankCandidates`) matches words and accessible names.
 * pw-self-heal scores 17 similarity features plus the locator's intent, and is
 * the published, benchmarked ranker. Running both over the SAME candidates
 * from the SAME snapshot lets each heal record whether two methods agree —
 * which is the before/after comparison Paper I needs, gathered on every heal
 * instead of in a separate study.
 *
 * It never applies anything. pw-self-heal's runtime mode retries the action
 * against the healed element inside the test; under governance that would be
 * a change nobody approved and the ledger never saw. So only its ranking is
 * used, in `heuristic` mode (no model file, no native dependency, the same
 * answer on every machine), and the repair stays an ordinary spec write that
 * the story rules police.
 *
 * The candidates come from Playwright's accessibility snapshot, which carries
 * a role and a name and nothing else — no id, class or depth. So the features
 * that read markup score nothing here, and the comparison is between two ways
 * of reading the same accessible surface. That limit is recorded with every
 * result rather than hidden.
 */
export interface SecondOpinion {
  ranker: "pw-self-heal";
  mode: "heuristic";
  /** The candidate pw-self-heal ranks first, as a Playwright expression. */
  best?: string;
  /** Its blended score in [0,1]. */
  score?: number;
  /** pw-self-heal's acceptance threshold; below it, pw-self-heal would not heal. */
  threshold: number;
  /** Whether pw-self-heal would heal at all with this evidence. */
  wouldHeal: boolean;
  /** Whether its first choice is attestqa's first choice. */
  agrees: boolean;
  ranked: Array<{ expression: string; score: number; intent: number }>;
  limitation: string;
}

const LIMITATION =
  "ranked from the accessibility snapshot only (role and name) — the markup features " +
  "pw-self-heal also uses (id, class, depth, parent) were not available";

/** The element a role is usually rendered as; the model's tag feature needs one. */
const TAG: Record<string, string> = {
  button: "button",
  link: "a",
  textbox: "input",
  searchbox: "input",
  checkbox: "input",
  radio: "input",
  switch: "input",
  slider: "input",
  spinbutton: "input",
  combobox: "select",
  option: "option",
  menuitem: "button",
  menuitemcheckbox: "button",
  menuitemradio: "button",
  tab: "button",
};

/** What the failed selector was asking for, in pw-self-heal's vocabulary. */
export function descriptorOf(selector: string): LocatorDescriptor {
  const role = /getByRole\(\s*['"`]([\w-]+)['"`](?:\s*,\s*\{[^}]*name:\s*(['"`])(.+?)\2)?/.exec(
    selector,
  );
  if (role?.[1]) return { kind: "role", value: role[1], options: role[3] ? { name: role[3] } : {} };
  const by: Array<[RegExp, LocatorKind]> = [
    [/getByTestId\(\s*(['"`])(.+?)\1/, "testid"],
    [/getByLabel\(\s*(['"`])(.+?)\1/, "label"],
    [/getByText\(\s*(['"`])(.+?)\1/, "text"],
    [/getByPlaceholder\(\s*(['"`])(.+?)\1/, "placeholder"],
    [/getByAltText\(\s*(['"`])(.+?)\1/, "altText"],
    [/getByTitle\(\s*(['"`])(.+?)\1/, "title"],
  ];
  for (const [re, kind] of by) {
    const m = re.exec(selector);
    if (m?.[2]) return { kind, value: m[2] };
  }
  const css = /locator\(\s*(['"`])(.+?)\1/.exec(selector);
  return { kind: css?.[2]?.startsWith("//") ? "xpath" : "css", value: css?.[2] ?? selector };
}

function elementOf(c: LocatorCandidate): CandidateElement {
  return {
    tag: TAG[c.role] ?? "",
    text: c.name,
    element_id: "",
    name: "",
    class_name: "",
    placeholder: c.role === "textbox" || c.role === "searchbox" ? c.name : "",
    aria_label: c.name,
    type_attr: c.role === "checkbox" || c.role === "radio" ? c.role : "",
    value_attr: "",
    parent_tag: "",
    dom_depth: 0,
    sibling_count: 0,
    role: c.role,
    acc_name: c.name,
  };
}

/**
 * pw-self-heal's ranking of `candidates` for `failedSelector`, or undefined
 * when there is nothing to rank. Never throws: a second opinion that fails is
 * simply absent, and the heal goes on with attestqa's own ranking.
 */
export async function secondOpinion(
  failedSelector: string,
  candidates: LocatorCandidate[],
  ours: LocatorCandidate | undefined,
): Promise<SecondOpinion | undefined> {
  if (!failedSelector || candidates.length === 0) return undefined;
  try {
    const desc = descriptorOf(failedSelector);
    const meta = descriptorToMeta(desc, DEFAULT_CONFIG.testIdAttribute);
    const elements = candidates.map(elementOf);
    // The Ranker reads and scores only; telemetry is written by the page wrapper, which is not used.
    const ranker = new Ranker({ ...DEFAULT_CONFIG, mode: "heuristic", topK: elements.length });
    const result = await ranker.rank(meta, elements);
    const byElement = new Map(elements.map((e, i) => [e, candidates[i]]));
    const ranked = result.topCandidates
      .map((s) => {
        const c = byElement.get(s.candidate);
        return c
          ? {
              expression: c.expression,
              score: round(s.finalScore),
              intent: round(intentBoost(desc, s.candidate)),
            }
          : undefined;
      })
      .filter((x): x is { expression: string; score: number; intent: number } => x !== undefined);
    const best = ranked[0];
    return {
      ranker: "pw-self-heal",
      mode: "heuristic",
      ...(best ? { best: best.expression, score: best.score } : {}),
      threshold: result.thresholdUsed,
      wouldHeal: result.healed,
      agrees: !!best && !!ours && best.expression === ours.expression,
      ranked,
      limitation: LIMITATION,
    };
  } catch {
    return undefined;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
