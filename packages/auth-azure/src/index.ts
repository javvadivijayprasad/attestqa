/**
 * Microsoft Entra ID sign-in for attestqa.
 *
 * `agent.model.auth: entra` on a bearer-token endpoint — Azure OpenAI, an
 * OpenAI-compatible server, or a company gateway that accepts Entra ID tokens —
 * makes the core's loader import this package and call `createTokenSource`. The
 * token is a short-lived Entra ID (Azure AD) access token obtained with
 * `@azure/identity`'s `DefaultAzureCredential`, which signs in through whatever
 * the environment already offers: `az login`, a managed identity, VS Code, or
 * the `AZURE_*` environment variables. attestqa stores no key; the token is
 * fetched fresh for each request and scrubbed from logs and the ledger.
 *
 * The audience is the token's SCOPE. The default is Azure OpenAI
 * (`https://cognitiveservices.azure.com/.default`); set `AZURE_TOKEN_SCOPE` for
 * a different resource, such as a gateway's own app-registration scope.
 */

import type { AuthOptions, TokenSource } from "attestqa";

/** The default audience: Azure OpenAI. */
const DEFAULT_SCOPE = "https://cognitiveservices.azure.com/.default";

/** A token valid for less than this margin is treated as unusable (the TokenSource contract wants ≥60s). */
const MIN_VALIDITY_MS = 60_000;

/** The slice of `@azure/identity` this package uses. */
interface AzureAccessToken {
  token: string;
  expiresOnTimestamp?: number;
}
interface AzureCredential {
  getToken(scopes: string | string[]): Promise<AzureAccessToken | null>;
}

export interface EntraDeps {
  /** Injected for tests; the default loads `@azure/identity`'s DefaultAzureCredential lazily. */
  loadCredential?: () => Promise<AzureCredential>;
  /** The token scope (audience); defaults to AZURE_TOKEN_SCOPE, then Azure OpenAI. */
  scope?: string;
}

/**
 * Build a TokenSource that yields the current Entra ID access token for the
 * configured scope. A failure to sign in becomes an instruction to run
 * `az login` (or set the `AZURE_*` variables).
 */
export async function createTokenSource(
  _options: AuthOptions,
  deps: EntraDeps = {},
): Promise<TokenSource> {
  const scope = deps.scope ?? process.env["AZURE_TOKEN_SCOPE"] ?? DEFAULT_SCOPE;
  const tenant = process.env["AZURE_TENANT_ID"];
  const loadCredential =
    deps.loadCredential ??
    (async () => {
      const mod = (await import("@azure/identity")) as unknown as {
        DefaultAzureCredential: new () => AzureCredential;
      };
      return new mod.DefaultAzureCredential();
    });
  const credential = await loadCredential();
  const describe = `Microsoft Entra ID (${tenant ? `tenant ${tenant}, ` : ""}scope ${scope})`;

  return {
    async getToken() {
      let token: AzureAccessToken | null;
      try {
        token = await credential.getToken(scope);
      } catch (err) {
        throw new Error(
          `Microsoft Entra ID sign-in failed: ${(err as Error).message}. ` +
            "Sign in with `az login` (or set the AZURE_* environment variables) and try again.",
        );
      }
      if (!token?.token)
        throw new Error(
          "Microsoft Entra ID returned no token. Sign in with `az login` (or set the AZURE_* " +
            "environment variables) and try again.",
        );
      const expiresAt = token.expiresOnTimestamp ?? Date.now() + 3_600_000;
      if (expiresAt - Date.now() < MIN_VALIDITY_MS)
        throw new Error(
          "The Microsoft Entra ID session has expired or is about to. Run `az login`.",
        );
      return { token: token.token, expiresAt, header: "authorization" };
    },
    describe: () => describe,
  };
}
