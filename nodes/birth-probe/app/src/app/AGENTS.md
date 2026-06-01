# app · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-04-27
- **Status:** draft

## Purpose

Next.js App Router delivery layer. UI pages and API routes that expose features to external clients.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)
- [Feature Development Guide](../../../../docs/guides/feature-development.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": [
    "app",
    "features",
    "ports",
    "shared",
    "contracts",
    "types",
    "components",
    "styles"
  ],
  "must_not_import": ["adapters/server", "adapters/worker", "core"]
}
```

## Public Surface

- **Exports:** none
- **Route Groups:**
  - `(public)`: Unauthenticated pages (landing, marketing, docs)
  - `(app)`: Protected pages requiring authentication (chat, billing, etc.)
  - `(admin)`: DAO-admin pages gated by `activity_ledger.approvers` (server-side wallet check)
  - `(infra)`: Infrastructure endpoints (health, meta, openapi)
  - `api`: Versioned JSON APIs (v1, v2, etc.)
- **Routes (if any):**
  - Public pages: `/` (homepage via `(public)/page.tsx`)
  - Protected pages: `/chat` (via `(app)/chat/page.tsx`)
  - Infra: `/health`, `/openapi.json`, `/meta/route-manifest` (via `(infra)/*`)
  - API: `/api/auth/*`, `/api/v1/chat/completions`
  - Internal ops: `/api/internal/ops/governance/schedules/sync` [POST] (deploy-only trigger)
  - Agent discovery: `/.well-known/agent.json` [GET] — public discovery document for machine clients
- **Files considered API:** layout.tsx, page.tsx, loading.tsx, error.tsx, api/\*\*/route.ts, (infra)/\*\*/route.ts, .well-known/\*\*/route.ts
- **Suspense / error boundaries:** each route group exposes a
  `loading.tsx` + `error.tsx`. `(app)/loading.tsx` renders a generic
  fallback inside the sidebar shell; high-traffic routes
  (`/dashboard`, `/chat`, `/work`, `/credits`, `/activity`, `/gov/*`)
  override with a per-route `loading.tsx` that mirrors the page's
  macro layout. `(public)/loading.tsx` renders the marketing-shaped
  skeleton (Hero + cards + feed) used by `/`; `propose/merge`
  overrides with a form skeleton. Reusable primitives
  (`PageHeaderSkeleton`, `TableSkeleton`, `CardGridSkeleton`) live
  under `kit/layout/`. **Forks inheriting this template inherit the
  skeleton pattern.**

## Responsibilities

- This directory **does**: expose UI pages and HTTP endpoints; validate requests with contracts
- This directory **does not**: contain business logic, port implementations, or direct database access

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- API routes must validate input/output with contracts
- UI pages use features and components only
- No business logic in routes or pages

## Route Group Conventions

- **`(public)/*`**: Unauthenticated UI pages. No auth guard. Landing page, marketing, docs.
- **`(app)/*`**: Protected UI pages. Auth enforced by `(app)/layout.tsx` using client-side `useSession()` redirect. All pages under `(app)` automatically require authentication. Do NOT add per-page auth checks.
- **`(admin)/*`**: DAO-admin pages. Login gate via `proxy.ts` matcher; role gate via server-side `(admin)/layout.tsx` checking the SIWE wallet against `getLedgerApprovers()` (repo-spec `activity_ledger.approvers`). Non-approvers redirect to `/dashboard`. See `(admin)/AGENTS.md`.
- **`(infra)/*`**: Infrastructure endpoints. Explicitly unauthenticated. Health checks, meta, OpenAPI specs.
- **`api/*`**: JSON APIs. Keep under `api/v1/**` for versioned endpoints. Auth enforced per-route using `auth()` calls in route handlers (not via layout).

When adding new protected pages (e.g., `/billing`, `/api-keys`), place them under `(app)/*` and rely on the layout's auth guard. When adding new APIs, keep them under `api/v1/**` and add explicit `auth()` checks in route handlers.

## Dependencies

- **Internal:** features, contracts, shared, components
- **External:** next, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date
- Ensure contract validation passes

## Notes

- Uses Next.js App Router patterns
- API routes are thin adapters that delegate to features
