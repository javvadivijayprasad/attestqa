import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Stage 0: what test framework is already in this repository.
 *
 * ── Why this exists ──
 * Every path in this runtime used to be a constant: features/, tests/, pages/,
 * a playwright.config.ts written to our own conventions. That is true of the
 * sandbox because we built the sandbox. In anyone else's repository it is
 * either wrong or absent, and a run that assumes it will scatter files into a
 * layout nobody uses — or invent a project structure as a side effect of
 * "write tests for story 1", which is not a decision an agent gets to make.
 *
 * So the runtime looks first, deterministically, and every later rule derives
 * its paths from what it found. Where the repository has conventions, the run
 * conforms to them; where it has none, the run stops and says so rather than
 * improvising one.
 *
 * ── What this is not ──
 * It is a survey, not an interpreter. `playwright.config.ts` is TypeScript and
 * may compute its values; reading it with regular expressions recovers the
 * common cases and nothing more. Everything here is reported as "what I could
 * see", carries `confident: false` when it was guessed, and is put in front of
 * the agent as observation rather than fact.
 */

export interface FrameworkProfile {
  /** False when there is no Playwright framework here at all. */
  exists: boolean;
  /** Playwright config files found, workspace-relative. More than one is a monorepo or a mistake. */
  configs: string[];
  /** testDir as the config states it, when it could be read. */
  testDir?: string;
  /** baseURL as the config states it (or the env var it reads). */
  baseURL?: string;
  /** The attribute getByTestId reads, when the config changes it from data-testid. */
  testIdAttribute?: string;
  /** Where specs actually live — from testDir, else the commonest directory of the specs found. */
  specDir: string;
  /** ".spec.ts" or ".test.ts", whichever the existing specs use. */
  specSuffix: string;
  /** Where .feature files live, when the project has a BDD layer. */
  featureDir?: string;
  /** Where page objects live, when the project has any. */
  pageObjectDir?: string;
  /**
   * A module the specs import `test` from instead of "@playwright/test" — a
   * fixtures file. A spec that bypasses it is not in this project's style.
   */
  fixtureModule?: string;
  /** Existing spec files, workspace-relative. */
  specs: string[];
  /** Existing .feature files, workspace-relative. */
  features: string[];
  /** Dependency names from package.json (dependencies + devDependencies). */
  deps: string[];
  /** package.json scripts that run the suite. */
  testScripts: Record<string, string>;
  /** Environment variables the config reads — how this project is told where to point. */
  envNames: string[];
  /** Where a value was guessed rather than read. */
  guessed: string[];
}

const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/i;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".aqa",
  ".aqa-report",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".scratch-bdd2pw",
  "_to_delete",
]);

export function surveyFramework(workspaceDir: string): FrameworkProfile {
  const files = walk(workspaceDir);
  const rel = (p: string) => relative(workspaceDir, p).split(sep).join("/");
  const guessed: string[] = [];

  const allConfigs = files
    .map(rel)
    .filter((p) => /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(p))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  // The project's config is the one nearest the root. The others are examples,
  // fixtures or templates that happen to live in the repository — and in
  // 20260923T221508Z one of them (examples/sandbox/playwright.config.ts) was
  // taken for the project's own, which sent the whole run into a sample app.
  const chosen = allConfigs[0];
  const root = chosen ? dirOf(chosen) : "";
  const otherConfigDirs = allConfigs.slice(1).map(dirOf);
  if (allConfigs.length > 1)
    guessed.push(
      `chose ${chosen} as this project's config (the one nearest the root); also found ${allConfigs
        .slice(1)
        .join(", ")} and ignored ${allConfigs.length > 2 ? "them" : "it"}`,
    );

  const inScope = (p: string): boolean =>
    (root === "" || p.startsWith(`${root}/`)) &&
    !otherConfigDirs.some((d) => d !== "" && p.startsWith(`${d}/`));

  const configText = chosen ? read(join(workspaceDir, chosen)) : undefined;
  const testDir = configText
    ? firstMatch(configText, /testDir\s*:\s*["'`]([^"'`]+)["'`]/)
    : undefined;
  // Toolshop marks its elements with data-test; told nothing, the agent guessed
  // CSS for the price five times (20261018T154651Z).
  const testIdAttribute =
    configText === undefined
      ? undefined
      : firstMatch(configText, /testIdAttribute\s*:\s*["'`]([^"'`]+)["'`]/);
  const baseURL =
    configText &&
    (firstMatch(configText, /baseURL\s*:\s*["'`]([^"'`]+)["'`]/) ??
      firstMatch(configText, /baseURL\s*:[^,\n]*process\.env\[?["'`]([A-Z0-9_]+)/));

  // A PLAYWRIGHT spec, not any file named like a test. This repository's own
  // unit tests (test/*.test.ts, run by vitest) were counted as 27 specs before
  // this check existed.
  const specs = files
    .map(rel)
    .filter((p) => SPEC.test(p) && inScope(p))
    .filter((p) => {
      const t = read(join(workspaceDir, p)) ?? "";
      return (
        /@playwright\/test/.test(t) ||
        (!!testDir && p.startsWith(`${under(root, clean(testDir) ?? "")}/`))
      );
    });

  const features = files.map(rel).filter((p) => /\.feature$/i.test(p) && inScope(p));
  const pageObjects = files.map(rel).filter((p) => /\.page\.[cm]?[jt]sx?$/i.test(p) && inScope(p));

  let specDir = clean(testDir) ? under(root, clean(testDir)!) : undefined;
  if (!specDir) {
    specDir = commonestDir(specs) ?? under(root, "tests");
    guessed.push(`specDir (${specDir}) — from where the specs are, not from the config`);
  }

  const specSuffix =
    specs.some((s) => /\.test\.[cm]?[jt]sx?$/i.test(s)) && !specs.some((s) => /\.spec\./i.test(s))
      ? ".test.ts"
      : ".spec.ts";

  const featureDir = commonestDir(features);
  const pageObjectDir = commonestDir(pageObjects);

  const fixtureModule = files
    .map(rel)
    .filter((p) => /\.(ts|js)$/.test(p) && !SPEC.test(p) && inScope(p))
    .find((p) => {
      const t = read(join(workspaceDir, p));
      return !!t && /@playwright\/test/.test(t) && /\btest\b/.test(t) && /extend\s*[<(]/.test(t);
    });

  const pkg = readJson(join(workspaceDir, under(root, "package.json")));
  const deps = [
    ...Object.keys((pkg?.["dependencies"] as Record<string, unknown>) ?? {}),
    ...Object.keys((pkg?.["devDependencies"] as Record<string, unknown>) ?? {}),
  ];
  const scripts = (pkg?.["scripts"] as Record<string, string>) ?? {};
  const testScripts = Object.fromEntries(
    Object.entries(scripts).filter(([, v]) => /playwright/i.test(String(v))),
  );

  const envNames = configText
    ? [
        ...new Set(
          [...configText.matchAll(/process\.env\[?["'`]([A-Z0-9_]+)["'`]?\]?/g)].map(
            (m) => m[1] ?? "",
          ),
        ),
      ].filter(Boolean)
    : [];

  return {
    exists: allConfigs.length > 0 || specs.length > 0,
    configs: chosen ? [chosen] : [],
    ...(testDir ? { testDir } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(testIdAttribute ? { testIdAttribute } : {}),
    specDir,
    specSuffix,
    ...(featureDir ? { featureDir } : {}),
    ...(pageObjectDir ? { pageObjectDir } : {}),
    ...(fixtureModule ? { fixtureModule } : {}),
    specs,
    features,
    deps,
    testScripts,
    envNames,
    guessed,
  };
}

function depth(p: string): number {
  return p.split("/").length;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** A path under the project root, which is "" when the config is at the top. */
function under(root: string, p: string): string {
  return root ? `${root}/${p}` : p;
}

/** The profile as the agent reads it, in the stage-1 digest. */
export function renderProfile(p: FrameworkProfile): string[] {
  if (!p.exists) {
    return [
      "TEST FRAMEWORK: none found in this workspace.",
      "  No playwright config and no spec files. Creating a framework — its layout, its",
      "  fixtures, its scripts — is a decision about someone's repository and is not part",
      "  of writing tests for a story. Stop and report that a Playwright project has to be",
      "  set up first (npm init playwright@latest). Do not invent a layout.",
    ];
  }
  const out = [
    "TEST FRAMEWORK — what this repository already uses. Conform to it; it is not yours to",
    "reorganise, rename or replace.",
    `  config: ${p.configs.join(", ") || "(none found)"}`,
    `  specs live in: ${p.specDir}/ (${p.specs.length} spec file(s), named *${p.specSuffix})`,
  ];
  if (p.testDir) out.push(`  testDir from the config: ${p.testDir}`);
  if (p.featureDir) out.push(`  .feature files live in: ${p.featureDir}/ (${p.features.length})`);
  if (p.pageObjectDir) out.push(`  page objects live in: ${p.pageObjectDir}/`);
  if (p.fixtureModule)
    out.push(
      `  this project has its own test fixture: ${p.fixtureModule}`,
      `    import { test, expect } from its path — NOT from "@playwright/test".`,
    );
  if (p.baseURL)
    out.push(`  baseURL: ${p.baseURL} — navigate with relative paths and let the config decide`);
  if (p.testIdAttribute)
    out.push(
      `  testIdAttribute: ${p.testIdAttribute} — this app marks elements with ${p.testIdAttribute}="…"; ` +
        `page.getByTestId("x") finds [${p.testIdAttribute}="x"]`,
    );
  if (p.envNames.length > 0) out.push(`  the config reads: ${p.envNames.join(", ")}`);
  if (Object.keys(p.testScripts).length > 0)
    out.push(
      `  scripts: ${Object.entries(p.testScripts)
        .map(([k, v]) => `${k} = ${v}`)
        .join("; ")}`,
    );
  out.push(
    `  installed test packages you may import: ${p.deps.join(", ") || "(none read)"}`,
    "    A package that is not there is NOT available: say so as a limitation rather than",
    "    importing it — a spec that imports what is not installed fails as a module error and",
    "    tells the reader nothing about the product.",
  );
  if (p.guessed.length > 0) out.push(`  guessed, so check it: ${p.guessed.join("; ")}`);
  return out;
}

/** Packages a spec imports that the project does not have installed. */
export function missingImports(specText: string, p: FrameworkProfile): string[] {
  const out = new Set<string>();
  for (const m of specText.matchAll(/(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) {
    const spec = m[1] ?? "";
    if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
    const pkg = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : (spec.split("/")[0] ?? "");
    if (pkg && !p.deps.includes(pkg)) out.add(pkg);
  }
  return [...out];
}

// ---------------------------------------------------------------- helpers

function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, depth + 1, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string | undefined {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function readJson(p: string): Record<string, unknown> | undefined {
  const t = read(p);
  if (!t) return undefined;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function firstMatch(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}

/** "./e2e" and "e2e/" both mean e2e. */
function clean(dir?: string): string | undefined {
  if (!dir) return undefined;
  const d = dir.replace(/^\.\//, "").replace(/\/$/, "");
  return d === "." || d === "" ? undefined : d;
}

/** The directory most of these files are in. */
function commonestDir(paths: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const dir = i === -1 ? "." : p.slice(0, i);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [dir, c] of counts) {
    if (c > n) {
      best = dir;
      n = c;
    }
  }
  return best === "." ? undefined : best;
}
