---
"attestqa": minor
---

Claude through a company gateway: attestqa now reads the same two settings Claude Code uses, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, so a machine where Claude Code works through the company's LLM gateway (including gateways in front of Bedrock, Vertex or Foundry) runs attestqa with no new key. `agent.model.endpoint` can set the gateway per project. The run's first line names the gateway and the credential variable, never the value. `aqa init` asks which model route the company uses (Claude gateway, Anthropic key, Azure OpenAI, or an OpenAI-compatible gateway) and points Copilot users to the VS Code extension, the only supported place to use Copilot's models.
