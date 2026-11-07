import { describe, it, expect, afterEach } from "vitest";
import {
  ensureProvider,
  loadTokenSource,
  resolveModelPlugins,
  type Importer,
} from "../src/runtime/plugins.js";
import {
  buildModel,
  clearRegisteredProviders,
  registeredProviderNames,
  type TokenSource,
} from "../src/runtime/provider.js";
import { agentConfigFromObject, type RuntimeEnv } from "../src/config.js";
import type { ModelClient } from "../src/runtime/model.js";

const env: RuntimeEnv = { anthropicApiKey: "", sandbox: false };

/** An importer that serves a fixed set of fake modules by specifier. */
function fakeImporter(modules: Record<string, unknown>): Importer {
  return async (specifier) => {
    if (specifier in modules) return modules[specifier];
    const err = new Error(`Cannot find module '${specifier}'`) as Error & { code: string };
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  };
}

const fakeModel = { model: "m", promptVersion: "v" } as unknown as ModelClient;
const bedrockModule = { provider: "bedrock", factory: () => fakeModel };

const scope = {
  work_items: ["44"],
  repos: [],
  test_plans: [],
  branches_writable: [],
  urls: [],
};

afterEach(() => clearRegisteredProviders());

describe("ensureProvider", () => {
  it("is a no-op for a built-in provider and imports nothing", async () => {
    let imported = false;
    const importer: Importer = async (_s) => ((imported = true), {});
    await ensureProvider("anthropic", importer);
    await ensureProvider("azure-openai", importer);
    expect(imported).toBe(false);
    expect(registeredProviderNames()).toEqual([]);
  });

  it("imports the convention package for an unknown provider and registers it", async () => {
    await ensureProvider("bedrock", fakeImporter({ "@attestqa/provider-bedrock": bedrockModule }));
    expect(registeredProviderNames()).toContain("bedrock");
  });

  it("names the package to install when it is missing", async () => {
    await expect(ensureProvider("bedrock", fakeImporter({}))).rejects.toThrow(
      /@attestqa\/provider-bedrock.*not installed/s,
    );
  });

  it("rejects a package that answers to a different provider name", async () => {
    await expect(
      ensureProvider(
        "bedrock",
        fakeImporter({
          "@attestqa/provider-bedrock": { provider: "nova", factory: () => fakeModel },
        }),
      ),
    ).rejects.toThrow(/registers the provider "nova"/);
  });

  it("rejects a package that is not a provider plug-in", async () => {
    await expect(
      ensureProvider("bedrock", fakeImporter({ "@attestqa/provider-bedrock": { hello: 1 } })),
    ).rejects.toThrow(/does not export a provider plug-in/);
  });
});

describe("loadTokenSource", () => {
  const tokenSource: TokenSource = {
    getToken: async () => ({ token: "t", expiresAt: Date.now() + 600_000 }),
    describe: () => "Microsoft Entra ID: tester@acme.test",
  };
  const authModule = { createTokenSource: async () => tokenSource };

  it("loads @attestqa/auth-azure for entra", async () => {
    const ts = await loadTokenSource(
      "entra",
      { env, model: { provider: "azure-openai", name: "gpt-4.1" }, warn: () => {} },
      fakeImporter({ "@attestqa/auth-azure": authModule }),
    );
    expect(ts.describe()).toContain("Microsoft Entra ID");
  });

  it("loads @attestqa/auth-aws for aws-sso", async () => {
    const ts = await loadTokenSource(
      "aws-sso",
      { env, model: { provider: "openai", name: "gpt-4.1" }, warn: () => {} },
      fakeImporter({ "@attestqa/auth-aws": authModule }),
    );
    expect(ts).toBe(tokenSource);
  });

  it("names the package to install when the auth package is missing", async () => {
    await expect(
      loadTokenSource(
        "entra",
        { env, model: { provider: "azure-openai", name: "x" }, warn: () => {} },
        fakeImporter({}),
      ),
    ).rejects.toThrow(/@attestqa\/auth-azure.*not installed/s);
  });

  it("rejects a package that does not export createTokenSource", async () => {
    await expect(
      loadTokenSource(
        "entra",
        { env, model: { provider: "azure-openai", name: "x" }, warn: () => {} },
        fakeImporter({ "@attestqa/auth-azure": { nope: 1 } }),
      ),
    ).rejects.toThrow(/does not export createTokenSource/);
  });
});

describe("resolveModelPlugins", () => {
  it("registers a plug-in provider so the config then validates and builds with its factory", async () => {
    const raw = { agent: { model: { provider: "bedrock", name: "claude" }, scope } };
    const resolved = await resolveModelPlugins(raw, env, {
      importer: fakeImporter({ "@attestqa/provider-bedrock": bedrockModule }),
    });
    expect(resolved.tokenSource).toBeUndefined();

    // The provider is now known, so validation passes and buildModel uses the factory.
    const config = agentConfigFromObject(raw);
    expect(buildModel({ config: config.model, env, promptVersion: "v" })).toBe(fakeModel);
  });

  it("returns a token source for a sign-in auth mode", async () => {
    const tokenSource: TokenSource = {
      getToken: async () => ({ token: "t", expiresAt: Date.now() + 600_000 }),
      describe: () => "AWS SSO: acme-dev",
    };
    const raw = {
      agent: { model: { provider: "openai", name: "gpt-4.1", auth: "aws-sso" }, scope },
    };
    const resolved = await resolveModelPlugins(raw, env, {
      importer: fakeImporter({
        "@attestqa/auth-aws": { createTokenSource: async () => tokenSource },
      }),
    });
    expect(resolved.tokenSource).toBe(tokenSource);
  });

  it("does nothing for a built-in provider with key auth", async () => {
    const raw = { agent: { model: { provider: "openai", name: "gpt-4.1" }, scope } };
    const resolved = await resolveModelPlugins(raw, env, { importer: fakeImporter({}) });
    expect(resolved.tokenSource).toBeUndefined();
    expect(registeredProviderNames()).toEqual([]);
  });

  it("tolerates a malformed config and leaves the error to the validator", async () => {
    const resolved = await resolveModelPlugins({ not: "a config" }, env, {
      importer: fakeImporter({}),
    });
    expect(resolved.tokenSource).toBeUndefined();
  });
});
