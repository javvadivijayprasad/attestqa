/**
 * AWS IAM Identity Center (SSO) sign-in for attestqa.
 *
 * `agent.model.auth: aws-sso` on a bearer-token endpoint (an OpenAI-compatible
 * server, a gateway, or Azure OpenAI fronted by AWS SSO) makes the core's loader
 * import this package and call `createTokenSource`. The token returned is the
 * short-lived **SSO OIDC access token** that `aws sso login` writes to
 * `~/.aws/sso/cache` — read and refreshed by the AWS SDK's own token provider,
 * never stored by attestqa and scrubbed from every log and ledger.
 *
 * This is NOT how Bedrock authenticates: Bedrock signs requests with AWS SigV4
 * credentials and is handled by `@attestqa/provider-bedrock`. Use this only when
 * a non-Bedrock endpoint accepts your AWS SSO access token as a bearer.
 */

import type { AuthOptions, TokenSource } from "attestqa";

/** The slice of `@aws-sdk/token-providers` this package uses. */
interface SsoTokenIdentity {
  token: string;
  expiration?: Date;
}
type SsoTokenProvider = () => Promise<SsoTokenIdentity>;
type FromSso = (init?: { profile?: string }) => SsoTokenProvider;

export interface AwsSsoDeps {
  /** Injected for tests; the default loads `@aws-sdk/token-providers` lazily. */
  loadFromSso?: () => Promise<FromSso>;
  /** The AWS profile to read SSO config from; defaults to the `AWS_PROFILE` environment variable. */
  profile?: string;
}

/** A token valid for less than this margin is treated as unusable (the TokenSource contract wants ≥60s). */
const MIN_VALIDITY_MS = 60_000;

/**
 * Build a TokenSource that yields the current AWS SSO access token. The AWS SDK
 * reads the profile's SSO configuration from `~/.aws/config`, finds the cached
 * token, and refreshes it when it can; if there is no usable token it throws,
 * and we turn that into an instruction to run `aws sso login`.
 */
export async function createTokenSource(
  _options: AuthOptions,
  deps: AwsSsoDeps = {},
): Promise<TokenSource> {
  const profile = deps.profile ?? process.env["AWS_PROFILE"];
  const loadFromSso =
    deps.loadFromSso ??
    (async () => {
      const mod = (await import("@aws-sdk/token-providers")) as unknown as { fromSso: FromSso };
      return mod.fromSso;
    });
  const fromSso = await loadFromSso();
  const provider = fromSso(profile ? { profile } : {});
  const loginHint = `aws sso login${profile ? ` --profile ${profile}` : ""}`;
  const describe = profile ? `AWS SSO (profile ${profile})` : "AWS SSO";

  return {
    async getToken() {
      let identity: SsoTokenIdentity;
      try {
        identity = await provider();
      } catch (err) {
        throw new Error(
          `AWS SSO sign-in failed${profile ? ` for profile "${profile}"` : ""}: ` +
            `${(err as Error).message}. Run \`${loginHint}\` and try again.`,
        );
      }
      if (!identity.token)
        throw new Error(`AWS SSO returned no access token. Run \`${loginHint}\` and try again.`);
      const expiresAt = identity.expiration
        ? identity.expiration.getTime()
        : Date.now() + 3_600_000;
      if (expiresAt - Date.now() < MIN_VALIDITY_MS)
        throw new Error(`The AWS SSO session has expired or is about to. Run \`${loginHint}\`.`);
      return { token: identity.token, expiresAt, header: "authorization" };
    },
    describe: () => describe,
  };
}
