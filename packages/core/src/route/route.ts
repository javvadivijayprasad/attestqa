/**
 * Which path a run takes, decided by code from what is on disk.
 *
 * ── Why this is not the model's decision ──
 * Every run so far began by asking the model to work out what state the project
 * was in: is there a framework, is there a feature file, does a spec already
 * implement this story? It read directories and made a reasonable guess, and
 * when the guess was wrong nothing refused it.
 *
 *   20260925T144905Z — the workspace defaulted to the runtime's own repo, the
 *   survey found `examples/sample-project`, and six tests failed against an
 *   application that was never reachable. Nothing measured anything.
 *
 *   20260925T151945Z — the spec for this epic already existed, implemented and
 *   green the day before. The run rewrote the feature file, scaffolded, and
 *   spent its remaining budget looking for a file bdd2pw had named after the
 *   page object. The suite never ran.
 *
 * Both are routing failures, not reasoning failures. So the route is computed
 * here, from observable state, recorded as a `route` ledger event, and the
 * tools that belong to the path not taken are removed from the model's view —
 * the same argument as everywhere else in this runtime: a capability that is
 * absent cannot be misused, and a decision made in code can be replayed.
 */

import { includesId } from "../design/ids.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  featurePathFor,
  scenarioStoryTags,
  specPathFor,
  storyTestTitles,
  type StoryFacts,
} from "../design/test-design.js";

export type RoutePath = "P0" | "A" | "A2" | "B";

export interface RouteDecision {
  path: RoutePath;
  /** The state that decided it — everything a reader needs to check the call. */
  because: Record<string, unknown>;
  /** One line for the terminal and the ledger. */
  reason: string;
  /** Tools the model may not see on this path. */
  deny: string[];
  /** Set on P0: the run stops, with this as the end summary. */
  stop?: string;
}

/**
 * Tools that only make sense when the automation is being CREATED. Removed on
 * the execute-only path, so "reuse the tests that exist" is a property of the
 * run rather than an instruction the model may weigh.
 *
 * `fs.write_file` is deliberately NOT here, and the reason is the whole point
 * of path B. Denying it took the generator away and the HEALER with it: in
 * 20260925T170138Z the agent read the page, found `Show/hide account menu`,
 * wrote in its own note that the `.catch()` fallback had to go — and could not
 * edit the spec, so it re-read the file until the budget ran out. Repair is not
 * authoring. What path B forbids instead is rewriting the SCENARIOS, which
 * `featureWriteOnExecutePath` refuses by path rather than by tool.
 */
export const AUTHORING_TOOLS = ["bdd2pw.analyze", "bdd2pw.scaffold", "tcg.generate_cases"];

// `fs.write_file` and `fs.replace_in_file` are absent here on purpose: a repair
// on path B is made with them, and what may NOT be rewritten is policed by file
// (`featureWriteOnExecutePath`) rather than by tool.

/** Everything the router needs. All of it is already gathered before the first turn. */
export interface RouteInput {
  facts: StoryFacts | undefined;
  workspaceDir?: string;
  /** Whether stage 0 found a Playwright framework at all. */
  frameworkFound: boolean;
}

export function chooseRoute(input: RouteInput): RouteDecision {
  const { facts, workspaceDir, frameworkFound } = input;

  if (!frameworkFound)
    return {
      path: "P0",
      because: { frameworkFound: false, workspace: workspaceDir ?? "." },
      reason: "no Playwright framework in this workspace",
      deny: [],
      stop:
        "no Playwright framework in this workspace: no playwright.config.ts with tests beside " +
        "it. A run tests automation that exists; creating a framework is a separate, approved " +
        "action (aqa init-framework). If the suite lives elsewhere, point --workspace at it.",
    };

  const featurePath = facts ? featurePathFor(facts) : undefined;
  const specPath = facts ? specPathFor(facts) : undefined;
  const story = facts?.story?.id;
  const featureText = read(workspaceDir, featurePath);
  const specText = read(workspaceDir, specPath);

  const base = { feature: featurePath, spec: specPath, story };

  if (featureText === undefined)
    return {
      path: "A",
      because: { ...base, featureExists: false },
      reason: `no feature file for this epic yet (${featurePath ?? "unknown path"})`,
      deny: [],
    };

  // Scenarios this story owns, by the tags the feature file carries.
  const mine =
    story === undefined
      ? scenarioStoryTags(featureText).map((s) => s.scenario)
      : scenarioStoryTags(featureText)
          .filter((s) => includesId(s.stories, story))
          .map((s) => s.scenario);

  if (mine.length === 0)
    return {
      path: "A2",
      because: { ...base, featureExists: true, storyScenarios: 0 },
      reason: `the feature file exists but has no scenario tagged @story:${story ?? "?"}`,
      deny: [],
    };

  if (specText === undefined)
    return {
      path: "A2",
      because: { ...base, featureExists: true, storyScenarios: mine.length, specExists: false },
      reason: `${mine.length} scenario(s) for this story, but no spec at ${specPath ?? "?"}`,
      deny: [],
    };

  // A scenario is implemented when a test in the spec carries its @story tag.
  // `storyTestTitles` reads those tags out of the generated spec, so this is
  // the same evidence the verifier and the report use.
  const implemented = story === undefined ? new Set<string>() : storyTestTitles(specText, story);
  if (implemented.size === 0)
    return {
      path: "A2",
      because: {
        ...base,
        featureExists: true,
        storyScenarios: mine.length,
        specExists: true,
        implemented: 0,
      },
      reason: `the spec exists but implements no test tagged @story:${story ?? "?"}`,
      deny: [],
    };

  return {
    path: "B",
    because: {
      ...base,
      featureExists: true,
      storyScenarios: mine.length,
      specExists: true,
      implemented: implemented.size,
    },
    reason:
      `${implemented.size} test(s) for this story already exist in ${specPath} — ` +
      "executing them, writing nothing",
    deny: [...AUTHORING_TOOLS],
  };
}

function read(workspaceDir: string | undefined, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const full = isAbsolute(path) ? path : join(workspaceDir ?? ".", path);
  if (!existsSync(full)) return undefined;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The path the runtime chose for a run, read back from its ledger.
 *
 * Rules and checks written for an authoring run have to be able to ask. Three
 * of them refused a repair on path B before this existed.
 */
export function routePathOf(events: Array<{ kind: string; payload: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "route") return String((e.payload as { path?: unknown }).path ?? "");
  }
  return undefined;
}

/**
 * True when this run's tests existed before it started: path B, or the
 * append-only completion a B run is re-routed to when its design adds items.
 * Rules that say "scaffold first" do not apply to such a run — the generator
 * would regenerate tests that already work, so new tests are written by hand
 * beside them (and `appendOnlySpec` polices how).
 */
export function testsPreExisted(events: Array<{ kind: string; payload: unknown }>): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== "route") continue;
    const p = e.payload as { path?: unknown; because?: { from?: unknown } };
    return p.path === "B" || p.because?.from === "B";
  }
  return false;
}

/** One line for the terminal. */
export function renderRoute(d: RouteDecision): string {
  const label: Record<RoutePath, string> = {
    P0: "stop",
    A: "author",
    A2: "complete",
    B: "execute existing tests",
  };
  return `route ${d.path} (${label[d.path]}): ${d.reason}`;
}
