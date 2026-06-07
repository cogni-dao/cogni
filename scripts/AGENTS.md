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
- **Files considered API:** setup/bootstrap.sh and setup/provision-env-vm.sh (bootstrap/provisioning), conductor-worktree-setup.sh (Conductor workspace bootstrap), validate-agents-md.mjs (validation script), db/drop-test-db.ts (test database utility), diag-openclaw-sandbox.mjs (OpenClaw-in-sandbox diagnostic), grafana-pdc-token-preflight.sh / grafana-postgres-datasource.sh / grafana-postgres-query.sh (Grafana Cloud Postgres support helpers), worktree-check.sh (fresh-worktree readiness check), run-turbo-checks.sh (workspace-scoped local check helper), run-scoped-package-build.mjs (affected package declaration helper), ci/sync-node-template-fork-pr.sh (repeatable node-template fork PR refresh)

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
- `conductor-worktree-setup.sh` is the Conductor setup entrypoint. It symlinks `.env.cogni` and `.local-auth` from the primary checkout so secrets and captured auth do not drift across worktrees.
- `run-scoped-package-build.mjs` scopes local package declaration refreshes against `origin/main` by default, falls back to all declaration refs when global build inputs change, and emits a warning so developers notice the scope expansion. JavaScript package artifacts belong to explicit `pnpm packages:build`, not `check:fast`.
- `worktree-check.sh` is non-mutating and checks whether a fresh worktree has the minimum local state needed before an agent runs expensive gates.
- For PR verification, push and monitor GitHub checks. `check-fast.sh` and `check-all.sh` exist for explicit local repro or human-requested local validation; they run `workspace:lint` via `run-turbo-checks.sh` so local checks catch the same per-workspace Biome/ESLint failures that CI's workspace runs would catch.
- Fast Vitest configs resolve workspace package imports from source so app tests do not depend on ignored `dist` JavaScript freshness; explicit `pnpm packages:build` and CI still validate package artifacts.
- `check-fast.sh` has two modes: default (strict, verify-only; uses `:check` variants; what `.husky/pre-push` gates on) and `--fix` (auto-fix lint/format; exposed as `pnpm check:fast:fix`). Both modes hash working-tree content before and after the run and fail with `✗ drift: files modified during checks` if anything mutated — pre-existing WIP is ignored.
