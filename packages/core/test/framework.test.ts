import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyFramework, renderProfile, missingImports } from "../src/framework/survey.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import { featurePathFor, specPathFor } from "../src/design/test-design.js";
import type { AnyRunEvent } from "../src/types.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aqa-fw-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

describe("stage 0 — survey the framework that is already there", () => {
  it("reads a project that keeps its specs in e2e/ with its own fixture", () => {
    const dir = repo({
      "playwright.config.ts":
        'export default defineConfig({ testDir: "./e2e", use: { baseURL: process.env["APP_URL"] } });',
      "e2e/checkout.spec.ts": 'import { test } from "../support/fixtures";',
      "e2e/login.spec.ts": 'import { test } from "../support/fixtures";',
      "support/fixtures.ts": 'import { test as base } from "@playwright/test";\nexport const test = base.extend<{}>({});',
      "package.json": JSON.stringify({
        scripts: { e2e: "playwright test" },
        devDependencies: { "@playwright/test": "^1.63.0" },
      }),
    });
    const p = surveyFramework(dir);
    expect(p.exists).toBe(true);
    expect(p.specDir).toBe("e2e");
    expect(p.testDir).toBe("./e2e");
    expect(p.baseURL).toBe("APP_URL");
    expect(p.fixtureModule).toBe("support/fixtures.ts");
    expect(p.specs).toHaveLength(2);
    expect(p.testScripts).toEqual({ e2e: "playwright test" });
    expect(renderProfile(p).join("\n")).toContain("support/fixtures.ts");
  });

  it("ignores an example project inside the repository, and the repo's own unit tests", () => {
    // 20260923T221508Z: examples/sandbox/playwright.config.ts was taken for
    // this project's config, and test/*.test.ts (vitest) counted as 27 specs.
    const dir = repo({
      "playwright.config.ts": 'export default defineConfig({ testDir: "tests" });',
      "tests/epic-42.spec.ts": 'import { test } from "@playwright/test";',
      "features/epic-42.feature": "Feature: x",
      "pages/login.page.ts": "export class LoginPage {}",
      "test/unit.test.ts": 'import { describe } from "vitest";',
      "examples/sandbox/playwright.config.ts": 'export default defineConfig({ testDir: "tests", use: { baseURL: "http://localhost:3000" } });',
      "examples/sandbox/tests/login.spec.ts": 'import { test } from "@playwright/test";',
      "examples/sandbox/features/login.feature": "Feature: sample",
      "examples/sandbox/pages/login.page.ts": "export class LoginPage {}",
      "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }),
    });
    const p = surveyFramework(dir);
    expect(p.configs).toEqual(["playwright.config.ts"]);
    expect(p.specDir).toBe("tests");
    expect(p.specs).toEqual(["tests/epic-42.spec.ts"]);
    expect(p.featureDir).toBe("features");
    expect(p.pageObjectDir).toBe("pages");
    expect(p.guessed.join(" ")).toContain("examples/sandbox/playwright.config.ts");
  });

  it("says plainly when there is no framework at all", () => {
    const p = surveyFramework(repo({ "README.md": "# app" }));
    expect(p.exists).toBe(false);
    expect(renderProfile(p).join("\n")).toContain("aqa init-framework");
  });

  it("names the packages a file imports that the project does not have", () => {
    const p = surveyFramework(
      repo({ "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }) }),
    );
    const spec = 'import { test } from "@playwright/test";\nimport AxeBuilder from "@axe-core/playwright";\nimport { x } from "./helper";';
    expect(missingImports(spec, p)).toEqual(["@axe-core/playwright"]);
  });
});

describe("the run conforms to that framework", () => {
  const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
  let n = 0;
  const preflight = (framework: unknown, exists = true): AnyRunEvent[] => {
    const id = ++n;
    const facts = {
      acceptanceCriteria: ["AC-1"],
      bugs: [],
      tasks: [],
      story: { id: 1, title: "Login" },
      epic: { id: 42, title: "Customer account access" },
      framework,
    };
    void exists;
    return [
      { ...base, eventId: id, kind: "call", payload: { server: "aqa", toolName: "story_context", args: {}, startedAt: 0 } },
      {
        ...base,
        eventId: ++n,
        kind: "observation",
        payload: { eventIdOfCall: id, ok: true, result: { kind: "preflight", summary: {}, text: "", facts }, artefacts: [], durationMs: 1 },
      },
    ] as AnyRunEvent[];
  };
  const profile = {
    exists: true,
    configs: ["playwright.config.ts"],
    specDir: "e2e",
    specSuffix: ".spec.ts",
    featureDir: "spec/features",
    specs: [],
    features: [],
    deps: ["@playwright/test"],
    testScripts: {},
    envNames: [],
    guessed: [],
  };

  it("puts the epic's files where THIS project keeps them", () => {
    const facts = { acceptanceCriteria: [], bugs: [], tasks: [], epic: { id: 42, title: "Customer account access" }, framework: profile };
    expect(featurePathFor(facts)).toBe("spec/features/epic-42-customer-account-access.feature");
    expect(specPathFor(facts)).toBe("e2e/epic-42-customer-account-access.spec.ts");
  });

  it("refuses to write the project's own config or manifest", () => {
    const events = preflight(profile);
    expect(storyRefusal({ toolName: "fs.write_file", args: { path: "playwright.config.ts", content: "x" } }, events)).toContain(
      "belongs to the project",
    );
    expect(storyRefusal({ toolName: "fs.write_file", args: { path: "package.json", content: "x" } }, events)).toContain(
      "belongs to the project",
    );
  });

  it("refuses an import the project has not installed", () => {
    const id = ++n;
    const scaffolded: AnyRunEvent[] = [
      { ...base, eventId: id, kind: "call", payload: { server: "bdd2pw", toolName: "scaffold", args: { feature: "f" }, startedAt: 0 } },
      {
        ...base,
        eventId: ++n,
        kind: "observation",
        payload: { eventIdOfCall: id, ok: true, result: { exitCode: 0 }, artefacts: [], durationMs: 1 },
      },
    ] as AnyRunEvent[];
    const events = [...preflight(profile), ...scaffolded];
    const content = 'import AxeBuilder from "@axe-core/playwright";';
    expect(storyRefusal({ toolName: "fs.write_file", args: { path: "e2e/a.spec.ts", content } }, events)).toContain(
      "@axe-core/playwright",
    );
  });

  it("stops when there is no framework, instead of inventing one", () => {
    const events = preflight({ ...profile, exists: false });
    const r = storyRefusal({ toolName: "fs.write_file", args: { path: "features/x.feature", content: "" } }, events);
    expect(r).toContain("aqa init-framework");
  });
});
