import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bdd2PwTools,
  countEmptyLocators,
  countLane,
  repoForFeature,
  specStemFor,
} from "../src/mcp/adapters/bdd2pw.js";
import { PwTools, summarise, MAX_TESTS_RECORDED, stripAnsi } from "../src/mcp/adapters/pw.js";
import { TcgTools, type FetchLike } from "../src/mcp/adapters/tcg.js";
import { SynthdataTools } from "../src/mcp/adapters/synthdata.js";
import { splitCommand, spawnable, type CommandRunner } from "../src/mcp/adapters/process.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aqa-ad-"));

const FEATURE = `Feature: Login with valid credentials

  Scenario: AC-1 valid credentials reach the dashboard
    Given the user is on the login page
    When they submit valid credentials
    Then the dashboard is shown
`;

/**
 * These test the ADAPTER, not bdd2pw.
 *
 * The previous version of this file tested `parseFeature` and `renderSpec` —
 * a Gherkin parser and a code generator that lived inside the adapter. They are
 * gone: the adapter now runs `@vijaypjavvadi/bdd2pw`, which parses with
 * `@cucumber/gherkin`, scans the live page for real locators, and emits Page
 * Objects plus a runnable spec.
 *
 * So there is nothing here about Gherkin. What is left is what an adapter is
 * actually responsible for: naming the tools, validating arguments, refusing
 * what escapes the workspace, building the right command line, and normalising
 * the result. Those are translation concerns, and they are the only concerns an
 * adapter should be able to get wrong.
 */
describe("bdd2pw adapter", () => {
  function runner(result: { code: number; stdout: string; stderr?: string }): {
    fn: CommandRunner;
    seen: string[][];
  } {
    const seen: string[][] = [];
    const fn: CommandRunner = async (command, args) => (
      seen.push([command, ...args]),
      { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" }
    );
    return { fn, seen };
  }

  function workspaceWithFeature(): string {
    const ws = tmp();
    mkdirSync(join(ws, "features"));
    writeFileSync(join(ws, "features", "login.feature"), FEATURE);
    return ws;
  }

  it("offers scaffold and analyze, and scopes both on the url", async () => {
    // bdd2pw opens the application to find locators, so the gate must check
    // that url against agent.scope.urls exactly as it does a navigation.
    const tools = await new Bdd2PwTools(tmp()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["analyze", "scaffold"]);
    for (const t of tools) expect(t.scopeArgs).toEqual({ url: "url" });
    expect(tools.find((t) => t.name === "scaffold")?.policyClass).toBe("write_workspace");
    expect(tools.find((t) => t.name === "analyze")?.policyClass).toBe("read");
  });

  it("builds a scaffold command against the workspace as the repo", async () => {
    const r = runner({ code: 0, stdout: "wrote 1 spec" });
    const ws = workspaceWithFeature();
    const t = new Bdd2PwTools(ws, { runner: r.fn });
    const out = await t.call("bdd2pw", "scaffold", {
      feature: "features/login.feature",
      url: "http://localhost:3100/#/login",
      page: "LoginPage",
    });
    expect(out.ok).toBe(true);
    const cmd = r.seen[0]!;
    expect(cmd).toContain("bdd2pw");
    expect(cmd).toContain("scaffold");
    expect(cmd).toContain("features/login.feature");
    expect(cmd).toContain("--url");
    expect(cmd).toContain("--page");
    // A feature at the workspace root means the workspace IS the Playwright
    // repo, so the repo argument is "." — as it always was.
    expect(cmd.slice(cmd.indexOf("--repo"), cmd.indexOf("--repo") + 2)).toEqual(["--repo", "."]);
    // The spec is named after the feature file (bdd2pw 4.4+ --spec-name), so
    // an epic's feature and spec share one stem.
    expect(cmd.slice(cmd.indexOf("--spec-name"), cmd.indexOf("--spec-name") + 2)).toEqual([
      "--spec-name",
      "login",
    ]);
  });

  it("names the spec for the feature and counts where each step came from", async () => {
    const ws = workspaceWithFeature();
    writeFileSync(join(ws, "features", "epic-scrum-5-customer-account-access.feature"), FEATURE);
    const spec = [
      'test("Signs out", async () => {',
      '  await test.step("Given I am signed in", async () => {',
      "    // @bdd2pw lane=rule rule=auth-01 pack=web",
      "  });",
      '  await test.step("When I log out", async () => {',
      "    // @bdd2pw lane=llm provider=anthropic model=claude-sonnet-4-6 cached=false governance=sanitised",
      "  });",
      '  await test.step("Then the menu offers Login", async () => {',
      "    // @bdd2pw lane=todo",
      "    // TODO: no rule matched",
      "  });",
      "});",
    ].join("\n");
    const fn: CommandRunner = async () => {
      mkdirSync(join(ws, "tests"), { recursive: true });
      writeFileSync(join(ws, "tests", "epic-scrum-5-customer-account-access.spec.ts"), spec);
      return { code: 0, stdout: "wrote 1 spec", stderr: "" };
    };
    const t = new Bdd2PwTools(ws, { runner: fn });
    const out = await t.call("bdd2pw", "scaffold", {
      feature: "features/epic-scrum-5-customer-account-access.feature",
      url: "http://localhost:3100/#/login",
    });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ provenance: { rule: 1, llm: 1, todo: 1 } });
    expect(specStemFor("features\\epic-scrum-5-customer-account-access.feature")).toBe(
      "epic-scrum-5-customer-account-access",
    );
    expect(countLane("  // @bdd2pw lane=rule rule=x\n// @bdd2pw lane=ruler", "rule")).toBe(1);
    expect(
      countEmptyLocators(
        'this.a = page.locator("");\nthis.b = page.locator(\'\');\nthis.c = page.locator("#x");',
      ),
    ).toBe(2);
  });

  it("roots the repo where the feature lives, not where the process started", async () => {
    // Run 20260918T221233Z: the feature was at examples/sandbox/features/, the
    // repo argument was a hard-coded ".", and bdd2pw wrote the spec to the
    // workspace root two directories away. Nothing failed — the agent went
    // looking beside its feature file, found a stale spec from an earlier run,
    // and the no-progress detector stopped it.
    const r = runner({ code: 0, stdout: "wrote 1 spec" });
    const ws = tmp();
    mkdirSync(join(ws, "examples", "sandbox", "features"), { recursive: true });
    writeFileSync(join(ws, "examples", "sandbox", "features", "login.feature"), FEATURE);
    const t = new Bdd2PwTools(ws, { runner: r.fn });
    const out = await t.call("bdd2pw", "scaffold", {
      feature: "examples/sandbox/features/login.feature",
      url: "http://localhost:3100/#/login",
    });
    expect(out.ok).toBe(true);
    const cmd = r.seen[0]!;
    expect(cmd.slice(cmd.indexOf("--repo"), cmd.indexOf("--repo") + 2)).toEqual([
      "--repo",
      "examples/sandbox",
    ]);
    // And the result SAYS where the files went, so the agent does not guess.
    expect(out.result).toMatchObject({
      repo: "examples/sandbox",
      specDir: join("examples/sandbox", "tests"),
      pageObjectDir: join("examples/sandbox", "pages"),
    });
  });

  it("derives the repo from the feature path alone", () => {
    expect(repoForFeature("features/login.feature")).toBe(".");
    expect(repoForFeature("login.feature")).toBe(".");
    expect(repoForFeature("./features/login.feature")).toBe(".");
    expect(repoForFeature("examples/sandbox/features/login.feature")).toBe("examples/sandbox");
    // No `features/` directory: the repo is simply where the file sits.
    expect(repoForFeature("examples/sandbox/login.feature")).toBe("examples/sandbox");
    expect(repoForFeature("examples\\sandbox\\features\\login.feature")).toBe("examples/sandbox");
  });

  it("NEVER passes --llm-skip-governance, whatever the options say", async () => {
    // bdd2pw sanitises every prompt through the ai-governance sidecar before it
    // leaves the perimeter, and fails closed if the sidecar is down. That is the
    // property that makes the LLM path safe to offer at all. A test-only escape
    // hatch reachable from an agent is not a test-only escape hatch.
    const r = runner({ code: 0, stdout: "ok" });
    const ws = workspaceWithFeature();
    const t = new Bdd2PwTools(ws, {
      runner: r.fn,
      llm: "anthropic",
      governanceUrl: "http://localhost:4900",
    });
    await t.call("bdd2pw", "scaffold", { feature: "features/login.feature", url: "http://x/" });
    expect(r.seen[0]!.join(" ")).not.toContain("skip-governance");
    expect(r.seen[0]).toContain("--llm");
    expect(r.seen[0]).toContain("--governance-url");
  });

  it("does not enable the LLM without a governance endpoint", async () => {
    // The pair is constructed together so a later edit cannot separate them.
    const r = runner({ code: 0, stdout: "ok" });
    const ws = workspaceWithFeature();
    const t = new Bdd2PwTools(ws, { runner: r.fn, llm: "anthropic" });
    const out = await t.call("bdd2pw", "scaffold", {
      feature: "features/login.feature",
      url: "http://x/",
    });
    expect(r.seen[0]!.join(" ")).not.toContain("--llm");
    // ...and the run says the fallback was unavailable, so a spec left full of
    // TODOs can say WHY rather than leaving the reader to guess.
    expect(out.result).toMatchObject({ llmFallback: "disabled" });
  });

  it("refuses a feature path that escapes the workspace, or does not exist", async () => {
    const r = runner({ code: 0, stdout: "ok" });
    const t = new Bdd2PwTools(workspaceWithFeature(), { runner: r.fn });
    const url = "http://x/";
    expect((await t.call("bdd2pw", "scaffold", { feature: "../x.feature", url })).ok).toBe(false);
    expect((await t.call("bdd2pw", "scaffold", { feature: "nope.feature", url })).ok).toBe(false);
    expect(r.seen).toHaveLength(0);
  });

  it("requires a url, because a scan is the whole point", async () => {
    const r = runner({ code: 0, stdout: "ok" });
    const t = new Bdd2PwTools(workspaceWithFeature(), { runner: r.fn });
    const out = await t.call("bdd2pw", "scaffold", { feature: "features/login.feature" });
    expect(out.ok).toBe(false);
    // Assert on the message a human reads, not on its JSON-escaped form.
    expect((out.result as { message: string }).message).toContain('requires "url"');
  });

  it("refuses arguments carrying shell punctuation", async () => {
    // On Windows the launcher goes through the command interpreter, so an
    // argument with shell metacharacters is refused rather than escaped.
    const r = runner({ code: 0, stdout: "ok" });
    const t = new Bdd2PwTools(workspaceWithFeature(), { runner: r.fn });
    const bad = await t.call("bdd2pw", "scaffold", {
      feature: "features/login.feature",
      url: "http://x/ & calc",
    });
    expect(bad.ok).toBe(false);
    expect(r.seen).toHaveLength(0);
  });

  it("reports a non-zero exit as a failure, with the output", async () => {
    const r = runner({ code: 1, stdout: "", stderr: "could not reach http://x/" });
    const t = new Bdd2PwTools(workspaceWithFeature(), { runner: r.fn });
    const out = await t.call("bdd2pw", "scaffold", {
      feature: "features/login.feature",
      url: "http://x/",
    });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.result)).toContain("could not reach");
  });

  it("refuses an unknown tool name", async () => {
    const t = new Bdd2PwTools(tmp());
    expect((await t.call("bdd2pw", "to_spec", { path: "a.feature" })).ok).toBe(false);
  });
});

describe("pw run_tests", () => {
  const report = (stats: Record<string, number>, suites: unknown[] = []) =>
    JSON.stringify({ stats, suites });

  function runner(result: { code: number; stdout: string; stderr?: string }): {
    fn: CommandRunner;
    seen: string[][];
  } {
    const seen: string[][] = [];
    const fn: CommandRunner = async (command, args) => (
      seen.push([command, ...args]),
      { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" }
    );
    return { fn, seen };
  }

  it("passes spec and grep through and reports a green run", async () => {
    const r = runner({ code: 0, stdout: report({ expected: 4, unexpected: 0, skipped: 0 }) });
    const pw = new PwTools(tmp(), { runner: r.fn });
    const out = await pw.call("pw", "run_tests", { spec: "tests/login.spec.ts", grep: "AC-1" });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ passed: 4, failed: 0, green: true });
    expect(r.seen[0]).toContain("tests/login.spec.ts");
    expect(r.seen[0]).toContain("--grep");
    expect(r.seen[0]).toContain("--reporter=json");
  });

  it("is NOT green when tests are skipped — an unimplemented skeleton never passes", async () => {
    const r = runner({ code: 0, stdout: report({ expected: 0, unexpected: 0, skipped: 3 }) });
    const pw = new PwTools(tmp(), { runner: r.fn });
    const out = await pw.call("pw", "run_tests", {});
    expect(out.result).toMatchObject({ skipped: 3, green: false });
  });

  it("keeps the HEAD of a failure message, without colour codes", async () => {
    // The tail of a coloured message began "…22m failed" in 20260921T203913Z.
    const long =
      "Error: expect(page).toHaveURL(expected) \u001b[31mfailed\u001b[39m\n" + "x".repeat(2000);
    const suites = [
      {
        file: "t.spec.ts",
        specs: [{ title: "A", ok: false, tests: [{ results: [{ error: { message: long } }] }] }],
      },
    ];
    const r = runner({ code: 1, stdout: report({ expected: 0, unexpected: 1 }, suites) });
    const out = await new PwTools(tmp(), { runner: r.fn }).call("pw", "run_tests", {});
    const msg = (out.result as { failures: Array<{ message: string }> }).failures[0]?.message ?? "";
    expect(msg.startsWith("Error: expect(page).toHaveURL(expected) failed")).toBe(true);
    expect(msg).not.toContain("\u001b");
    expect(stripAnsi("\u001b[2m a \u001b[22m")).toBe(" a ");
  });

  it("collects failing test titles and messages", async () => {
    const suites = [
      {
        file: "tests/login.spec.ts",
        specs: [
          { title: "AC-1", ok: false, tests: [{ results: [{ error: { message: "boom" } }] }] },
          { title: "AC-2", ok: true },
        ],
        suites: [{ specs: [{ title: "nested", ok: false, tests: [] }] }],
      },
    ];
    const r = runner({ code: 1, stdout: report({ expected: 1, unexpected: 2 }, suites) });
    const out = await new PwTools(tmp(), { runner: r.fn }).call("pw", "run_tests", {});
    expect(out.result).toMatchObject({ failed: 2, green: false, exitCode: 1 });
    expect((out.result as { failures: unknown[] }).failures).toEqual([
      { title: "AC-1", file: "tests/login.spec.ts", message: "boom" },
      { title: "nested", file: "tests/login.spec.ts", message: "" },
    ]);
  });

  it("fails loudly when Playwright produced no JSON, and refuses escaping specs", async () => {
    const r = runner({ code: 127, stdout: "", stderr: "playwright: not found" });
    const pw = new PwTools(tmp(), { runner: r.fn });
    const out = await pw.call("pw", "run_tests", {});
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.result)).toContain("not found");
    expect((await pw.call("pw", "run_tests", { spec: "../evil" })).ok).toBe(false);
    expect((await pw.call("pw", "nope", {})).ok).toBe(false);
  });

  it("summarise rejects non-JSON", () => {
    expect(summarise("not json", 0)).toBeUndefined();
    expect(summarise("null", 0)).toBeUndefined();
  });
});

describe("tcg generate_cases", () => {
  const ok =
    (body: unknown): FetchLike =>
    async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    });

  it("posts the story and unwraps { cases } or a bare array", async () => {
    let sent: unknown;
    const fetchImpl: FetchLike = async (url, init) => {
      sent = { url, body: JSON.parse(init.body ?? "null") };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ cases: [{ title: "a" }] }),
      };
    };
    const t = new TcgTools("https://tcg.example/generate", { fetch: fetchImpl });
    const r = await t.call("tcg", "generate_cases", {
      story: "Login",
      acceptanceCriteria: ["AC-1"],
      count: 5,
    });
    expect(r.result).toEqual({ cases: [{ title: "a" }], count: 1 });
    expect(sent).toEqual({
      url: "https://tcg.example/generate",
      body: { story: "Login", acceptanceCriteria: ["AC-1"], count: 5 },
    });
    const bare = new TcgTools("u", { fetch: ok([{ title: "b" }]) });
    expect((await bare.call("tcg", "generate_cases", { story: "s" })).result).toMatchObject({
      count: 1,
    });
  });

  it("turns HTTP errors, bad JSON and missing cases into ok:false", async () => {
    const bad = (f: FetchLike) => new TcgTools("u", { fetch: f });
    const http: FetchLike = async () => ({ ok: false, status: 503, text: async () => "down" });
    const notJson: FetchLike = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    expect((await bad(http).call("tcg", "generate_cases", { story: "s" })).ok).toBe(false);
    expect((await bad(notJson).call("tcg", "generate_cases", { story: "s" })).ok).toBe(false);
    expect((await bad(ok({ nope: 1 })).call("tcg", "generate_cases", { story: "s" })).ok).toBe(
      false,
    );
    expect((await bad(ok({})).call("tcg", "generate_cases", {})).ok).toBe(false);
  });
});

describe("synthdata generate", () => {
  it("builds the command line, keeps output in the workspace and reports bytes", async () => {
    const ws = tmp();
    const seen: string[][] = [];
    const runner: CommandRunner = async (command, args, opts) => {
      seen.push([command, ...args]);
      writeFileSync(join(opts.cwd, "data/users.json".split("/").join("/")), "[]");
      return { code: 0, stdout: "wrote 3", stderr: "" };
    };
    mkdirSync(join(ws, "data"));
    const t = new SynthdataTools("python tools/synth.py", ws, { runner });
    const r = await t.call("synthdata", "generate", {
      schema: "users",
      count: 3,
      out: "data/users.json",
    });
    expect(r.ok).toBe(true);
    expect(r.artefacts).toEqual(["data/users.json"]);
    expect(seen[0]).toEqual([
      "python",
      "tools/synth.py",
      "--schema",
      "users",
      "--count",
      "3",
      "--out",
      "data/users.json",
    ]);
  });

  it("refuses escapes, bad counts and non-zero exits", async () => {
    const ws = tmp();
    const fine: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const boom: CommandRunner = async () => ({ code: 2, stdout: "", stderr: "schema unknown" });
    const t = (r: CommandRunner) => new SynthdataTools("gen", ws, { runner: r });
    expect((await t(fine).call("synthdata", "generate", { schema: "u", out: "../x" })).ok).toBe(
      false,
    );
    expect(
      (await t(fine).call("synthdata", "generate", { schema: "u", out: "a", count: 0 })).ok,
    ).toBe(false);
    expect((await t(fine).call("synthdata", "generate", { out: "a" })).ok).toBe(false);
    const failed = await t(boom).call("synthdata", "generate", { schema: "u", out: "a" });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed.result)).toContain("schema unknown");
  });
});

describe("splitCommand", () => {
  it("splits on whitespace and keeps quoted segments together", () => {
    expect(splitCommand("python tools/synth.py")).toEqual({
      command: "python",
      args: ["tools/synth.py"],
    });
    expect(splitCommand('"C:/Program Files/py.exe" -m gen')).toEqual({
      command: "C:/Program Files/py.exe",
      args: ["-m", "gen"],
    });
    expect(splitCommand("   ")).toBeUndefined();
  });
});

describe("spawnable (Windows batch launchers)", () => {
  it("routes a .cmd through the command interpreter, arguments still as an array", () => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      // Node refuses to spawn .cmd directly since the batch-injection fix, and
      // returns EINVAL — which is exactly how a real run failed.
      const s = spawnable("npx.cmd", ["playwright", "test", "--reporter=json"]);
      expect(s.command.toLowerCase()).toContain("cmd");
      expect(s.args.slice(0, 4)).toEqual(["/d", "/s", "/c", "npx.cmd"]);
      expect(s.args).toContain("--reporter=json");
      // a plain executable is untouched
      expect(spawnable("node", ["x.js"])).toEqual({ command: "node", args: ["x.js"] });
    } finally {
      Object.defineProperty(process, "platform", saved);
    }
  });

  it("leaves everything alone off Windows", () => {
    expect(spawnable("npx", ["playwright"])).toEqual({ command: "npx", args: ["playwright"] });
  });
});

describe("pw: unsafe arguments", () => {
  it("refuses shell punctuation in spec and grep rather than escaping it", async () => {
    const pw = new PwTools(tmp(), {
      runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    });
    expect((await pw.call("pw", "run_tests", { spec: "tests/a.spec.ts & calc" })).ok).toBe(false);
    expect((await pw.call("pw", "run_tests", { grep: 'AC-1" & del *' })).ok).toBe(false);
  });
});

describe("summarise: every test, not only the failures", () => {
  const report = (specs: unknown[]) =>
    JSON.stringify({
      stats: { expected: 2, unexpected: 1, skipped: 1, flaky: 0 },
      suites: [{ file: "tests/login.spec.ts", specs }],
    });

  it("records title, status and duration for passes as well as failures", () => {
    // The ledger is what the run report is composed from, so a status this
    // drops can never reach the story. A green suite reported as "5 passed"
    // with no names was the visible symptom.
    const out = summarise(
      report([
        { title: "AC-1", ok: true, tests: [{ status: "expected", results: [{ duration: 2400 }] }] },
        {
          title: "AC-2",
          ok: false,
          tests: [
            { status: "unexpected", results: [{ duration: 900, error: { message: "boom" } }] },
          ],
        },
        { title: "AC-3", ok: true, tests: [{ status: "skipped", results: [{ duration: 0 }] }] },
      ]),
      1,
    );
    expect(out?.tests).toEqual([
      { title: "AC-1", file: "tests/login.spec.ts", status: "passed", durationMs: 2400 },
      { title: "AC-2", file: "tests/login.spec.ts", status: "failed", durationMs: 900 },
      { title: "AC-3", file: "tests/login.spec.ts", status: "skipped", durationMs: 0 },
    ]);
    // Failures keep their own list, with the message.
    expect(out?.failures).toHaveLength(1);
    expect(out?.failures[0]?.message).toContain("boom");
  });

  it("does not report a skipped spec as passed", () => {
    // `spec.ok` is true for a skipped spec, so reading ok alone would report a
    // suite of `fixme` skeletons as passing — the worst summary available.
    const out = summarise(
      report([{ title: "todo", ok: true, tests: [{ status: "skipped", results: [] }] }]),
      0,
    );
    expect(out?.tests[0]?.status).toBe("skipped");
  });

  it("caps the rows and says how many it dropped", () => {
    const many = Array.from({ length: MAX_TESTS_RECORDED + 12 }, (_, i) => ({
      title: `t${i}`,
      ok: true,
      tests: [{ status: "expected", results: [{ duration: 1 }] }],
    }));
    const out = summarise(report(many), 0);
    expect(out?.tests).toHaveLength(MAX_TESTS_RECORDED);
    expect(out?.testsOmitted).toBe(12);
  });
});

describe("the Playwright report is kept, not just parsed", () => {
  it("writes the reporter's JSON into the workspace and records it as an artefact", async () => {
    const ws = mkdtempSync(join(tmpdir(), "aqa-pwrep-"));
    const report = JSON.stringify({
      stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 },
      suites: [],
    });
    const pw = new PwTools(ws, {
      runner: async () => ({ code: 0, stdout: report, stderr: "" }),
    });
    const r = await pw.call("pw", "run_tests", {});
    expect(r.ok).toBe(true);
    expect(r.artefacts).toEqual([join(".aqa-report", "playwright.json")]);
    const written = readFileSync(join(ws, ".aqa-report", "playwright.json"), "utf8");
    expect(JSON.parse(written)).toMatchObject({ stats: { expected: 2 } });
  });

  it("still reports a summary when the report cannot be written", async () => {
    // A workspace path that is a FILE, so creating .aqa-report/ under it fails
    // with ENOTDIR. Keeping the report is evidence we would like, not evidence
    // the run depends on.
    const file = join(mkdtempSync(join(tmpdir(), "aqa-pwrep-")), "not-a-dir");
    writeFileSync(file, "x");
    const pw = new PwTools(file, {
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ stats: { expected: 1 }, suites: [] }),
        stderr: "",
      }),
    });
    const r = await pw.call("pw", "run_tests", {});
    expect(r.ok).toBe(true);
    expect((r.result as { passed: number }).passed).toBe(1);
    expect(r.artefacts).toEqual([]);
  });
});

describe("summarise: a known bug that did not reproduce", () => {
  it("counts an expected-to-fail test that passed as a finding, not a failure", () => {
    // Observed in 20260921T192908Z: AC-2b was marked test.fail() for Active
    // bug #48, and passed. Playwright exits 1 and calls it "unexpected"; the
    // runtime reported it as a failure and the agent proposed a bug that
    // "contradicts known Active bug #48". Nothing about the product failed —
    // the known bug did not reproduce, which is news for a person.
    const report = JSON.stringify({
      stats: { expected: 6, unexpected: 1, skipped: 0, flaky: 0 },
      suites: [
        {
          file: "tests/login.spec.ts",
          specs: [
            {
              title: "AC-2b error clears after correcting credentials",
              ok: false,
              tests: [
                {
                  expectedStatus: "failed",
                  status: "unexpected",
                  annotations: [{ type: "fail", description: "Bug #48 Active" }],
                  results: [{ status: "passed", duration: 3000 }],
                },
              ],
            },
          ],
        },
      ],
    });
    const out = summarise(report, 1)!;
    expect(out.failed).toBe(0);
    expect(out.failures).toEqual([]);
    expect(out.green).toBe(true);
    expect(out.unexpectedPasses).toEqual([
      {
        title: "AC-2b error clears after correcting credentials",
        file: "tests/login.spec.ts",
        note: "Bug #48 Active",
      },
    ]);
    expect(out.tests[0]?.status).toBe("unexpected-pass");
  });
});

describe("summarise: a known bug that did reproduce", () => {
  it("marks an expected-to-fail test that failed as expected-failure, not passed (20261012T161004Z)", () => {
    const report = JSON.stringify({
      stats: { expected: 5, unexpected: 0, skipped: 0, flaky: 0 },
      suites: [
        {
          file: "tests/epic-scrum-5-customer-account-access.spec.ts",
          specs: [
            {
              title: "Bug SCRUM-12: Session token is still accepted by the server after logout",
              ok: true,
              tests: [
                {
                  expectedStatus: "failed",
                  status: "expected",
                  results: [{ status: "failed", duration: 9000 }],
                },
              ],
            },
          ],
        },
      ],
    });
    const out = summarise(report, 0)!;
    expect(out.green).toBe(true);
    expect(out.unexpectedPasses ?? []).toEqual([]);
    expect(out.tests[0]?.status).toBe("expected-failure");
  });
});

describe("a failure hands back the page it failed on", () => {
  const stdout = (stats: Record<string, number>, suites: unknown[]) =>
    JSON.stringify({ stats, suites });

  it("reads Playwright's error-context attachment into pageAtFailure", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "aqa-ctx-"));
    const ctx = join(dir, "error-context.md");
    writeFileSync(
      ctx,
      '# Page snapshot\n\n```yaml\n- banner:\n  - menuitem "Logout" [ref=e328]\n```\n\n# Source\n\n  1 | code\n',
      "utf8",
    );
    const out = summarise(
      stdout({ expected: 0, unexpected: 1 }, [
        {
          file: "t.spec.ts",
          specs: [
            {
              title: "logout",
              ok: false,
              tests: [
                {
                  status: "unexpected",
                  results: [
                    {
                      error: { message: "locator timeout" },
                      attachments: [{ name: "error-context", path: ctx }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
      1,
    )!;
    expect(out.failures[0]?.pageAtFailure).toContain('menuitem "Logout"');
    expect(out.failures[0]?.pageAtFailure).not.toContain("# Source");
  });
});
