# adapters/server/ai-telemetry · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

AI telemetry adapters for recording invocation summaries and Langfuse trace correlation. DrizzleAiTelemetryAdapter writes to ai_invocation_summaries table; LangfuseAdapter provides optional trace sink.

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [AI Setup](../../../../../../docs/spec/ai-setup.md)
- [Parent adapters AGENTS.md](../../AGENTS.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core", "contracts"]
}
```

## Public Surface

- **Exports:**
  - DrizzleAiTelemetryAdapter (implements AiTelemetryPort)
  - LangfuseAdapter (implements LangfusePort)
- **Env/Config keys:** LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL (all optional); DEPLOY_ENVIRONMENT (passed via constructor for trace filtering)
- **Files considered API:** drizzle.adapter.ts, langfuse.adapter.ts

## Ports

- **Uses ports:** none
- **Implements ports:** AiTelemetryPort, LangfusePort
- **Contracts:** tests/contract/ (port compliance)

## Responsibilities

- **This directory does:**
  - Write AI invocation summaries to PostgreSQL (DrizzleAiTelemetryAdapter)
  - Create Langfuse traces with OTel traceId correlation (LangfuseAdapter)
  - Provide idempotent writes via invocation_id unique constraint
  - Handle graceful degradation (DB adapter swallows errors; Langfuse adapter throws for caller handling)
- **This directory does not:**
  - Contain business logic or pricing calculations
  - Handle HTTP routing or UI
  - Store prompts/responses (per AI_SETUP_SPEC.md redaction policy)

## Usage

```bash
pnpm test tests/contract/
pnpm test:stack tests/stack/ai/
```

## Standards

- DrizzleAiTelemetryAdapter swallows all errors (telemetry is best-effort)
- LangfuseAdapter.createTrace() throws on failure; caller handles graceful degradation
- Both adapters wired in bootstrap/container.ts (Langfuse only when env vars set)

## Dependencies

- **Internal:** @/ports (AiTelemetryPort, LangfusePort), @/shared/db/schema, @/shared/observability
- **External:** drizzle-orm, langfuse

## Change Protocol

- Update this file when Exports or Env/Config change
- Bump Last reviewed date
- Ensure contract tests pass

## Notes

- Per AI_SETUP_SPEC.md: langfuse_trace_id equals OTel traceId for correlation
- DrizzleAiTelemetryAdapter always wired; LangfuseAdapter optional (env-gated)
