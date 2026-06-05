---
id: spec.node-baas-architecture
type: spec
title: Node Backend-as-a-Service Architecture
status: draft
trust: draft
summary: "Product and package shape for node-at-repo-root repos: app code, node-owned packages, managed database/knowledge substrates, and the MVP path from today's node-template."
read_when: "Designing node-template at repo root, deciding node package layout, adding node-owned Postgres or Doltgres schema/client packages, or planning node wizard MVP scope outside CI/CD."
implements: []
owner: cogni-dev
created: 2026-06-05
verified: 2026-06-05
tags:
  - node-template
  - packages
  - databases
  - knowledge
  - node-formation
---

# Node Backend-as-a-Service Architecture

## Context

The [Node CI/CD Contract](./node-ci-cd-contract.md) defines how a submodule node is born, built, pinned, flighted, and promoted. This spec defines the adjacent product shape: what a node repository should look like once `node-template` is a proper **node-at-repo-root** repo.

The useful analogy is Supabase's backend-as-a-service model. A Supabase project centers on Postgres, then exposes integrated services around it: Auth, generated API, Realtime, Storage, Functions, pooler, dashboard, and CLI. Their architecture principle is that tools work in isolation but integrate through APIs and webhooks; their local CLI starts a full local stack rather than only app code. See [Supabase architecture](https://supabase.com/docs/guides/getting-started/architecture) and [Supabase local development](https://supabase.com/docs/guides/local-development).

Cogni should apply the same product idea to AI nodes: a node is not just a Next.js app. It is an app plus managed operational data, versioned knowledge, graph execution, identity, streams, secrets, and deployment declarations. The operator manages substrate provisioning; the node owns code and declarations.

## Goal

Define the stable node repo shape that makes a freshly minted node:

- usable as a standalone developer project;
- inspectable as a small product, not a copied monorepo fragment;
- able to build and push its own image;
- able to declare database, knowledge, graph, secret, and service shape without editing the operator plane;
- compatible with operator-hosted deployment through submodule pinning.

## Non-Goals

- CI/CD workflow details; see [Node CI/CD Contract](./node-ci-cd-contract.md).
- Operator provisioning internals: catalog rendering, AppSets, Caddy routes, OpenBao bootstrap, Argo, DNS.
- A Supabase clone. Cogni should reuse the BaaS mental model, not its exact service list or implementation choices.
- Pre-scaffolding every possible package for every node. Empty packages are tax unless the template needs them on day one.

## Core Model

A node has two sides:

| Side                  | Owner          | Examples                                                                                                                 |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Node product**      | node repo      | `app/`, `packages/`, `k8s/base/`, `.cogni/rules/`, schema declarations, graph definitions                                |
| **Managed substrate** | operator plane | per-env DB provisioning, OpenBao values, ESO manifests, overlays, AppSets, gateway routes, candidate/preview/prod flight |

The node declares **shape**. The operator provisions and connects that shape per environment.

This is the same split already used for submodule nodes: the node repo owns app, packages, base manifests, local policy, and image build; the operator owns catalog, overlays, AppSets, provisioning, flight, and promotion.

### Node-controlled surfaces

A sovereign node must be able to change these without an operator code PR:

| Surface          | Node-owned artifact                                        | Operator reaction                                                                |
| ---------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Operational data | `packages/postgres` schema and migrations                  | provision/apply the node's Postgres migration against that node's DB             |
| Knowledge data   | `packages/doltgres` schema and migrations                  | provision/apply the node's Doltgres migration, then commit DDL into Dolt history |
| Graph behavior   | `packages/graphs` catalog and definitions                  | route execution to the node image and observe runs                               |
| API/tool surface | node-local `packages/contracts` or `app/src/contracts`     | expose only through the node app image unless promoted to shared contracts       |
| Secrets          | `.cogni/secrets-catalog.yaml` key declarations             | create OpenBao paths, ESO manifests, and per-env values                          |
| Storage          | `.cogni/node.yaml` bucket/object declarations              | provision object store credentials and lifecycle policy                          |
| Streams          | `.cogni/node.yaml` stream declarations and event contracts | provision Redis/SSE/WebSocket substrate when enabled                             |
| Runtime shape    | `k8s/base`, health endpoints, ports                        | render overlays, AppSets, gateway routes                                         |

The operator may reject invalid declarations, but it should not require a root package or infra code edit for routine node evolution.

## Node-at-Repo-Root Layout

Target layout:

```text
.
├── app/
├── packages/
│   ├── graphs/
│   ├── postgres/
│   ├── doltgres/
│   ├── contracts/
│   └── domain/
├── k8s/
│   └── base/
├── .cogni/
│   ├── repo-spec.yaml
│   ├── node.yaml
│   ├── rules/
│   └── secrets-catalog.yaml
├── .github/
│   └── workflows/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.json
├── biome.json
└── Dockerfile
```

This is the node-repo view. In the operator monorepo, the same repo appears only as a gitlink at `nodes/<slug>` plus operator-owned catalog/overlay/appset rows.

### `app/`

The runtime application. Today this is the Next.js node app. It owns framework glue, request handlers, UI, bootstrap composition, env assertion, and runtime adapter wiring.

`app/` may import node-owned packages and cross-node baseline packages. Packages must not import `app/`.

### `packages/graphs`

Node-owned graph catalog and graph definitions.

This should be a package when graphs are reusable definitions imported by `app/`, tests, or future workers. If a graph process has lifecycle, the lifecycle entrypoint belongs in `services/`; the graph definitions still belong here.

Current state: the monorepo already has `nodes/<node>/graphs`. For node-at-root, prefer `packages/graphs` unless there is a concrete lifecycle reason to keep a top-level `graphs/` workspace.

### `packages/postgres`

Node-owned operational database package. Suggested package name: `@cogni/<node>-postgres`.

Responsibilities:

- node-local Drizzle schema slices for operational tables;
- inferred row types and public schema exports;
- typed client factory helpers that are schema-coupled but do not load env;
- optional pure adapters that take a DB client as constructor input.

Non-responsibilities:

- runtime env loading;
- root/superuser provisioning;
- per-env DSN construction;
- migrations execution lifecycle.

Those stay in `app/`, CLI scripts, or the operator plane.

Why `postgres` instead of `postgresdbclient+schema`: schema and typed client are coupled enough to live together, but the folder name should stay short and product-readable. The package contents can expose subpaths like `./schema`, `./client`, and `./adapters`.

Do not create this package until the node has node-local operational tables. Core tables shared by every node stay in the cross-node `@cogni/db-schema` / `@cogni/db-client` layer.

### `packages/doltgres`

Node-owned knowledge database package. Suggested package name: `@cogni/<node>-doltgres`.

Responsibilities:

- Doltgres-only Drizzle schema slices;
- inferred row types;
- typed knowledge adapter/client helpers;
- Dolt-specific helpers for commit, log, and diff when they are pure and reusable.

Non-responsibilities:

- operational tables;
- Postgres migrations;
- env loading;
- branch/merge workflow daemons.

The [database-expert skill](../../.claude/skills/database-expert/SKILL.md) and [Knowledge Data Plane](./knowledge-data-plane.md) remain authoritative on the Postgres-vs-Doltgres split: Postgres is hot operational data; Doltgres is AI-written or AI-refined knowledge with useful version history.

The package should avoid table sprawl. Default to generic knowledge rows with `domain` and `tags`; add companion tables only for true entities with distinct columns.

### `packages/contracts`

Optional node-specific API, tool, and event contracts.

Use this when a node has contracts that should be imported by `app/`, graphs, tests, or external node clients but are not universal enough for root `@cogni/node-contracts`.

### `packages/domain`

Optional node-specific pure domain logic.

Use this for policy, scoring, math, and typed domain objects that are not framework-bound and are not cross-node. Do not use it as a dumping ground for feature code.

### `k8s/base`

Node-owned deploy shape only: Deployment/Service shape, ports, health endpoints, and any node-local base manifest that describes what the app is.

Per-env overlays, AppSets, gateway routes, catalog rows, secret values, DNS, and environment ownership stay in the operator plane.

### `.cogni/`

Node control metadata:

- `repo-spec.yaml`: node identity and on-chain bindings;
- `node.yaml`: declared capabilities and substrate requirements;
- `rules/`: review rules and node-local policy;
- `secrets-catalog.yaml`: secret key shape only, never values.

A minted node must be born-reviewable: `.cogni/rules/` ships in the node repo before the first PR against that repo.

## BaaS Substrate Map

Cogni's BaaS surface should be small, composable, and portable:

| Cogni substrate | Node declares                                      | Operator provides                                                  |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Postgres        | `packages/postgres`, migrations, required DSNs     | per-node DB, roles, RLS hardening, backups                         |
| Doltgres        | `packages/doltgres`, migrations, knowledge domains | per-node `knowledge_<node>` DB, migrator wiring, commit validation |
| Auth/RLS        | app routes and tenant context usage                | app/service/read-only roles, DSN secrets                           |
| Graphs          | `packages/graphs` definitions                      | execution host, routing, observability substrate where shared      |
| Streams         | event contracts and consumers                      | Redis/SSE/WebSocket substrate where needed                         |
| Storage         | bucket/object metadata expectations                | object store, credentials, lifecycle policies                      |
| Secrets         | key names and consumers                            | OpenBao values, ESO manifests, rotation path                       |
| Gateway         | service ports and health routes                    | domain, TLS, Caddy/ingress, per-env route                          |
| Studio/Wizard   | node metadata and capabilities                     | operator UI, publish, flight, validation                           |

The invariant is: **node declares shape; operator wires environment**.

## Current State

In the monorepo today:

- root `packages/*` are cross-node/operator-owned packages;
- `pnpm-workspace.yaml` already includes `nodes/*/graphs` and `nodes/*/packages/*`;
- `nodes/node-template/graphs` exists as `@cogni/node-template-graphs`;
- `nodes/node-template/packages/doltgres-schema` exists as `@cogni/node-template-doltgres-schema`;
- `nodes/operator/packages/doltgres-schema` and `nodes/canary/packages/doltgres-schema` also exist;
- node-template does not have a node-owned Postgres schema package because it currently has no node-local operational tables;
- the active submodule design expects a node-at-root template with `app/`, `graphs/`, `k8s/`, `packages/`, own CI, and own policy.

The proposed product shape is therefore not a greenfield rewrite. It is a naming and ownership cleanup around patterns already present.

### Current package audit

A 2026-06-05 package import audit found that most root packages are genuine shared substrate:

- app-wide platform packages are imported by `canary`, `node-template`, `operator`, and `resy`: `@cogni/ai-core`, `@cogni/ai-tools`, `@cogni/db-client`, `@cogni/db-schema`, `@cogni/ids`, `@cogni/node-contracts`, `@cogni/node-core`, `@cogni/node-shared`, `@cogni/node-streams`, `@cogni/node-ui-kit`, `@cogni/scheduler-core`, `@cogni/work-items`;
- graph substrate is shared: `@cogni/langgraph-graphs`, `@cogni/graph-execution-core`, `@cogni/graph-execution-host`;
- knowledge substrate is shared: `@cogni/knowledge-base` is imported by node-local Doltgres schema packages, and `@cogni/knowledge-store` is imported by apps and Doltgres packages;
- some root packages are operator-plane utilities rather than node-product packages: `@cogni/dns-ops`, `@cogni/temporal-workflows`, attribution pipeline packages.

So the first migration should not be a broad carve-out from root `packages/`. Moving shared substrate into a node would make the template look cleaner but would damage the current dependency truth.

## Playbook

Use this playbook when deciding whether to move or create a package.

### Step 1 - Classify the package

| Question                                                                  | Destination                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Imported by two or more node apps/graphs/packages?                        | root `packages/<name>`                                                          |
| Imported only by one node repo's `app`, `packages`, or graph definitions? | node repo `packages/<name>`                                                     |
| Imported only by operator-plane code or root services?                    | root `packages/<name>` unless it is strictly `nodes/operator/app` product logic |
| Has process lifecycle, health checks, env loading, or worker loop?        | `services/<name>` or `app/`, not `packages/`                                    |
| Is a DB schema package with node-local tables?                            | node repo `packages/postgres` or `packages/doltgres`                            |

### Step 2 - Check real consumers

Run both package-declaration and import checks. Stale `package.json` dependencies are common enough that declarations alone are not authoritative.

```bash
rg -n '"@cogni/<name>"|from "@cogni/<name>"|from "@cogni/<name>/' \
  nodes packages services tests scripts \
  -g 'package.json' -g '*.{ts,tsx,js,mjs}'
```

Then classify only code importers under:

```text
nodes/<node>/app
nodes/<node>/graphs
nodes/<node>/packages/*
```

as node-product consumers. Root `packages`, `services`, `scripts`, CI, and operator provisioning are operator-plane or shared-substrate consumers.

### Step 3 - Move one package at a time

For a node-owned package move:

1. move the directory into `packages/<bare-name>` in the node-at-root repo, or `nodes/<node>/packages/<bare-name>` in the monorepo;
2. rename the package to `@cogni/<node>-<bare-name>`;
3. update import names and package declarations;
4. update `tsconfig` project references and package build validation;
5. run `pnpm packages:build` plus the package's targeted typecheck/tests;
6. avoid compatibility shims unless an actual external consumer is blocked.

For node-template projection work, prefer changing the projected node-at-root repo first. Inline monorepo nodes can keep their old shape until the projection proves the model.

## Pareto Package Priority

The highest-value moves, based on the current package layout, are:

| Priority | Move                                                                                                                       | Why                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `nodes/node-template/graphs` → node-at-root `packages/graphs`                                                              | Makes the new node repo read as one product with a package layer; low conceptual risk because it is already node-local.           |
| 2        | node-at-root `packages/doltgres-schema` → `packages/doltgres`                                                              | Names the knowledge plane by capability instead of implementation detail; keeps schema/client/adapter helpers together.           |
| 3        | Add node-at-root `.cogni/node.yaml`                                                                                        | Gives the wizard/operator a compact substrate declaration without moving code.                                                    |
| 4        | Add `packages/postgres` only when a node-local operational table appears                                                   | Avoids empty scaffolding while preserving the intended split.                                                                     |
| 5        | Audit operator-only root packages separately: `@cogni/temporal-workflows`, `@cogni/dns-ops`, attribution pipeline packages | These may be operator-plane packages, not node packages. Moving them is lower value than fixing the node-template artifact shape. |

Packages that should **not** move in the MVP: `@cogni/db-client`, `@cogni/db-schema`, `@cogni/knowledge-base`, `@cogni/knowledge-store`, `@cogni/langgraph-graphs`, `@cogni/graph-execution-core`, `@cogni/graph-execution-host`, `@cogni/node-contracts`, `@cogni/node-core`, `@cogni/node-shared`, `@cogni/node-ui-kit`. They are shared substrate today.

## MVP

The MVP should not reorganize every package. It should make newly minted node repos feel coherent while preserving current deployment progress.

### M0 - Document and freeze the product shape

Land this spec and link it from the CI/CD contract. Treat it as the target shape for future node-at-root work.

No code moves.

### M1 - Normalize the node-at-root template package layout

In the node-template repo projection, prefer:

```text
packages/graphs
packages/doltgres
```

over:

```text
graphs
packages/doltgres-schema
```

Only do this in the node-at-root template lane, not as a drive-by across inline monorepo nodes. The monorepo can keep `nodes/<node>/graphs` temporarily because the CI/CD contract already names `graphs/` as carried content.

Acceptance:

- the generated node repo has a simple `packages/*` library layer;
- app imports use workspace names;
- local `pnpm packages:build` or equivalent builds the graph and Doltgres package;
- no operator build target treats the node package as root operator content.

### M2 - Rename Doltgres package by capability, not implementation detail

Move from `doltgres-schema` to `doltgres` in the node-at-root template.

Keep exports explicit:

```text
@cogni/<node>-doltgres
@cogni/<node>-doltgres/knowledge
@cogni/<node>-doltgres/work-items
```

If the migration blast radius is high, keep `doltgres-schema` in inline nodes and make the new name part of the projected template only. Do not add a compatibility shim unless a real consumer requires it.

### M3 - Add `packages/postgres` only when the template has a local table

Do not scaffold an empty Postgres package. The current database contract says node-local Postgres schema packages are created on first node-local table.

When needed, use:

```text
packages/postgres
```

with exports:

```text
@cogni/<node>-postgres
@cogni/<node>-postgres/schema
@cogni/<node>-postgres/client
```

The package must not read env. Runtime code passes DSNs or DB clients from `app/`.

### M4 - Add one node manifest for substrate declarations

Introduce `.cogni/node.yaml` as the node's compact substrate declaration:

```yaml
postgres:
  enabled: true
doltgres:
  enabled: true
graphs:
  package: "@cogni/<node>-graphs"
storage:
  enabled: false
streams:
  enabled: false
```

This should be declarative only. The operator can later consume it during publish/provisioning, but the MVP value is making the node's expected substrates visible to agents and humans.

### M5 - One-command local substrate

Add a node-local command equivalent to Supabase local dev:

```bash
pnpm dev:stack
```

It should start the app plus the minimum local substrates for that node: Postgres, Doltgres when enabled, Redis only if streams are enabled, and any local mock services required by the template.

This is the product MVP. A new node dev should clone the node repo, run one setup command, and see the node operate against local managed substrates.

## Decision Rules

1. Root `packages/*` in the operator monorepo are cross-node packages.
2. Node-at-root `packages/*` are node-owned packages.
3. Schema plus typed client can live in the same node-owned DB package, but env loading cannot.
4. Postgres and Doltgres stay in separate packages because they are separate planes.
5. Graph definitions should be a package; graph process lifecycle, if any, should be a service.
6. Empty packages are avoided unless they are part of the template's first-run experience.
7. The operator never builds node code for a submodule node; it consumes the node's image and metadata.
8. Routine node evolution should be a node PR: Postgres schema, Doltgres schema, graph definitions, contracts, secret declarations, storage/stream declarations, and base runtime shape.
