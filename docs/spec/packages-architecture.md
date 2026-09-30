---
id: packages-architecture-spec
type: spec
title: Packages Architecture
status: active
spec_state: draft
trust: draft
summary: Curated @cogni/* libraries — pure TypeScript boundaries consumed in-workspace or released as immutable public packages for sovereign nodes.
read_when: Creating a new package, debugging package builds, or working with @cogni/* imports.
owner: derekg1729
created: 2026-02-06
verified: 2026-04-28
tags: [infra, meta]
---

# Packages Architecture

## Context

The `packages/` directory contains **cross-node** packages — pure TypeScript libraries with no `src/` or `services/` imports, consumed by two or more nodes. Each package declares its target environment (isomorphic or node-only) via tsconfig/tsup. Packages remain workspace-private by default; a reviewed subset is released as immutable public packages when sovereign repositories need the same behavior without copying source.

**Single-node packages live under `nodes/<X>/packages/`** — same shape rules as cross-node packages, but ownership is scoped so changes don't trip `single-node-scope`. See [Node CI/CD Contract § Node-owned packages](./node-ci-cd-contract.md#node-owned-packages) for the carve-out rule, naming convention (`@cogni/<node>-<bare-name>`), and the carve-out playbook.

## Goal

Provide a shared-library layer (`@cogni/*`) with strict isolation from the app (`src/`) and services (`services/`), built via TypeScript project references and consumed through curated `dist/` exports. The same boundary supports workspace development and exact-version cross-repository distribution.

## Non-Goals

- Deployable services with process lifecycle (those belong in `services/`)
- Feature-specific UI (feature wrappers, layouts, route components — those belong in `src/features/` or `src/components/kit/`)
- Publishing every workspace package. Publication is explicit and limited to stable, pure, cross-repository contracts.

**Carve-out for baseline UI primitive packages.** A package MAY contain framework-agnostic vendored UI primitives (e.g. shadcn/Radix wrappers, reui table kit) when **all** of the following hold:

- It contains only owned vendor primitives + their utilities (no business logic, no node-specific imports, no env reads).
- It is consumed via `transpilePackages` with **source exports** — no `dist/`, no tsup. (Same shape as `@cogni/node-app`.)
- Feature code never imports it directly. The consuming node's `components/kit/` and `components/index.ts` barrel are the only places that may import it. Feature code keeps importing from `@/components`, preserving `KIT_IS_ONLY_API` from `ui-implementation.md`.
- Forks are free to bypass the package and keep a local vendor copy. The package is a baseline, not a mandate.

## Core Invariants

1. **NO_SRC_IMPORTS**: Packages must never import `@/` (src aliases) or any `src/**` filesystem paths. Enforced by dependency-cruiser.

2. **NO_SERVICE_IMPORTS**: Packages must never import from `services/`. Dependency direction is `services → packages`, never reverse.

3. **WORKSPACE_IMPORTS_ONLY**: `src/` must never import `packages/**` filesystem paths — use `@cogni/<name>` workspace imports only.

4. **ESM_ONLY**: Packages are ESM-only, require Node >= 20 in dev/CI and any future services.

5. **COMPOSITE_BUILD**: All packages use TypeScript composite mode with `tsc -b` for incremental builds. Services do NOT get added to root `tsconfig.json` references.

6. **DIST_EXPORTS**: Package `exports` field points to `dist/` for runtime resolution. App resolves `@cogni/*` via `package.json` exports, not tsconfig path aliases.

7. **PURE_LIBRARY**: A package has no process lifecycle — no listening network ports, no worker loops, no Docker images, no env vars, no health checks. If it needs any of these, it's a service. (Note: port _interfaces_ like `OperatorWalletPort` belong in packages — this rule is about network ports.)

8. **PUBLICATION_IS_CURATED**: Packages are `private: true` unless a reviewed design names them as a cross-repository contract. A public package has explicit semver, license, repository, public-registry, and file-allowlist metadata.

9. **PUBLIC_ARTIFACT_IS_THE_CONTRACT**: CI verifies the packed tarball, not only workspace imports. Every exported production subpath and supported test-only subpath must resolve from a clean, unauthenticated tarball install.

10. **EXACT_CROSS_REPO_VERSIONS**: Sovereign repositories pin exact `@cogni/*` versions. Version advancement is an ordinary reviewed dependency PR; source-tree equality with `node-template` is not a health signal.

11. **OIDC_RELEASE_AUTHORITY**: Normal public releases come from a reviewed `main` commit on a GitHub-hosted runner using npm trusted publishing and provenance. No long-lived npm write token is part of the steady-state release lane. A package's first publication may use a one-time, narrowly scoped bootstrap credential because npm cannot attach a trusted publisher before the package exists; that credential is revoked after trust is established.

### Cross-Repository Distribution

Classify shared changes by delivery lane:

| Change                                                     | Delivery lane                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Pure runtime behavior or contract                          | Curated public `@cogni/*` package; exact dependency bump in each consumer          |
| CI implementation                                          | Pinned reusable workflow with a thin repository-owned caller                       |
| Physical tree migration                                    | Rare, reviewed codemod with exact paths and precondition hashes; divergence aborts |
| Routes, product features, branding, graphs, runtime wiring | Node-owned; never propagated from `node-template`                                  |

Automatic template-to-fork source writing is forbidden. Frequent codemods are evidence that the package boundary is incomplete, not a reason to recreate source sync. Compatibility is a declared platform cohort plus conformance behavior.

### Public Package Release Contract

A curated public package release must:

1. use an explicit semver committed in the package manifest;
2. pack only its declared runtime/type/license files;
3. install and exercise that exact tarball in a clean consumer before publication;
4. fail if the requested version differs from the manifest or already exists;
5. publish only from `main`, then anonymously install and exercise the registry version;
6. preserve provenance linking the public artifact to its workflow and source commit.

Test fixtures may ship through an explicit `/testing` subpath when they are pure, deterministic, and documented as test-only. Their presence does not expand the production root export.

## Design

### When to Create a Package

Create a package when code is:

1. **No runtime lifecycle** — No env loading, no process signals, no framework deps, no `src/` imports
2. **Shared across boundaries** — Used by both `src/` and potential future CLI/services
3. **Isolation-critical** — Must never depend on app internals (e.g., protocol encodings, domain constants)

**Do NOT create a package for:** feature UI (route components, layouts, wrappers), feature services, or anything importing from `src/`.

**Baseline UI primitive packages** (e.g. `@cogni/node-ui-kit`) are the one exception — see the carve-out under Non-Goals. They use the source-export + `transpilePackages` shape (mirroring `@cogni/node-app`), not the capability-package shape below.

### Capability Package Shape

For packages representing a business capability (wallet, ledger, payments), use one package per capability with internal subfolders:

```
packages/<capability>/
├── src/
│   ├── port/           # Port interface + domain error types
│   ├── domain/         # Pure types, validation, policy, math
│   ├── adapters/       # Domain-level adapter implementations (optional)
│   └── index.ts        # Public exports (barrel file)
├── tests/
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

**Domain adapters vs runtime wiring:** A package may contain adapters that implement the port using a specific technology (e.g., TigerBeetle adapter for ledger, Privy intent encoder for wallet). These are pure implementations that take dependencies as constructor args — no env loading, no process lifecycle. The app or service provides the client instance and config at startup.

Do NOT split into separate `*-adapters` packages — keep port + domain + adapters together until there's a concrete reason to split.

**Reference example:** `packages/scheduler-core/src/ports/schedule-control.port.ts` — defines `ScheduleControlPort` interface with custom error classes (`ScheduleControlConflictError`, `ScheduleControlNotFoundError`) and type guards. Adapters live in `packages/db-client/src/adapters/drizzle-schedule.adapter.ts` (split across packages because db-client serves multiple ports — for new capability packages, keep adapters co-located).

### Packages vs Services — Smell Test

Not a package if it:

- Listens on a port
- Runs a worker loop
- Has its own Docker image
- Owns environment variables or health checks

| Directory   | Contains                             | May Import From       |
| ----------- | ------------------------------------ | --------------------- |
| `packages/` | Pure libraries, no process lifecycle | Other packages        |
| `services/` | Entry points, env, signal handling   | `packages/`, own code |

**Dependency rule:** `services → packages` allowed; `packages → services` forbidden.

### Package Structure

```
packages/<name>/
├── src/
│   └── index.ts          # Public exports (barrel file)
├── tests/                 # Package-specific tests
├── package.json           # name: @cogni/<name>, exports to dist/
├── tsconfig.json          # rootDir: src, outDir: dist, target env
└── tsup.config.ts         # Build config (platform: browser|node|neutral)
```

### CI/CD Setup Checklist for New Packages

1. **pnpm-workspace.yaml** — Already includes `packages/*` (no change needed)

2. **Root package.json** — Add workspace dependency:

   ```json
   "dependencies": {
     "@cogni/<name>": "workspace:*"
   }
   ```

   Use `@cogni/<name>` consistently in all imports (app code and tests).

3. **Package tsconfig.json** — Enable TypeScript composite mode:

   ```json
   {
     "compilerOptions": {
       "composite": true,
       "declaration": true,
       "declarationMap": true,
       "outDir": "dist",
       "rootDir": "src"
     }
   }
   ```

4. **Root tsconfig.json references** — Add project reference:

   ```json
   "references": [
     { "path": "./packages/<name>" }
   ]
   ```

5. **Package exports** — Point to `dist/` for runtime:

   ```json
   "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
   ```

6. **Dependency-cruiser** — Add forbidden rules in `.dependency-cruiser.cjs` if the package must not import from `src/`.

7. **Biome config** — Add `packages/<name>/tsup.config.ts` to the `noDefaultExport` override in `biome/base.json`:

   ```json
   {
     "includes": [
       "packages/ai-core/tsup.config.ts",
       "packages/<name>/tsup.config.ts",
       ...
     ],
     "linter": { "rules": { "style": { "noDefaultExport": "off" } } }
   }
   ```

8. **Vitest config** — Add `packages/<name>/vitest.config.ts` for package-local tests:

   ```typescript
   import tsconfigPaths from "vite-tsconfig-paths";
   import { defineProject } from "vitest/config";

   export default defineProject({
     plugins: [
       tsconfigPaths({
         projects: ["../../tsconfig.json"], // Repo root for @cogni/* resolution
       }),
     ],
     test: {
       name: "<name>",
       globals: true,
       environment: "node",
       include: ["tests/**/*.{test,spec}.{ts,tsx}"],
     },
   });
   ```

   Also add the vitest config to `biome/base.json` noDefaultExport override.

   **Test location rules:**
   - Package-local tests (`packages/<name>/tests/**`) must only import that package — no `src/` imports (enforced by dependency-cruiser)
   - Cross-package integration tests live in `tests/packages/**` and may import multiple `@cogni/*` packages

### Canonical CI Flow

**TypeScript project references (`tsc -b`) is the default way packages are built and type-checked in CI.**

CI pipeline order:

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc -b` — Build package references in dependency order (incremental)
3. `pnpm typecheck` — App typecheck (resolves packages via `dist/`)
4. `pnpm test` — Unit/integration tests

TypeScript project references build packages incrementally using `.tsbuildinfo` cache files. The app resolves `@cogni/*` imports via `package.json` exports pointing to `dist/`, **not** via tsconfig path aliases.

**Escape hatch:** If a package is temporarily source-resolved for local dev (e.g., via tsconfig paths), it must still pass the canonical CI flow (`tsc -b`) without path hacks before merging.

**Future optimization:** When package/service count grows significantly, consider Turborepo for remote caching and task graph orchestration across multiple jobs. Not required for current scale.

### Import Boundaries

| From                        | Can Import Package?      | Can Import `src/`? | Notes                                       |
| --------------------------- | ------------------------ | ------------------ | ------------------------------------------- |
| `src/app/`, `src/features/` | Yes, via `@cogni/<name>` | Yes                | App code resolves packages via `dist/`      |
| `packages/<name>/src/`      | Yes, other packages      | **NO**             | Never import `@/` aliases or `src/**` paths |
| `packages/<other>/src/`     | Yes, via workspace       | **NO**             | Package-to-package via `@cogni/<other>`     |

### Where a new package belongs

Decision rule:

```
Is the package consumed by ≥2 nodes' app/graphs?
  yes → packages/<bare-name>/                 (cross-node; this spec)
  no  → nodes/<X>/packages/<bare-name>/       (node-owned; node-ci-cd-contract.md)
```

If a node-owned package later gains a cross-node consumer, carve it back to root in a single PR — don't symlink, don't dual-publish. The location is the source of truth for ownership.

Per-node `packages/` directories already work for every node — `pnpm-workspace.yaml` globs `nodes/*/packages/*` and `pnpm packages:build` builds them in dependency order. Today `nodes/poly/packages/` (7 packages) and `nodes/node-template/packages/knowledge/` exercise the pattern; `nodes/operator/packages/` and `nodes/resy/packages/` don't exist yet but inherit the same plumbing the moment they're created.

### Existing Packages

| Package                       | Target     | Purpose                                                                                     |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `@cogni/ai-core`              | isomorphic | AI event types, UsageFact, ExecutorType for billing                                         |
| `@cogni/ai-tools`             | isomorphic | Pure tool contracts and implementations (NO LangChain)                                      |
| `@cogni/aragon-osx`           | isomorphic | Aragon OSx encoding, addresses, receipt decoders                                            |
| `@cogni/cogni-contracts`      | isomorphic | Cogni-owned contract ABI and bytecode constants                                             |
| `@cogni/ids`                  | isomorphic | Branded ID types (UserId, ActorId) for RLS enforcement                                      |
| `@cogni/graph-execution-core` | neutral    | Shared graph execution contracts: executor, context, run stream                             |
| `@cogni/graph-execution-host` | neutral    | Graph execution decorators: billing, observability, preflight, routing                      |
| `@cogni/scheduler-core`       | node       | Scheduling types, port interfaces, payload schemas                                          |
| `@cogni/node-core`            | neutral    | Shared domain models, types, pure business logic for all nodes                              |
| `@cogni/node-contracts`       | neutral    | Shared Zod route contracts and HTTP router for all nodes                                    |
| `@cogni/node-shared`          | neutral    | Shared pure utilities, constants, observability, web3 constants                             |
| `@cogni/node-app`             | source     | Internal source package: platform providers + extension types (transpilePackages, no dist/) |
| `@cogni/db-schema`            | node       | Drizzle schema with subpath exports per domain slice                                        |
| `@cogni/db-client`            | node       | Drizzle client factory + scheduling adapters                                                |

### File Pointers

| File                        | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `packages/*/package.json`   | Workspace package declarations            |
| `packages/*/tsconfig.json`  | Composite TypeScript config per package   |
| `packages/*/tsup.config.ts` | Build config per package                  |
| `tsconfig.json` (root)      | Project references for all packages       |
| `.dependency-cruiser.cjs`   | Import boundary enforcement rules         |
| `biome/base.json`           | noDefaultExport overrides for tsup/vitest |

## Acceptance Checks

**Automated:**

- `pnpm check` — dependency-cruiser enforces import boundary rules; biome/tsc catch violations
- `pnpm exec tsc -b` — incremental package build succeeds

**Manual:**

1. Verify new packages have composite tsconfig, dist/ exports, and workspace dependency in root
2. Verify no `@/` or `src/**` imports in any `packages/` source

## Open Questions

_(none)_

## Related

- [Architecture](./architecture.md) — Hexagonal layers and boundaries
- [Node Formation Spec](node-formation.md) — Uses `@cogni/aragon-osx`
- [Services Architecture](./services-architecture.md) — Deployable service contracts
- [Node vs Operator Contract](./node-operator-contract.md) — Import boundary context
