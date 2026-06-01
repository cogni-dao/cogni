# scripts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

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
- **CLI (if any):** Migration, seed, database drop, validation, worktree readiness, and workspace-check/package-build orchestration commands
- **Env/Config keys:** Database connection, development flags, `TURBO_SCM_BASE`/`TURBO_SCM_HEAD` scope overrides, CI-style test env fallbacks for `run-turbo-checks.sh`
- **Files considered API:** validate-agents-md.mjs (validation script), db/drop-test-db.ts (test database utility), diag-openclaw-sandbox.mjs (OpenClaw-in-sandbox diagnostic), grafana-pdc-token-preflight.sh / grafana-postgres-datasource.sh / grafana-postgres-query.sh (Grafana Cloud Postgres support helpers), grafana-apply-alert-rules.sh (Layer 3 alert applier; consumes `infra/grafana/alerts/**`), worktree-check.sh (fresh-worktree readiness check), run-turbo-checks.sh (workspace-scoped local check helper), run-scoped-package-build.mjs (affected package prebuild helper)

## Ports (optional)

- **Uses ports:** Database ports for migrations
- **Implements ports:** none
- **Contracts (required if implementing):** none

## Responsibilities

- This directory **does**: Run migrations, seed data, generate types, development automation, validate AGENTS.md files, manage test databases, run sandbox diagnostic scripts
- This directory **does not**: Contain runtime code, business logic, UI components

## Usage

Minimal local commands:

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
- `run-scoped-package-build.mjs` scopes local package builds against `origin/main` by default, falls back to a full `pnpm packages:build` when global build inputs change, and emits a warning so developers notice the scope expansion.
- `worktree-check.sh` is non-mutating and checks whether a fresh worktree has the minimum local state needed before an agent runs expensive gates.
- `check-fast.sh` and `check-all.sh` run `workspace:lint` via `run-turbo-checks.sh` so local checks catch the same per-workspace Biome/ESLint failures that CI's workspace runs would catch.
- `check-fast.sh` has two modes: default (strict, verify-only; uses `:check` variants; what `.husky/pre-push` gates on) and `--fix` (auto-fix lint/format; exposed as `pnpm check:fast:fix`). Both modes hash working-tree content before and after the run and fail with `✗ drift: files modified during checks` if anything mutated — pre-existing WIP is ignored.
