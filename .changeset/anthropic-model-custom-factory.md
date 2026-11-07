---
"attestqa": patch
---

`AnthropicModel` no longer requires an API key or gateway auth token when a custom `factory` is supplied. A custom messages factory owns how it reaches the API, including authentication — the AWS Bedrock provider (`@attestqa/provider-bedrock`) signs requests with AWS credentials and has no API key. The key is still required for the default SDK factory that talks to the Anthropic API, so the normal path is unchanged.
