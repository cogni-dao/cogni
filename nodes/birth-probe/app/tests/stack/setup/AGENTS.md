# setup · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Vitest `globalSetup` scripts that run before any stack test. Each script validates a prerequisite and fails fast with actionable instructions.

## Pointers

- [vitest.stack.config.mts](../../../vitest.stack.config.mts) — registers these as `globalSetup`
- [Stack AGENTS.md](../AGENTS.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["shared"],
  "must_not_import": ["adapters", "app", "features", "core", "ports"]
}
```

## Public Surface

- **Exports:** each file exports a default `async function` consumed by vitest globalSetup
- **Env/Config keys:** `TEST_BASE_URL`, `DATABASE_SERVICE_URL`, `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`

## Responsibilities

- This directory **does**: Assert binaries exist (rg, git); wait for HTTP probes (/livez, /readyz); verify LiteLLM → mock-llm routing; verify DB roles; reset test database
- This directory **does not**: Install dependencies; create DB roles; run functional tests

## Usage

Scripts run automatically via `vitest.stack.config.mts` globalSetup in this order:

1. `preflight-binaries.ts` — asserts rg, git in PATH
2. `wait-for-probes.ts` — polls /livez then /readyz
3. `preflight-openclaw-gateway.ts` — polls TCP 3333 for OpenClaw gateway readiness (90s budget)
4. `preflight-mock-llm.ts` — verifies LiteLLM routes to mock-openai-api
5. `preflight-db-roles.ts` — asserts Postgres roles exist
6. `reset-db.ts` — truncates all tables for clean state

## Standards

- Each script is self-contained with a single default export
- Fail fast with clear error messages and fix instructions
- Read-only checks (except reset-db which truncates data)

## Dependencies

- **Internal:** none
- **External:** Running Docker Compose stack (postgres, litellm, mock-llm, app, openclaw-gateway)

## Change Protocol

- Update this file when adding or removing setup scripts
- Update `vitest.stack.config.mts` globalSetup array (order matters)
- Bump **Last reviewed** date

## Notes

- Order in globalSetup matters: probes must pass before DB roles check, DB roles before reset
- `preflight-mock-llm.ts` retries up to 10s with 1s intervals to handle LiteLLM startup delay
