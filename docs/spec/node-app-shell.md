---
id: spec.node-app-shell
type: spec
title: "Node App Shell: Shared Platform via Internal Source Package"
status: draft
spec_state: proposed
trust: draft
summary: "Defines two package categories (capability libraries and internal source packages) and how node apps consume a thin shared app shell without file duplication."
read_when: "Creating a new node, extracting shared code from nodes/operator/app, or deciding whether code belongs in a capability package vs the app shell."
implements: proj.operator-plane
owner: derekg1729
created: 2026-04-02
verified: 2026-04-02
tags: [architecture, nodes, packages, multi-node]
---

# Node App Shell: Shared Platform via Internal Source Package

> Nodes are thin app shells that overlay a shared platform. Capability libraries compile to `dist/`; the app shell exports source and is compiled by each consumer's bundler.

### Key References

|             |                                                                   |                                         |
| ----------- | ----------------------------------------------------------------- | --------------------------------------- |
| **Project** | [proj.operator-plane](../../work/projects/proj.operator-plane.md) | Multi-node architecture roadmap         |
| **Spec**    | [Packages Architecture](./packages-architecture.md)               | Capability package rules (PURE_LIBRARY) |
| **Spec**    | [Multi-Node Tenancy](./multi-node-tenancy.md)                     | DB_PER_NODE, auth isolation             |
| **Guide**   | [Multi-Node Dev](../guides/multi-node-dev.md)                     | Running nodes locally                   |

## Design

### Two package categories

```
packages/
  ┌──────────────────────────────────────────────────────┐
  │ CAPABILITY LIBRARIES (existing pattern)              │
  │ Compiled to dist/ via tsc-b + tsup                   │
  │ PURE_LIBRARY — no framework deps, no env, no process │
  │                                                      │
  │ ai-core, db-client, graph-execution-core,            │
  │ scheduler-core, ids, langgraph-graphs, ...           │
  │ + NEW: graph-execution-host, node-contracts,         │
  │        node-shared                                   │
  └──────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────┐
  │ INTERNAL SOURCE PACKAGE (new pattern)                │
  │ Exports TypeScript SOURCE, not dist/                 │
  │ Compiled by each consumer's Next.js bundler          │
  │ React, Next.js deps allowed (peer)                   │
  │                                                      │
  │ @cogni/node-app — THIN APP SHELL ONLY                │
  └──────────────────────────────────────────────────────┘
```

### Three-layer dedup strategy

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Capability libraries (PURE_LIBRARY, dist/)     │
│   Ports, core domain, contracts, pure shared utils,     │
│   adapters (constructor-injected, no framework deps)    │
│   Consumed by: apps, services, workers — ANY runtime    │
│                                                         │
│   @cogni/ai-core, @cogni/db-client, @cogni/ids,        │
│   @cogni/graph-execution-host, @cogni/node-contracts,   │
│   @cogni/node-shared, ...                               │
├─────────────────────────────────────────────────────────┤
│ Layer 2: App shell (@cogni/node-app, source exports)    │
│   Low-volatility app chrome — layout frame, providers,  │
│   auth/session, extension-point types, default scaffold │
│   Consumed by: Next.js node apps ONLY                   │
│                                                         │
│   NOT: feature UIs, product flows, route trees,         │
│        or library choices (assistant-ui, etc.)           │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Node app (per-node owned)                      │
│   Routes/pages, product features, node-specific         │
│   components, container overrides, theme, env, graphs   │
│   Owned by: each node independently                     │
└─────────────────────────────────────────────────────────┘
```

### What goes where

| Code                                                                        | Location                                                                                                 | Rationale                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Port interfaces (32 files)                                                  | Capability packages (`@cogni/ai-core`, `@cogni/graph-execution-core`, new `@cogni/node-ports` if needed) | Pure types, runtime-agnostic — consumed by services too       |
| Domain models, types (31 files)                                             | Capability packages                                                                                      | Pure domain, no framework deps                                |
| Zod route contracts (55 files)                                              | `@cogni/node-contracts` (new capability package)                                                         | Pure Zod, no framework deps                                   |
| Pure shared utils — observability, crypto, config (81 files)                | `@cogni/node-shared` (new capability package)                                                            | Pure functions, used by services too                          |
| Adapters — AI execution subset (~20 files)                                  | `@cogni/graph-execution-host`                                                                            | Consumed by scheduler-worker                                  |
| Adapters — DB, payments, temporal, etc. (~139 files)                        | Existing capability packages (`@cogni/db-client`, etc.) or stay in app pending further extraction        | Pure but need per-capability home                             |
| **App chrome** — layout frame, sidebar/header/topbar structure with slots   | `@cogni/node-app`                                                                                        | Low-volatility shell, identical across nodes                  |
| **Common providers** — auth session, theme, query client wrappers           | `@cogni/node-app`                                                                                        | App-runtime-specific, identical across nodes                  |
| **Extension-point types** — slot interfaces, factory types, registry shapes | `@cogni/node-app`                                                                                        | Define the node customization surface                         |
| **Default scaffolding** — starter layout, default nav items                 | `@cogni/node-app`                                                                                        | Gives new nodes a working starting point                      |
| Routes/pages                                                                | Node `apps/web/src/app/`                                                                                 | **Node-owned** — product UX decisions                         |
| Product features (chat UI, billing dashboard, etc.)                         | Node `apps/web/src/features/`                                                                            | **Node-owned** — may diverge, use libraries like assistant-ui |
| Product components                                                          | Node `apps/web/src/components/`                                                                          | **Node-owned** — poly Hero, resy booking, etc.                |
| Container overrides / tool bindings                                         | Node `apps/web/src/bootstrap/`                                                                           | **Node-owned** — per-node capability wiring                   |
| Graphs                                                                      | Node `packages/graphs/`                                                                                  | **Node-owned** — AI graph definitions                         |
| Theme / CSS                                                                 | Node `apps/web/src/styles/`                                                                              | **Node-owned** — per-node color tokens                        |
| Server env config                                                           | Node `apps/web/src/shared/env/`                                                                          | **Node-owned** — per-node env vars (DB_PER_NODE)              |

### What `@cogni/node-app` is and is NOT

**IS (thin shell):**

- Layout frame with named slots (header slot, sidebar slot, content area)
- Auth/session provider wiring (NextAuth config shape, session context)
- Theme provider (CSS variable injection, dark mode toggle)
- Common middleware patterns (auth guard, rate limit, CORS)
- Extension-point type definitions (what a node CAN override)
- Default implementations that nodes can replace via container/config

**IS NOT (stays node-owned or in capability packages):**

- Route trees or page components (node-owned)
- Feature UIs — chat, billing dashboard, account management (node-owned)
- Library integrations — assistant-ui, wagmi, etc. (node-owned)
- Ports, domain types, contracts (capability packages — runtime-agnostic)
- Adapters (capability packages or app-local)
- Environment variables or `serverEnv()` (hard rule: shell never reads env)
- Product flows or business logic

### Internal source package shape

```json
// packages/node-app/package.json
{
  "name": "@cogni/node-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "sideEffects": false,
  "exports": {
    "./providers": "./src/providers/index.ts",
    "./extensions": "./src/extensions/index.ts"
  },
  "peerDependencies": {
    "react": ">=19",
    "next-auth": ">=4",
    "next-themes": ">=0.4",
    "@tanstack/react-query": ">=5",
    "@rainbow-me/rainbowkit": ">=2",
    "@rainbow-me/rainbowkit-siwe-next-auth": ">=0.5",
    "wagmi": ">=2"
  }
}
```

**Curated subpath exports** — not wildcard `"./*": "./src/*"`. Each export is an intentional public API surface. Internal files are NOT importable — prevents the shell from becoming a gravity well.

Consumer next.config.ts:

```ts
// nodes/poly/apps/web/next.config.ts
const nextConfig: NextConfig = {
  transpilePackages: ["@cogni/node-app"],
  // ... existing config
};
```

### Override mechanism: explicit extension points, not file shadowing

Nodes customize the shell via **injected configuration**, not path-based shadowing:

```ts
// @cogni/node-app/src/extensions/types.ts
export interface NodeAppConfig {
  /** Replaces default header — slot-based, not path-based */
  headerComponent?: React.ComponentType<HeaderSlotProps>;
  /** Navigation items for sidebar */
  navItems: NavItem[];
  /** Tool capability bindings for this node */
  capabilityBindings: CapabilityBinding[];
  /** Theme CSS variables */
  theme: ThemeConfig;
}
```

```ts
// nodes/poly/apps/web/src/node-config.ts
import { PolyHeader } from "./components/Header";
import { polyNavItems } from "./nav";
import { polyBindings } from "./bootstrap/bindings";
import { polyTheme } from "./styles/theme";

export const nodeConfig: NodeAppConfig = {
  headerComponent: PolyHeader,
  navItems: polyNavItems,
  capabilityBindings: polyBindings,
  theme: polyTheme,
};
```

### Node workspace structure

```
nodes/
  node-template/              # Golden path — scaffold new nodes from here
    .cogni/                   # repo-spec, node identity
    apps/
      web/                    # The Next.js app
        src/
          app/                # Routes (default dashboard, chat, settings)
          features/           # Node-owned features
          components/         # Node-owned components
          bootstrap/          # DI container + tool bindings
          shared/env/         # Server env config
          styles/             # Theme CSS
          node-config.ts      # NodeAppConfig — customization entry point
        next.config.ts        # transpilePackages: ["@cogni/node-app"]
        package.json          # @cogni/node-app + capability packages
    packages/
      graphs/                 # Node-specific graph definitions

  poly/
    .cogni/
    apps/
      web/
        src/
          app/                # Poly routes (homepage, prediction pages)
          components/         # Poly-specific: Hero, BrainFeed, MarketCards
          bootstrap/          # Poly container overrides
          shared/env/         # Poly server env
          styles/             # Poly theme (teal tokens)
          node-config.ts      # Poly's NodeAppConfig
    packages/
      graphs/                 # poly-brain graph
```

## Goal

Enable nodes as thin app shells that compose a shared layout/provider framework with node-specific features and overrides. In the monorepo, packages resolve through `workspace:*`; sovereign repositories consume curated capability packages at exact public versions. Feature UIs remain node-owned to support independent product evolution.

## Non-Goals

- Runtime plugin system (nodes are still separate Next.js apps, not dynamically loaded)
- Centralizing feature UIs, route trees, or product flows in the shared shell
- Replacing capability libraries — `@cogni/ai-core`, `@cogni/db-client`, etc. keep PURE_LIBRARY pattern
- Operator aggregation plane (separate concern per multi-node-tenancy spec)
- Publishing the source-export `@cogni/node-app` shell or treating every workspace package as public. Only reviewed PURE_LIBRARY capability packages may use the public release contract in `packages-architecture.md`.

## Invariants

| Rule                        | Constraint                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TWO_PACKAGE_CATEGORIES      | Capability libraries export `dist/` (PURE_LIBRARY). `@cogni/node-app` exports `src/` (internal source package). No mixing.                                                                      |
| SOURCE_EXPORTS_FOR_SHELL    | `@cogni/node-app` exports TypeScript source via curated subpath exports, never compiled `dist/`. Consumers compile it via `transpilePackages`.                                                  |
| CAPABILITY_STAYS_PURE       | Code consumed by scheduler-worker or services MUST live in a capability library, not in `@cogni/node-app`.                                                                                      |
| SHELL_IS_CHROME_ONLY        | `@cogni/node-app` contains only low-volatility app chrome: layout frame, providers, auth framing, extension-point types, default scaffolding. No feature UIs, no product flows, no route trees. |
| SHELL_NEVER_READS_ENV       | `@cogni/node-app` must never call `process.env`, `serverEnv()`, or read environment variables directly. All config injected via `NodeAppConfig`.                                                |
| NODE_OWNS_PRODUCT           | Each node owns its routes, features, components, library choices, and product UX. The shell provides slots; the node fills them.                                                                |
| CURATED_EXPORTS             | `@cogni/node-app` uses curated subpath exports (`"./providers"`, `"./extensions"`), never wildcard exports. Internal files are not importable.                                                  |
| OVERRIDE_VIA_CONFIG         | Node customization via explicit `NodeAppConfig` injection (slots, factories, registries), never via file-path shadowing.                                                                        |
| NO_CROSS_NODE_IMPORTS       | `nodes/poly/**` must never import from `nodes/resy/**` or vice versa. Enforced by dependency-cruiser.                                                                                           |
| GOLDEN_PATH_IS_TEMPLATE     | `node-template` is the reference node. New nodes scaffold from it.                                                                                                                              |
| TRANSPILE_PACKAGES_REQUIRED | Every Next.js app consuming `@cogni/node-app` must include it in `transpilePackages` in `next.config.ts`.                                                                                       |

### File Pointers

| File                                                | Purpose                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/node-app/package.json`                    | Internal source package declaration with curated subpath exports      |
| `packages/node-app/src/extensions/types.ts`         | `NodeAppConfig` — the node customization surface                      |
| `packages/node-app/src/providers/app-providers.tsx` | `AppProviders` — platform provider composition (accepts wagmiConfig)  |
| `nodes/node-template/app/src/node-config.ts`        | Reference `NodeAppConfig` implementation                              |
| `nodes/node-template/app/next.config.ts`            | Reference `transpilePackages` config                                  |
| `pnpm-workspace.yaml`                               | Workspace globs: `packages/*`, `nodes/*/apps/*`, `nodes/*/packages/*` |
| `.dependency-cruiser.cjs`                           | Cross-node import enforcement                                         |
| `docs/spec/packages-architecture.md`                | Capability library rules (companion spec)                             |

## Spike Results (2026-04-02)

Validated with Next.js 16.1.7 + Turbopack. 7-file `@cogni/node-app` package with `AppShell`, `NodeAppProvider`, `NodeAppConfig`, `DefaultHeader`, `DefaultSidebar`.

| Question                        | Result                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Turbopack + `transpilePackages` | **Works.** Source exports (`./src/*`) compile correctly. 5.3s first compile for spike page. No crashes.                                   |
| Curated subpath exports         | **Works.** `"./layout"`, `"./providers"`, `"./extensions"` all resolve. No wildcards needed.                                              |
| `NodeAppConfig` slot injection  | **Works.** `headerComponent: PolyHeader` renders custom component, replacing `DefaultHeader`.                                             |
| Memory regression               | **No regression detected.** 47 MB after 2 pages compiled. Fair comparison requires full-app test during implementation.                   |
| Worktree compatibility          | **Broken.** Turbopack rejects symlinked `node_modules` pointing outside filesystem root. Spike must run from real repo, not git worktree. |

## Open Questions

- [ ] For the ~139 non-AI adapters: which existing capability packages should absorb them vs which stay app-local pending further extraction? Needs per-adapter audit.

## Related

- [Packages Architecture](./packages-architecture.md) — Capability library rules (PURE_LIBRARY pattern)
- [Multi-Node Tenancy](./multi-node-tenancy.md) — DB_PER_NODE, auth isolation
- [Node Operator Contract](./node-operator-contract.md) — NO_CROSS_IMPORTS, DATA_SOVEREIGNTY
- [task.0248](../../work/items/task.0248.node-platform-package-extraction.md) — Implementation task
- [task.0250](../../work/items/task.0250.extract-graph-execution-host-package.md) — graph-execution-host capability extraction
