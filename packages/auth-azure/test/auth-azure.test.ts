import { describe, it, expect, afterEach } from "vitest";
import type { AuthOptions, ModelConfig } from "attestqa";
import { resolveModelPlugins } from "attestqa";
import { createTokenSource, type EntraDeps } from "../src/index.js";

const options: AuthOptions = {
  env: { anthropicApiKey: "", sandbox: false },
  model: {
    provider: "azure-openai",
    name: "gpt-4.1",
    endpoint: "https://acme.openai.azure.com",
  } as ModelConfig,
  warn: () => {},
};

interface Behaviour {
  token?: string;
  expiresOnTimestamp?: number;
  throws?: Error;
}

/** A fake credential whose getToken yields (or throws) what the test sets, recording the scope asked for. */
function fakeDeps(behaviour: Behaviour, scope?: string, seenScopes: string[] = []): EntraDeps {
  return {
    ...(scope ? { scope } : {}),
    loadCredential: async () => ({
      getToken: async (scopes: string | string[]) => {
        seenScopes.push(Array.isArray(scopes) ? scopes.join(",") : scopes);
        if (behaviour.throws) throw behaviour.throws;
        if (!behaviour.token) return null;
        return {
          token: behaviour.token,
          ...(behaviour.expiresOnTimestamp
            ? { expiresOnTimestamp: behaviour.expiresOnTimestamp }
            : {}),
        };
      },
    }),
  };
}

const savedScope = process.env["AZURE_TOKEN_SCOPE"];
const savedTenant = process.env["AZURE_TENANT_ID"];
afterEach(() => {
  if (savedScope === undefined) delete process.env["AZURE_TOKEN_SCOPE"];
  else process.env["AZURE_TOKEN_SCOPE"] = savedScope;
  if (savedTenant === undefined) delete process.env["AZURE_TENANT_ID"];
  else process.env["AZURE_TENANT_ID"] = savedTenant;
});

describe("@attestqa/auth-azure", () => {
  it("returns the Entra ID access token as a bearer with its expiry", async () => {
    const expiresOnTimestamp = Date.now() + 3_600_000;
    const ts = await createTokenSource(
      options,
      fakeDeps({ token: "entra-tok", expiresOnTimestamp }),
    );
    const t = await ts.getToken();
    expect(t.token).toBe("entra-tok");
    expect(t.header).toBe("authorization");
    expect(t.expiresAt).toBe(expiresOnTimestamp);
  });

  it("defaults the scope to Azure OpenAI and can be overridden", async () => {
    const seen: string[] = [];
    const ts = await createTokenSource(options, {
      loadCredential: async () => ({
        getToken: async (s: string | string[]) => {
          seen.push(String(s));
          return { token: "t", expiresOnTimestamp: Date.now() + 3_600_000 };
        },
      }),
    });
    await ts.getToken();
    expect(seen[0]).toBe("https://cognitiveservices.azure.com/.default");

    const seen2: string[] = [];
    const ts2 = await createTokenSource(
      options,
      fakeDeps(
        { token: "t", expiresOnTimestamp: Date.now() + 3_600_000 },
        "api://acme-gw/.default",
        seen2,
      ),
    );
    await ts2.getToken();
    expect(seen2[0]).toBe("api://acme-gw/.default");
  });

  it("names the tenant in the description when AZURE_TENANT_ID is set, never the token", async () => {
    process.env["AZURE_TENANT_ID"] = "contoso-tenant";
    const ts = await createTokenSource(
      options,
      fakeDeps({ token: "secret-tok", expiresOnTimestamp: Date.now() + 3_600_000 }),
    );
    expect(ts.describe()).toContain("tenant contoso-tenant");
    expect(ts.describe()).not.toContain("secret-tok");
  });

  it("turns a sign-in failure into an `az login` instruction", async () => {
    const ts = await createTokenSource(options, fakeDeps({ throws: new Error("no credential") }));
    await expect(ts.getToken()).rejects.toThrow(/az login/);
  });

  it("refuses an expired or about-to-expire token", async () => {
    const ts = await createTokenSource(
      options,
      fakeDeps({ token: "stale", expiresOnTimestamp: Date.now() + 10_000 }),
    );
    await expect(ts.getToken()).rejects.toThrow(/expired or is about to/);
  });

  it("refuses when no token comes back", async () => {
    const ts = await createTokenSource(options, fakeDeps({}));
    await expect(ts.getToken()).rejects.toThrow(/no token/);
  });

  // Loader wiring against this package's REAL exports: the core's own
  // resolveModelPlugins, with an importer that returns this module, must build a
  // TokenSource through `createTokenSource`. It constructs DefaultAzureCredential
  // (offline) but never calls getToken, so no Azure account is needed.
  it("builds a real Entra TokenSource through the loader from this package", async () => {
    const resolved = await resolveModelPlugins(
      {
        agent: {
          model: {
            provider: "azure-openai",
            name: "gpt-4.1",
            endpoint: "https://acme.openai.azure.com",
            auth: "entra",
          },
        },
      },
      { anthropicApiKey: "", sandbox: false },
      {
        signIn: true,
        importer: async (spec: string) =>
          spec === "@attestqa/auth-azure" ? await import("../src/index.js") : import(spec),
      },
    );
    expect(resolved.tokenSource).toBeDefined();
    expect(resolved.tokenSource!.describe()).toContain("Microsoft Entra ID");
  });
});
