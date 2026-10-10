/**
 * A short-lived credential, fetched before every model request.
 *
 * Company sign-in (Microsoft Entra ID, AWS SSO) gives tokens that expire in
 * minutes to hours, not keys that live in a file. A TokenSource hides how the
 * token is obtained; the model client only asks for a valid one each time it
 * sends. Nothing it returns is written to the ledger, a log or a config file —
 * the scrubber removes it from any error text as well.
 */
export interface Token {
  /** The credential itself. */
  token: string;
  /** Epoch milliseconds after which it must not be used. */
  expiresAt: number;
  /** Which header carries it. "authorization" sends `Bearer <token>`. Default "authorization". */
  header?: "authorization" | "api-key";
}

export interface TokenSource {
  /** Must return a token valid for at least the next 60 seconds. */
  getToken(): Promise<Token>;
  /** Shown to the user, e.g. "Microsoft Entra ID: vijay@acme.com". Never the token. */
  describe(): string;
}

/** Headers for one request from a token. */
export function tokenHeaders(t: Token): Record<string, string> {
  return (t.header ?? "authorization") === "authorization"
    ? { authorization: `Bearer ${t.token}` }
    : { "api-key": t.token };
}
