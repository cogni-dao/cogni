# shared/ai · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable

## Purpose

Shared AI utilities for prompt hashing, model catalog, and tool execution. Pure functions used by adapters and features.

## Pointers

- [AI Setup Spec](../../../../../docs/spec/ai-setup.md)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "adapters",
    "core",
    "ports",
    "contracts"
  ]
}
```

## Public Surface

- **Exports:** `computePromptHash`, `PROMPT_HASH_VERSION`, `isModelAllowed`, `getDefaults`, `createToolRunner`, `ToolRunner`, `EmitAiEvent`, `scrubTraceInput`, `scrubTraceOutput`, `scrubToolInput`, `scrubToolOutput`, `applyUserMaskingPreference`, `applyToolMaskingPreference`, `isValidOtelTraceId`, `truncateSessionId`, `PAYLOAD_LIMITS`, `needsCitationRetry`, `parseCitation`, `validateSources`, `INSUFFICIENT_CITATION_MESSAGE`
- **Env/Config keys:** `LITELLM_BASE_URL` (model-catalog.server.ts)
- **Files considered API:** prompt-hash.ts, model-catalog.server.ts, tool-runner.ts, content-scrubbing.ts, tool-policy.ts, guards/citation.guard.ts

## Responsibilities

- This directory **does:** Compute deterministic prompt hashes, validate models against cached allowlist, execute tools with validation/redaction, scrub sensitive data from trace I/O and operator logs (key-based + regex), enforce payload size limits, validate OTel trace IDs, validate repo citations in AI responses
- This directory **does not:** Perform direct IO, import from adapters or features or ports

## Usage

```bash
pnpm test tests/unit/shared/ai
```

## Standards

- Explicit key ordering for deterministic JSON serialization
- prompt_hash computed only by litellm.adapter.ts

## Dependencies

- **Internal:** @cogni/ai-core, @cogni/ai-tools
- **External:** node:crypto

## Change Protocol

- On hash format change: Bump PROMPT_HASH_VERSION
- On model catalog API change: Update function signatures

## Notes

- Tools excluded from P1 hash until strict canonical schema defined
