# scripts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Last reviewed:** 2026-10-22

## Purpose

Build-time scripts for migrations, seeds, type generation, development utilities, database management, and documentation validation.

## Pointers

- [Root AGENTS.md](../AGENTS.md)
- [Architecture](../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "scripts",
  "may_import": ["scripts", "ports", "shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "core",
    "adapters/server",
    "adapters/worker",
    "adapters/cli"
  ]
}
```

## Public Surface

- **Exports:** none
- **CLI (if any):** `scripts/vm-health-snapshot.mjs` (read-only per-env VM verdict graded only by `packages/node-contracts/src/reliability-policy.v1.json` via recorded `cogni_reliability_v1_*` series, plus ungraded consumer/fault detail and the policy-`objectives` soak lines (24h node availability, throttle-controller liveness, backup receipts; same numbers as the Fleet Reliability dashboard top row, never the VM verdict); exit 0/1/2 GREEN/YELLOW/RED-or-UNKNOWN, 3 usage, 4 Grafana unreachable), `scripts/ops/maintenance-drain.mjs` (historical read-only candidate evidence tooling, disconnected from ordinary delivery; no close or desired-state mutation), `scripts/lib/run-node-substrate.ts` (placement-aware day-2 readiness; shared and non-production lanes delegate to the existing runner), migration, seed, database drop, validation, worktree readiness, and workspace-check/package-build orchestration commands
- **Env/Config keys:** `GRAFANA_URL` (https) + `GRAFANA_SERVICE_ACCOUNT_TOKEN` (or `COGNI_ENV_FILE`/`.env.cogni`) for `vm-health-snapshot.mjs`; runner-only `CI_SOURCE_ROOT`, `APP_SOURCE_ROOT`, `CONTROL_ENV` for candidate inventory; Database connection, development flags, `TURBO_SCM_BASE`/`TURBO_SCM_HEAD` scope overrides, CI-style test env fallbacks for `run-turbo-checks.sh`, explicit `SET_SECRET_EXPECTED_VERSION` for the canonical CLI’s three allowed dynamic manual-cell input keys
- **Configured cognition:** Optional `.cogni/cognition-sources.json` uses `version`, `nodeId`, and ordered `requiredKnowledgeIds`; `COGNI_NODE_API_KEY` authenticates same-node canonical reads. `agent/configured-cognition.mjs` supports native presentation, read-only `--cached-contract`, and bounded `--refresh`; loading context does not adopt roles or grant permissions.
- **Files considered API:** setup/bootstrap.sh and setup/provision-env-vm.sh (bootstrap/provisioning), conductor-worktree-setup.sh (Conductor workspace bootstrap), validate-agents-md.mjs (validation script), db/drop-test-db.ts (test database utility), grafana-pdc-token-preflight.sh / grafana-postgres-datasource.sh / grafana-postgres-query.sh (Grafana Cloud Postgres support helpers), worktree-check.sh (fresh-worktree readiness check), run-turbo-checks.sh (workspace-scoped local check helper), run-scoped-package-build.mjs (affected package declaration helper)

## Ports (optional)

- **Uses ports:** Database ports for migrations
- **Implements ports:** none
- **Contracts (required if implementing):** none

## Responsibilities

- This directory **does**: Run migrations, seed data, generate types, development automation, validate AGENTS.md files, manage test databases, run sandbox diagnostic scripts
- This directory **does not**: Contain runtime code, business logic, UI components

## Usage

Use local script commands for setup, data tasks, docs metadata, or a targeted repair:

```bash
node scripts/migrate.ts
node scripts/seed-db.ts
tsx scripts/db/drop-test-db.ts  # Drop test database (safety-guarded)
pnpm check:agentsmd             # Validate all AGENTS.md files
```

## Standards

- Build-time only execution
- No production dependencies

## Dependencies

- **Internal:** shared/, adapters/, bootstrap/
- **External:** Database clients, development tools

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Ensure boundary lint + (if Ports) **contract tests** pass

## Notes

- Scripts must be idempotent and safe to re-run
- AGENTS.md validator enforces hexagonal import standards for AGENTS.md
- `conductor-worktree-setup.sh` is the Conductor setup entrypoint. It ensures the primary checkout has `COGNI_NODE_API_KEY`, then symlinks `.env.cogni` and `.local-auth` from the primary checkout so secrets and captured auth do not drift across worktrees. Dependency setup prefers the local pnpm store, fetches newly pinned packages when absent, and retries one transient install failure.
- `run-scoped-package-build.mjs` scopes local package declaration refreshes against `origin/main` by default, falls back to all declaration refs when global build inputs change, and emits a warning so developers notice the scope expansion. JavaScript package artifacts belong to explicit `pnpm packages:build`, not `check:fast`.
- `worktree-check.sh` is non-mutating and checks whether a fresh worktree has the minimum local state needed before an agent runs expensive gates.
- `dev:stack` runs the maintained Compose stack plus host app and captures raw logs in `.context/dev-logs/app.log`; pipeline failures propagate. Dev Alloy collects this file for local request/run correlation.
- `dev/verify-local-stack.mjs` (`pnpm dev:verify`) checks loopback app deep readiness, worker readiness, gateway model discovery, Studio/node Cogni discovery and authenticated knowledge/work point reads. It accepts `--identity <private-local-registration.json>` or `COGNI_LOCAL_API_KEY`; `--knowledge` and `--work-item` select fixtures. It never invokes a model or sends credentials to remote targets.
- For PR verification, push and monitor GitHub checks. `check-fast.sh` and `check-all.sh` exist for explicit local repro or human-requested local validation; they run `workspace:lint` via `run-turbo-checks.sh` so local checks catch the same per-workspace Biome/ESLint failures that CI's workspace runs would catch.
- Fast Vitest configs resolve workspace package imports from source so app tests do not depend on ignored `dist` JavaScript freshness; explicit `pnpm packages:build` and CI still validate package artifacts.
- `check-fast.sh` has two modes: default (strict, verify-only; uses `:check` variants; what `.husky/pre-push` gates on) and `--fix` (auto-fix lint/format; exposed as `pnpm check:fast:fix`). Both modes hash working-tree content before and after the run and fail with `✗ drift: files modified during checks` if anything mutated — pre-existing WIP is ignored.
