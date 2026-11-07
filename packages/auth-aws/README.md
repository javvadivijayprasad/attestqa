# @attestqa/auth-aws

An [attestqa](https://www.npmjs.com/package/attestqa) sign-in plug-in: use a
short-lived **AWS IAM Identity Center (SSO)** access token as the model
credential, so no API key is stored.

> **Not for Bedrock.** Claude on Amazon Bedrock authenticates with AWS SigV4
> credentials, handled by [`@attestqa/provider-bedrock`](https://www.npmjs.com/package/@attestqa/provider-bedrock).
> Use this package only when a **non-Bedrock** endpoint (an OpenAI-compatible
> server, a gateway, or Azure OpenAI) accepts your AWS SSO access token as a
> bearer token.

## Install

```bash
npm i @attestqa/auth-aws
```

attestqa loads it automatically when your config sets `auth: aws-sso`.

## Configure

```yaml
agent:
  model:
    provider: gateway                       # or openai / azure-openai
    name: approved-large
    endpoint: https://llm-gateway.acme.internal/v1
    auth: aws-sso
```

Then sign in and run — the token comes from your `aws sso login` session:

```bash
aws sso login --profile my-company
AWS_PROFILE=my-company aqa run "AB#123" --config ai-quality.config.yaml
```

The profile is read from `AWS_PROFILE`. The plug-in reads and refreshes the SSO
access token from `~/.aws/sso/cache` using the AWS SDK; if the session is
missing or expired, the run stops and tells you to run `aws sso login` again.
attestqa stores nothing — the token is fetched fresh for each request and
scrubbed from logs and the ledger.
