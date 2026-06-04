# analytics · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Public analytics backend service providing privacy-preserving aggregated platform metrics via k-anonymity suppression.

## Pointers

- [Analytics Service](services/analytics.ts)
- [Analytics Contract](../../contracts/analytics.summary.v1.contract.ts)
- [Metrics Observability Docs](../../../../../docs/spec/public-analytics.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["ports", "shared"],
  "must_not_import": ["contracts", "app", "adapters", "bootstrap"]
}
```

## Public Surface

- **Exports:** `getAnalyticsSummary` service function
- **Routes (if any):** none (used by `/api/v1/public/analytics/summary` via facade)
- **Env/Config keys:**
  - `ANALYTICS_K_THRESHOLD` (default: 50)
  - `ANALYTICS_QUERY_TIMEOUT_MS` (default: 5000)
  - `DEPLOY_ENVIRONMENT` (for env filter in queries)
- **Files considered API:** `services/analytics.ts`

## Ports

- **Uses ports:** `MetricsQueryPort` for Prometheus/Mimir queries
- **Implements ports:** none
- **Contracts (required if implementing):** none

## Responsibilities

- This directory **does**: Query metrics, apply k-anonymity suppression, aggregate timeseries
- This directory **does not**: Handle HTTP, validate contracts, perform authentication, execute metrics queries directly

## Usage

```bash
pnpm test tests/unit/features/analytics/
pnpm typecheck
```

## Standards

- Unit tests required for k-anonymity logic
- Window validation enforced (7d/30d/90d only)
- All queries include env and app filters
- No PII in outputs

## Dependencies

- **Internal:** `@/ports` (MetricsQueryPort)
- **External:** none

## Change Protocol

- Update this file when service exports or env keys change
- Bump **Last reviewed** date
- Ensure unit tests cover privacy guarantees

## Notes

- K-anonymity threshold configurable via `ANALYTICS_K_THRESHOLD`
- Buckets with request count < K return null values
- Environment isolation enforced via server-side env filter
