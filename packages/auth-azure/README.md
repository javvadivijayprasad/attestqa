# @attestqa/auth-azure

An [attestqa](https://www.npmjs.com/package/attestqa) sign-in plug-in: use a
short-lived **Microsoft Entra ID** (Azure AD) access token as the model
credential, so no API key is stored.

## Install

```bash
npm i @attestqa/auth-azure
```

attestqa loads it automatically when your config sets `auth: entra`.

## Configure

```yaml
agent:
  model:
    provider: azure-openai                  # or openai / gateway
    name: gpt-4.1
    endpoint: https://acme.openai.azure.com
    auth: entra
```

Then sign in and run — the token comes from your Azure session:

```bash
az login
aqa run "AB#123" --config ai-quality.config.yaml
```

## How it signs in

The plug-in uses `@azure/identity`'s `DefaultAzureCredential`, which tries, in
order: the `AZURE_*` environment variables (client credentials / workload
identity), a managed identity, the Azure CLI (`az login`), Azure PowerShell and
VS Code. Nothing is stored by attestqa — the token is fetched fresh for each
request and scrubbed from logs and the ledger.

The token **audience** is its scope. The default is Azure OpenAI
(`https://cognitiveservices.azure.com/.default`); set `AZURE_TOKEN_SCOPE` to a
different resource, such as a gateway's own app-registration scope
(`api://<app-id>/.default`). Set `AZURE_TENANT_ID` to pin the tenant.
