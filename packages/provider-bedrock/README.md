# @attestqa/provider-bedrock

An [attestqa](https://www.npmjs.com/package/attestqa) provider plug-in: run the
QA agent on **Claude through Amazon Bedrock**, authenticated by the AWS
credential chain — no API key is stored.

## Install

```bash
npm i @attestqa/provider-bedrock
```

attestqa loads the package automatically when your config names the `bedrock`
provider; you do not import it yourself.

## Configure

In `ai-quality.config.yaml`:

```yaml
agent:
  model:
    provider: bedrock
    # The Bedrock model id, or a cross-region inference-profile id:
    name: us.anthropic.claude-3-5-sonnet-20241022-v2:0
```

## Authentication

Bedrock requests are signed with AWS SigV4 using the standard AWS credential
chain, resolved inside the SDK — in order: environment variables, the shared
profile named by `AWS_PROFILE`, the SSO cache written by `aws sso login`, and
instance or task roles. attestqa stores no key and sends no bearer token.

For company single sign-on, run `aws sso login` first; the run then uses that
short-lived session:

```bash
aws sso login --profile my-company
AWS_PROFILE=my-company AWS_REGION=us-east-1 aqa run "AB#123" --config ai-quality.config.yaml
```

Set `AWS_REGION` (or `AWS_DEFAULT_REGION`) to the region your Bedrock models are
enabled in; when unset, the AWS SDK resolves it from your environment or profile.

## What it does and does not change

Only the transport changes. All message assembly, tool-call handling, usage
accounting, retries and timeouts are attestqa's own Anthropic model client, so a
Bedrock run behaves identically to a direct Anthropic run towards the runtime
and its ledger. Governance, approvals and the ledger are unaffected.
