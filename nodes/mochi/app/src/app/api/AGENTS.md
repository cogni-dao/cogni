# api · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-03-05
- **Status:** draft

## Purpose

HTTP API endpoints using Next.js App Router. Contract-validated entry points that delegate to feature services.

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [Feature Development Guide](../../../../../docs/guides/feature-development.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "contracts", "shared"],
  "must_not_import": [
    "adapters/server",
    "adapters/worker",
    "core",
    "ports",
    "components"
  ]
}
```

## Public Surface

- **Exports:** none
- **Routes (if any):**
  - `/api/auth/[...nextauth]` [GET, POST]
  - `/api/setup/verify` [POST] - DAO formation verification
  - `/api/internal/billing/ingest` [POST] - LiteLLM generic_api callback receiver (bearer auth, Docker-internal only)
  - `/api/internal/ops/governance/schedules/sync` [POST] - deploy-time governance sync trigger (bearer auth)
  - `/api/v1/chat/completions` [POST] - OpenAI-compatible chat completions (streaming + non-streaming, `cogni_status` extension); see [completions spec](../../../docs/spec/completions-api.md)
  - `/api/v1/ai/chat` [POST] - streaming chat with server-authoritative thread persistence
  - `/api/v1/activity` [GET]
  - `/api/v1/public/attribution/epochs` [GET] - closed epochs list (public, no auth)
  - `/api/v1/public/attribution/epochs/[id]/user-projections` [GET] - closed epoch user projections (public)
  - `/api/v1/public/attribution/epochs/[id]/claimants` [GET] - closed epoch claimant attribution (public)
  - `/api/v1/public/attribution/epochs/[id]/statement` [GET] - epoch statement (public)
  - `/api/v1/attribution/epochs` [GET] - all epochs (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/activity` [GET] - epoch activity events (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/claimants` [GET] - claimant-aware finalized attribution (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/user-projections` [GET, PATCH=410] - read per-user unsigned projections; edits are deprecated
  - `/api/v1/attribution/epochs/[id]/review-subject-overrides` [GET, PATCH, DELETE] - review-time subject overrides (SIWE + approver)
  - `/api/v1/attribution/epochs/[id]/pool-components` [POST] - record pool component (SIWE + approver)
  - `/api/v1/users/me` [GET, PATCH] - current profile
  - `/api/v1/users/me/ownership` [GET] - current ownership summary derived from linked identities
  - `/api/v1/work/items` [GET] - list work items with optional filters (SIWE auth)
  - `/api/v1/work/items/[id]` [GET] - get single work item by ID (SIWE auth)
  - `/api/v1/agent/register` [POST] - unauthenticated machine actor registration (returns Bearer API key)
  - `/api/v1/agent/runs` [GET] - machine-authenticated run list
  - `/api/v1/agent/runs/[runId]/stream` [GET] - machine-authenticated run stream SSE
- **Files considered API:** v1/_/route.ts, admin/_/route.ts

## Responsibilities

- This directory **does**: validate HTTP requests/responses with contracts; delegate to features
- This directory **does not**: contain business logic, direct port usage, or data transformations

## Usage

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Standards

- All routes must validate with contract schemas
- Parse input before processing, parse output before responding
- Use NextResponse for consistent HTTP responses

## Dependencies

- **Internal:** contracts (for validation), shared (for types)
- **External:** next (NextResponse)

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date
- Ensure contract tests pass

## Notes

- v1 API prefix for versioned product routes
