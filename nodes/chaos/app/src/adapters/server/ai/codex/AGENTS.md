# codex · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Codex SDK adapter for BYO ChatGPT execution. Spawns `codex exec` subprocess per LLM call with isolated auth + MCP config. Env vars scoped to prevent secret leakage.

## Pointers

- [Codex MCP docs](https://developers.openai.com/codex/mcp)
- [bug.0232](../../../../../../../work/items/bug.0232.llmservice-silently-drops-tools.md): MCP tool drop fix
- [mcp-control-plane spec](../../../../../../../docs/spec/mcp-control-plane.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** `CodexLlmAdapter` (LlmService impl), `CodexMcpConfig` (type), `mcpServersToCodexConfig` (converter)
- **Env/Config keys:** none directly (receives MCP config at construction via provider)

## Responsibilities

- Implements LlmService for ChatGPT models via Codex SDK subprocess
- Generates config.toml for Codex-native MCP server access
- Scopes env vars to prevent secret leakage to subprocess
- Logs WARN when tools are passed but cannot be used via OpenAI function-calling format

## Standards

- `CODEX_ENV_SCOPED`: Subprocess receives only whitelisted env vars
- `NO_SILENT_TOOL_DROP`: WARN log when tools passed but adapter cannot use OpenAI function-calling format
- `INVARIANT_DEVIATION: TOOLS_VIA_TOOLRUNNER`: Codex calls MCP tools directly via config.toml, bypassing toolRunner.exec()
- `KNOWN_DEVIATION: ALL_SERVERS_VISIBLE`: All configured MCP servers visible to Codex (not filtered per-graph)

## Notes

- Codex SDK `config` constructor option can replace config.toml file write in future (eliminates TOML generation)
- Per-graph MCP server filtering deferred to ToolHive Phase 3
