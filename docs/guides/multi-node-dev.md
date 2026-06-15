---
id: guide.multi-node-dev
type: guide
title: Multi-Node Development Guide
status: draft
trust: draft
summary: Layout, dev commands, testing, and DB setup for running operator + node apps locally
read_when: Running multi-node dev stack, adding a new node, or debugging node auth
owner: derekg1729
created: 2026-04-01
verified: null
tags: [nodes, dev, infrastructure]
---

# Multi-Node Development Guide

## Layout

```
nodes/operator/         → Operator dashboard (port 3000)
nodes/node-template     → Gitlink pin to the external node-template repo
nodes/<legacy>/         → Transitional in-tree node source, pending externalization
```

The forward model is node-at-root source repos pinned into the operator repo as
`nodes/<slug>` gitlinks. A checked-out external node owns its own `app/`,
`graphs/`, packages, CI, and tests in that source repo. Remaining in-tree node
directories are migration surfaces, not the pattern for new work.

## Running Locally

```bash
# Start infra + operator (always first)
pnpm dev:stack                   # infra + operator on :3000

# Then add remaining in-tree legacy nodes in separate terminals
pnpm dev:resy                    # resy on :3300

# Or start everything at once (one terminal)
pnpm dev:stack:full              # infra + operator + remaining in-tree nodes
```

Auth is shared — sign in on any port, the cookie works on all (same `localhost`).

```bash
# Docker (containerized) — TODO: task.0247 adds per-node containers
pnpm docker:stack:full           # currently launches operator only
```

## Typechecking

```bash
# Operator (default, runs in pnpm check)
pnpm typecheck

# Remaining in-tree legacy nodes (from repo root, transitional)
pnpm typecheck:resy
```

All parent-repo typecheck commands run from the repo root using `tsc -p <path>/tsconfig.app.json`.
Gitlink-pinned nodes such as `node-template` typecheck in their own source repo.
Each node app tsconfig overrides `@/*` paths to resolve to its own `src/`.

## Testing

```bash
# Operator tests (unit + contract, no server needed)
pnpm test

# Operator stack tests (requires dev:stack:test running)
pnpm test:stack:dev

# Remaining in-tree node-specific tests (from repo root, transitional)
pnpm --filter @cogni/resy-app test
pnpm --filter @cogni/resy-graphs test
```

## Pre-commit Gate

```bash
pnpm check          # Operator: typecheck + lint + format + tests + docs + arch
```

External node checks run in the node source repo. Remaining in-tree node
typechecks are not yet in the `pnpm check` pipeline; run them manually only
when touching those transitional directories.

## Creating a New Node

Do not copy an in-tree directory. Create or fork the node-at-root source repo
from `Cogni-DAO/node-template`, then add it to the operator repo as a
`nodes/<slug>` gitlink plus catalog/deploy wiring. The node source repo owns its
own package scripts, lockfile, graph catalog, tests, and image build.

## Database & Auth

**Each node has its own Postgres database.** Operator → `cogni_template_dev`,
poly → `cogni_poly`, resy → `cogni_resy`. Dev URLs live in `.env.local` as
`DATABASE_URL`, `DATABASE_URL_POLY`, `DATABASE_URL_RESY`. Production k8s
overlays patch the DB secret per node the same way.

**Schema source (task.0324):** each node owns its own drizzle config + migrations:

- **Core tables** live in `@cogni/db-schema` (`packages/db-schema/`) — cross-node platform surface (auth, billing, identity, etc.).
- **Node-local tables** live in `@cogni/<node>-db-schema` workspace packages under `nodes/<node>/packages/db-schema/`. Today only `@cogni/poly-db-schema` exists (copy-trade prototype). Per-node packages are spun up when a node ships its first node-local table.
- **Per-node drizzle configs** at `nodes/<node>/drizzle.config.ts`. Each config's schema glob unions core + its node-local package source. drizzle-kit reads raw TS — no dist/ needed for migration generation.
- **Migrations dir** at `nodes/<node>/app/src/adapters/server/db/migrations/` — node-owned. The shared-era `0027_silent_nextwave.sql` is byte-duplicated across operator/poly/resy dirs (tripwire READMEs in each explain why — do not delete).

```bash
pnpm db:setup           # provision cogni_template_dev + migrate + seed (operator)
pnpm db:migrate:dev     # operator DB via nodes/operator/drizzle.config.ts
pnpm db:migrate:poly    # cogni_poly via nodes/poly/drizzle.config.ts
pnpm db:migrate:resy    # cogni_resy via nodes/resy/drizzle.config.ts
pnpm db:migrate:nodes   # run all three in sequence
pnpm db:generate:poly   # generate a new migration for poly (schema diff)
```

**Migrator images:** each deployed node ships its own migrator image (`cogni-template:TAG-{operator,poly,resy}-migrate`) built from its own Dockerfile `migrator` stage. Argo PreSync Jobs invoke the image's default CMD (`pnpm db:migrate:<node>:container`) per-node.

**Production migration gap:** the production k8s overlays for poly and resy currently ship a no-op migration Job (`exit 0` — see `infra/k8s/overlays/production/{poly,resy}/kustomization.yaml`). Preview + candidate-a DO migrate. Un-no-opping prod is task.0324 Phase 3 (follow-up, gated on `pg_dump` DB-state inspection).

**Auth:** Because each node has its own DB, NextAuth session rows do **not** transit between nodes. Signing in on poly creates a session row in `cogni_poly`; the same cookie on operator authenticates against `cogni_template_dev` separately. Shared `AUTH_SECRET` means JWT decoding works across ports, but DB-backed session state is per-node. OAuth redirects are scoped to the right port via the `NEXTAUTH_URL_*` env vars set by the `dev:stack:*` scripts.

**Future upgrade (task.0325):** Atlas + GitOps migrations — declarative schema, destructive-change linting, `AtlasMigration` CRD replacing PreSync Jobs. Deferred pending contributor-scale triggers.

## Architecture Notes

- Each node app is a **full platform copy** of the operator (auth, chat, streaming,
  billing, treasury) minus the DAO formation wizard
- Node-specific features (e.g. resy's reservations) live in `app/src/features/`
- Shared packages (`@cogni/ai-tools`, `@cogni/market-provider`, etc.) are in `packages/`
- Each node has its own DB + its own drizzle config + its own migrator image (task.0324). Core tables live in `@cogni/db-schema`; node-local tables live in `@cogni/<node>-db-schema` workspace packages under `nodes/<node>/packages/db-schema/`.
- Future: task.0248 will extract the shared platform into `packages/node-platform`
  so nodes become thin shells instead of full copies
