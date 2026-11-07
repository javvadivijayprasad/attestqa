import { describe, it, expect } from "vitest";
import type { AuthOptions, ModelConfig } from "attestqa";
import { resolveModelPlugins } from "attestqa";
import { createTokenSource, type AwsSsoDeps } from "../src/index.js";

const options: AuthOptions = {
  env: { anthropicApiKey: "", sandbox: false },
  model: {
    provider: "openai",
    name: "gpt-4.1",
    endpoint: "https://gw.acme.internal/v1",
  } as ModelConfig,
  warn: () => {},
};

/** A fake `fromSso` whose provider yields (or throws) what the test sets. */
function fakeDeps(
  behaviour: { token?: string; expiration?: Date; throws?: Error },
  profile?: string,
): AwsSsoDeps {
  return {
    ...(profile ? { profile } : {}),
    loadFromSso: async () => () => async () => {
      if (behaviour.throws) throw behaviour.throws;
      return {
        token: behaviour.token ?? "",
        ...(behaviour.expiration ? { expiration: behaviour.expiration } : {}),
      };
    },
  };
}

describe("@attestqa/auth-aws", () => {
  it("returns the SSO access token as a bearer with its expiry", async () => {
    const expiration = new Date(Date.now() + 3_600_000);
    const ts = await createTokenSource(options, fakeDeps({ token: "sso-access-tok", expiration }));
    const t = await ts.getToken();
    expect(t.token).toBe("sso-access-tok");
    expect(t.header).toBe("authorization");
    expect(t.expiresAt).toBe(expiration.getTime());
  });

  it("describes the sign-in with the profile, never the token", async () => {
    const ts = await createTokenSource(
      options,
      fakeDeps({ token: "x", expiration: new Date(Date.now() + 3_600_000) }, "my-company"),
    );
    expect(ts.describe()).toBe("AWS SSO (profile my-company)");
    expect(ts.describe()).not.toContain("x");
  });

  it("turns a provider failure into an `aws sso login` instruction", async () => {
    const ts = await createTokenSource(
      options,
      fakeDeps({ throws: new Error("token not found") }, "my-company"),
    );
    await expect(ts.getToken()).rejects.toThrow(/aws sso login --profile my-company/);
  });

  it("refuses an expired or about-to-expire token", async () => {
    const ts = await createTokenSource(
      options,
      fakeDeps({ token: "stale", expiration: new Date(Date.now() + 10_000) }),
    );
    await expect(ts.getToken()).rejects.toThrow(/expired or is about to/);
  });

  it("refuses when no token comes back", async () => {
    const ts = await createTokenSource(options, fakeDeps({ token: "" }));
    await expect(ts.getToken()).rejects.toThrow(/no access token/);
  });

  // Loader wiring against this package's REAL exports: the core's own
  // resolveModelPlugins, with an importer that returns this module, must build a
  // TokenSource through `createTokenSource`. It calls the real `fromSso` (which
  // resolves nothing until the provider is invoked) but never asks for a token,
  // so no AWS SSO session is needed.
  it("builds a real AWS SSO TokenSource through the loader from this package", async () => {
    const resolved = await resolveModelPlugins(
      {
        agent: {
          model: { provider: "openai", name: "gpt-4.1", auth: "aws-sso" },
        },
      },
      { anthropicApiKey: "", sandbox: false },
      {
        signIn: true,
        importer: async (spec: string) =>
          spec === "@attestqa/auth-aws" ? await import("../src/index.js") : import(spec),
      },
    );
    expect(resolved.tokenSource).toBeDefined();
    expect(resolved.tokenSource!.describe()).toContain("AWS SSO");
  });
});
