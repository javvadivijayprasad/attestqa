import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentConfigFromObject, parseConfigText } from "../src/config.js";
import { init } from "../src/cli.js";
import {
  CONFIG_FILE,
  modelRoute,
  missingIgnores,
  renderConfig,
  renderEnv,
  runInit,
  scopeEntry,
  unsetNames,
} from "../src/setup/init.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aqa-init-"));
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe("aqa init — the config it writes", () => {
  it("is a valid attestqa config for Jira, scoped to the project key", async () => {
    const text = renderConfig({ tracker: "jira", scope: "shop", url: "http://localhost:3000/" });
    const c = agentConfigFromObject(await parseConfigText(text, ".yaml"));
    expect(c.scope.work_items).toEqual(["SHOP-*"]);
    expect(c.scope.urls).toEqual(["http://localhost:3000"]);
    expect(c.approve_execution).toBe(true);
    expect(c.policy.write_record).toBe("ask");
  });

  it("is a valid attestqa config for Azure DevOps, scoped to an id range", async () => {
    const text = renderConfig({ tracker: "ado", scope: "100-199", url: "https://shop.test" });
    const c = agentConfigFromObject(await parseConfigText(text, ".yaml"));
    expect(c.scope.work_items).toEqual(["100-199"]);
    expect(text).toContain("Test Plans access level");
  });

  it("refuses scope and urls it cannot use, before writing anything", () => {
    expect(() => scopeEntry("jira", "my project")).toThrow(/Jira project key/);
    expect(() => scopeEntry("ado", "SHOP-1")).toThrow(/Azure DevOps/);
    const dir = tmp();
    expect(() => runInit({ dir, tracker: "jira", scope: "SHOP", url: "localhost:3000" })).toThrow(
      /URL|http/,
    );
    expect(existsSync(join(dir, CONFIG_FILE))).toBe(false);
  });

  it("puts no secret in the config and only empty credential lines in .env", () => {
    const cfg = renderConfig({ tracker: "jira", scope: "SHOP", url: "http://localhost:3000" });
    expect(cfg).not.toMatch(/TOKEN=|PAT=|KEY=/);
    const env = renderEnv("ado", "http://localhost:3000");
    for (const line of env
      .split("\n")
      .filter((l) => /^(ANTHROPIC_API_KEY|AZURE_DEVOPS_PAT|AQA_APP_PASS)=/.test(l)))
      expect(line).toMatch(/=$/);
  });
});

describe("aqa init — on disk", () => {
  it("writes config, .env and .gitignore lines in an empty folder", () => {
    const dir = tmp();
    const r = runInit({ dir, tracker: "jira", scope: "SHOP", url: "http://localhost:3000" });
    expect(r.written.sort()).toEqual([".env", ".gitignore", CONFIG_FILE].sort());
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
    expect(r.notes.join("\n")).toContain("npm init playwright@latest");
  });

  it("never overwrites .env, and names (not values) what it is missing", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-secret-value\nJIRA_BASE_URL=\n");
    const r = runInit({ dir, tracker: "jira", scope: "SHOP", url: "http://localhost:3000" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "ANTHROPIC_API_KEY=sk-secret-value\nJIRA_BASE_URL=\n",
    );
    const note = r.notes.join("\n");
    expect(note).toContain("JIRA_BASE_URL");
    expect(note).not.toContain("ANTHROPIC_API_KEY");
    expect(note).not.toContain("sk-secret-value");
  });

  it("keeps an existing config unless --force, and does not repeat .gitignore lines", () => {
    const dir = tmp();
    runInit({ dir, tracker: "jira", scope: "SHOP", url: "http://localhost:3000" });
    writeFileSync(join(dir, CONFIG_FILE), "# mine\n");
    const again = runInit({ dir, tracker: "ado", scope: "1-9", url: "http://localhost:3000" });
    expect(again.kept).toContain(CONFIG_FILE);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe("# mine\n");
    expect(again.written).not.toContain(".gitignore");
    runInit({ dir, tracker: "ado", scope: "1-9", url: "http://localhost:3000", force: true });
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toContain('work_items: ["1-9"]');
  });

  it("reads only names from .env, and skips comments and empty values", () => {
    expect(unsetNames("A=1\n# B=2\nC=\n", ["A", "B", "C"])).toEqual(["B", "C"]);
    expect(
      unsetNames("JIRA_BASE_URL=https://your-site.atlassian.net\n", ["JIRA_BASE_URL"]),
    ).toEqual(["JIRA_BASE_URL"]);
    expect(missingIgnores(".env\nnode_modules/\n")).toEqual([".env.*", "!.env.example", ".aqa/"]);
  });
});

describe("aqa init — the command", () => {
  it("runs from flags alone and says what to do next", async () => {
    const dir = tmp();
    const t = io();
    const code = await init(
      [
        "--tracker",
        "ado",
        "--scope",
        "100-199",
        "--url",
        "http://localhost:3000",
        "--model",
        "anthropic",
        "--dir",
        dir,
      ],
      t.io,
      async () => undefined,
    );
    expect(code).toBe(0);
    expect(t.out.join("")).toContain(
      'aqa run "Write tests for 100" --config ai-quality.config.yaml --dry-run',
    );
  });

  it("asks for what is missing, and fails clearly when there is no terminal", async () => {
    const dir = tmp();
    const answers = ["jira", "shop", "http://localhost:4200", "1"];
    const t = io();
    expect(await init(["--dir", dir], t.io, async () => answers.shift())).toBe(0);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toContain('["SHOP-*"]');
    await expect(init(["--dir", tmp()], io().io, async () => undefined)).rejects.toThrow(
      /init needs --tracker/,
    );
  });
});

describe("aqa init — which model the company uses", () => {
  const loads = async (text: string) => agentConfigFromObject(await parseConfigText(text, ".yaml"));
  const common = { tracker: "jira" as const, scope: "SHOP", url: "http://localhost:3000" };

  it("Claude through the company gateway: Claude Code's two variables, and a valid config", async () => {
    const c = await loads(renderConfig({ ...common, model: "claude-gateway" }));
    expect(c.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4-6" });
    const env = renderEnv("jira", common.url, "claude-gateway", "https://llm.acme.internal/");
    expect(env).toContain("ANTHROPIC_BASE_URL=https://llm.acme.internal\n");
    expect(env).toContain("ANTHROPIC_AUTH_TOKEN=\n");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
  });

  it("Azure OpenAI and an OpenAI-compatible gateway write a provider block that loads", async () => {
    const az = await loads(
      renderConfig({
        ...common,
        model: "azure-openai",
        modelEndpoint: "https://r.openai.azure.com",
        modelName: "gpt-4-1",
      }),
    );
    expect(az.model).toMatchObject({
      provider: "azure-openai",
      name: "gpt-4-1",
      endpoint: "https://r.openai.azure.com",
    });
    const gw = await loads(
      renderConfig({
        ...common,
        model: "gateway",
        modelEndpoint: "https://gw.acme.internal/v1",
        modelName: "approved-large",
      }),
    );
    expect(gw.model).toMatchObject({ provider: "gateway", name: "approved-large" });
    expect(() =>
      renderConfig({ ...common, model: "gateway", modelEndpoint: "https://gw.example" }),
    ).toThrow(/model name/);
  });

  it("Copilot: a vscode-copilot config that loads, and nothing to put in .env", async () => {
    expect(modelRoute("2")).toBe("claude-gateway");
    expect(modelRoute("5")).toBe("copilot");
    const c = await loads(renderConfig({ ...common, model: "copilot", modelName: "gpt-4.1" }));
    expect(c.model).toEqual({ provider: "vscode-copilot", name: "gpt-4.1" });
    const env = renderEnv("jira", common.url, "copilot");
    expect(env).toContain("nothing to set here");
    expect(() => modelRoute("bard")).toThrow(/not a model route/);
  });

  it("notices Claude Code's gateway settings already in the environment, by name only", () => {
    const dir = tmp();
    const r = runInit({
      dir,
      ...common,
      model: "claude-gateway",
      env: {
        ANTHROPIC_BASE_URL: "https://llm.acme.internal",
        ANTHROPIC_AUTH_TOKEN: "secret-gw-token",
      },
    });
    const notes = r.notes.join("\n");
    expect(notes).toContain(
      "ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN already set in this environment",
    );
    expect(notes).not.toContain("secret-gw-token");
    expect(notes).not.toMatch(/fill in the empty values in .env: ANTHROPIC/);
  });
});
