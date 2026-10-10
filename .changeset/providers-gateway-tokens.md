---
"attestqa": minor
---

Model providers: a `gateway` provider for a company's own OpenAI-compatible gateway (endpoint required, non-secret headers allowed, any header that looks like a credential refused at load time, key from `AQA_GATEWAY_API_KEY`). `agent.model.auth` (`key` | `none` | `entra` | `aws-sso`) and a `TokenSource` interface, so company sign-in can supply a fresh short-lived token for every request instead of a stored key. `registerProvider()` lets plug-ins such as `@attestqa/provider-bedrock` add providers without the core depending on them. A shared conformance suite now runs against every OpenAI-compatible provider.
