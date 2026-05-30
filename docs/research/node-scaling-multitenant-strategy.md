---
id: node-scaling-multitenant-strategy
type: research
title: Node scaling capacity + multi-tenant white-label strategy
status: draft
trust: draft
summary: "Current 6GB Cherry VM holds ~5–13 more Tier 0 node-template clones per env before memory pressure; deploy-pipeline matrix is a softer ceiling first. GoHighLevel-style white-label resellers should NOT spawn new node apps — they should land on a future shared-shell node (Dolt-only pattern = tenant row + per-tenant Dolt schema + per-tenant agents via proj.agent-registry + branding overlay) with subdomain middleware + RLS. Within each node-class: one Next.js + four route groups (public/app/admin/infra), not three separate apps."
read_when: Deciding whether to fork a new node app vs share an existing one, sizing the VM, planning white-label / reseller productisation, debating per-tenant isolation vs single-codebase efficiency.
owner: derekg1729
created: 2026-05-29
tags: [infra, multi-tenant, capacity, white-label]
links:
  - docs/research/nextjs-node-memory-sizing.md
  - docs/spec/architecture.md
  - docs/spec/database-rls.md
  - work/projects/proj.agent-registry.md
  - infra/catalog/
  - infra/k8s/argocd/
---

# Research: Node scaling capacity + multi-tenant white-label strategy

> spike: TBD (file as `spike.node-scaling-multitenant`) | date: 2026-05-29

## Question

Two questions, one root cause:

1. **Capacity.** Given the current Cherry VM + k3s + Argo + per-node-per-env deploy model, how many _additional_ nodes can we host before things tip over (memory, CPU, deploy-pipeline blast radius)?
2. **Efficiency.** What is the most efficient setup for spawning new node apps following Next.js best practices? How does a service like GoHighLevel (GHL) host thousands of white-label resellers without spawning a Next.js app per reseller? Where, if anywhere, should we adopt that pattern?

Both questions converge on: _when is "another node" the right unit of deploy, and when is it a config row?_

## Context

### What exists today (factual map)

**Nodes** (sourced from `infra/catalog/*.yaml` — single source of truth):

| Node               | Kind    | Image suffix        | Per-env branches                |
| ------------------ | ------- | ------------------- | ------------------------------- |
| `operator`         | Node    | _(unsuffixed)_      | `deploy/{env}-operator`         |
| `resy`             | Node    | `-resy`             | `deploy/{env}-resy`             |
| `node-template`    | Node    | `-node-template`    | `deploy/{env}-node-template`    |
| `scheduler-worker` | Service | `-scheduler-worker` | `deploy/{env}-scheduler-worker` |

Each node is a **fully separate Next.js app** under `nodes/<node>/app/` with its own Dockerfile. There is **no `middleware.ts` doing tenant routing** in any node. Routes are not namespaced by tenant. The "template" is a scaffold copied per-fork, not a runtime-shared app. Shared `@cogni/*` packages give library-level reuse, but every node ships the full Next.js stack independently.

**Per-node k8s footprint** (`infra/k8s/base/node-app/deployment.yaml`, Tier 0 from `docs/research/nextjs-node-memory-sizing.md`):

| Container       | Req mem | Lim mem | Req CPU | Lim CPU | Notes                                     |
| --------------- | ------: | ------: | ------: | ------: | ----------------------------------------- |
| App (Next.js)   |   256Mi |   512Mi |    100m |   1000m | `--max-old-space-size=384`; `replicas: 1` |
| Migrator (init) |   384Mi |     1Gi |    200m |   1000m | Postgres; runs at deploy then exits       |
| Doltgres mig.   |   384Mi |     1Gi |    200m |   1000m | Operator only; runs at deploy then exits  |

External services (Postgres, Temporal, LiteLLM, Redis) live OFF the VM via `ExternalName` Services — they do not consume VM resources.

**Cherry VM** (`infra/provision/cherry/base/terraform.tfvars.example`):

- Plan: **`B1-6-6gb-100s-shared`** — 6 vCore, 6 GB RAM, 100 GB SSD (Cherry VPS max)
- k3s with traefik + servicelb disabled, 2GB swap

**Argo CD setup** (`infra/k8s/argocd/`):

- One `ApplicationSet` per env (`candidate-a`, `preview`, `production`) — `canary` overlay exists too
- Each ApplicationSet has **one git generator per node**, watching `deploy/{env}-{node}` branch + reading `infra/catalog/{node}.yaml`
- Adding a node = adding a generator block to every ApplicationSet + a deploy branch per env + an overlay dir

**Promote pipeline** (`.github/workflows/promote-and-deploy.yml`):

- Decide → Reconcile ApplicationSet → Promote (per-node matrix) → Verify (per-node matrix) → Aggregate
- Node list resolved from `infra/catalog/` via `scripts/ci/lib/image-tags.sh` (the dedup landed in 6a6ebb757)

**DNS** (`scripts/ci/lib/image-tags.sh:host_for_node()`): operator on bare domain; others on `{node}-{env}.cognidao.org`. Wildcard cert assumed; Cloudflare records per node.

### What prompted this

Headline question is "can I just keep cloning node-template forever?" The honest answer needs to separate three ceilings — RAM, deploy-matrix cost, and per-node ops burden — and check whether the GHL/Vercel-Platforms playbook even applies to our nodes, given each node has _different domain code_ (poly trading vs resy reservations vs operator control plane), not just different branding.

## Findings

### F1: Memory is the binding VM ceiling; CPU and disk are slack

Per-env, on one 6 GB / 6 vCore VM:

```
VM budget                 6144 MB   6000m CPU
k3s + kube-system          ~400 MB   ~250m
Argo CD + image-updater    ~500 MB   ~250m
Headroom (buffers, OS)     ~400 MB   ~200m
──────────────────────────────────────────────
Available for workloads   ~4844 MB  ~5300m

Per node (steady state, Tier 0):
  k8s request               256 MB    100m
  Realistic Next.js RSS    ~280 MB   bursty
```

Using **realistic RSS** as the planning number (k8s requests at 256Mi are optimistic for a real Next.js app — see `nextjs-node-memory-sizing.md` F2):

- **Steady-state ceiling per env: ~17 node pods.** At Tier 0 limits (512Mi each), the hard ceiling drops to **~9 pods** before nodes risk eviction under bursty load.
- **Current load: 4 pods per env** (operator + resy + node-template + scheduler-worker).
- **Honest headroom: ~5–13 more node-template clones per env**, before memory pressure starts evicting.

CPU is far less constrained: 5300m available, 100m requested per node → 50+ pods possible at request, 5 pods at sustained limit. The 100m request is generous and could be tightened if memory became the only argument.

Disk (100 GB) is plenty for app images; per-node image is ~300 MB, so 50+ node images fit before image-GC matters.

**Caveat: env layering.** Today's design assumes one VM **per env** (candidate-a VM, preview VM, prod VM, canary VM). The "shadow-pods" bug (`project_candidate_a_shadow_pods`) tells us candidate-a's k3s currently shadow-runs the preview + production namespaces too — that's `bug.5009`, not the design. Per-env capacity is the right unit; multiply by env count for fleet planning.

### F2: Deploy matrix is the softer, sooner ceiling

The promote-and-deploy workflow runs a **per-node matrix lane** in two stages (promote, verify). Each lane:

- Bootstraps a deploy branch if missing
- Syncs base + overlay + catalog from app-src
- Promotes the digest, commits to `deploy/{env}-{node}`
- Waits for Argo sync
- Waits for in-cluster readiness
- Verifies buildSha in container

GitHub Actions default matrix concurrency = 256, but real bottleneck is **per-job minutes + per-PR wall-clock + Argo reconcile contention**. With N nodes the verify-stage wall-clock grows ~linearly until matrix parallelism saturates. Empirically (recent commits `db1f0df7c`, `6a6ebb757`, `bebeccef5`): every new node has exposed a "hardcoded list" bug. The catalog-driven dedup helps, but each new node still:

- Adds 1 ApplicationSet generator block × 4 envs = 4 YAML edits
- Adds 1 overlay dir × 4 envs = 4 kustomization.yaml files
- Adds 1 deploy branch × 4 envs = 4 git branches to bootstrap
- Adds 1 DNS record + Cloudflare cert SAN
- Adds 1 Postgres DB + secret + DATABASE*URL*<NODE> env var

**At ~10 nodes** the catalog stays sane, the matrix stays under the memory ceiling, and the per-node ops burden is tolerable.
**At ~30 nodes** the per-env deploy-branch graph becomes a real liability: every promotion races 30 lanes, every Argo reconcile loops over 30 generators, every catalog edit is a 30-row review.
**At ~100 nodes** the per-node-app model is broken — Argo ApplicationSet rendering + the per-branch sync pattern is not built for this fan-out.

### F3: Postgres + Doltgres per-node is the OTHER scaling tax

Each node has its own external Postgres DB. The operator additionally has Doltgres. Adding a node = provisioning a DB + secrets + drizzle config + migrations dir + kustomize patches for the DATABASE*URL*<NODE> secret key.

This is a real cost at ~10+ nodes:

- Each Postgres is its own connection pool budget
- Each schema migration is its own CI step
- Cross-node analytics requires federated query OR an export-to-warehouse pipeline (currently neither exists)

**Per-tenant data isolation is a real architectural property worth paying for** when nodes have _different domain code_. But for nodes that are _just branding + config_ around the same domain code, paying for per-DB Postgres is overkill.

### F4: GoHighLevel pattern is shared codebase + sub-account + branding overlay, not per-app spawn

From web research ([GHL white-label guides 2026](https://nebtrix.io/blog/gohighlevel-white-label-agency-guide-2026), [Ideas: Whitelabel Sub-Accounts](https://ideas.gohighlevel.com/saas/p/whitelabel-sub-accounts)):

- **Hierarchical multi-tenancy**: ONE GHL codebase. Agencies create "sub-accounts" (workspaces) under their agency account. Sub-accounts get scoped data but share the platform.
- **White-label = branding/domain mapping layer**, not code separation: custom domain → tenant resolution → theme/logo/copy injection → same backend.
- **Provisioning**: client signs up + Stripe pays → sub-account created automatically (row in tenants table, not an infra spawn).
- **Resource model**: agencies report 200+ clients on a team of 3. That arithmetic only works because each sub-account is a row, not a deploy.

The [Vercel Platforms / Multi-tenant template](https://vercel.com/platforms/docs/examples/multi-tenant-template) is the canonical Next.js implementation:

- Single Next.js deployment
- Wildcard domain (`*.example.com`) + custom domains via Vercel API
- `middleware.ts` extracts subdomain, rewrites to `/[tenant]/...` route group
- Tenant row in DB; shared schema with `tenant_id` column on every table; **Row-Level Security** in Postgres scopes queries to the current tenant

This is the well-trodden pattern. We have zero of it today.

### F5: But our nodes are not (yet) GHL-style. They have different domain code.

The strict GHL pattern assumes all tenants run the same logic. Cogni's existing nodes do NOT:

- `poly` = Polymarket copy-trading engine (CTF, fills ledger, coordinator loop, Phase 4 streaming…)
- `resy` = reservation-related (different domain)
- `operator` = control plane (PR coordination, work-item API, knowledge plane, DAO governance)

These cannot collapse into one Next.js app via subdomain routing — they have genuinely different ports, adapters, and core domain models. Per-node code separation is correct here.

The **white-label question** only applies to a _new_ class: nodes that would be _branded clones of the same underlying domain code_ (e.g. "reseller deploys their own Cogni instance pointed at their own DAO wallet + branding, but using the same operator/AI/billing stack"). For that class, GHL's pattern is the right one and per-node deploy is waste.

## Recommendation

**Stratify nodes into two classes; keep the current per-node deploy for the first class and introduce a "shared-shell node" for the second.**

### Class A — Code-distinct nodes (status quo)

`operator`, `resy`, `poly`, future nodes with materially different domain code.

- Keep per-node Next.js app + per-env deploy branch + dedicated Postgres.
- **Cap at ~10 nodes per VM** (memory) **and ~15 nodes per env globally** (deploy-matrix sanity). Above that, scale the VM (Cherry max is 6GB — would need to move to a non-Cherry provider) or split per-env across multiple VMs.
- Resy-style is the natural ceiling: every "real new product" justifies a node. Every "another instance of the same product" does not.

### Class B — Tenant-distinct nodes (new pattern, "shared-shell" = Dolt-only nodes)

**Sharper definition (per Derek follow-up): a Class B node has _no custom app code at all_.** It is fully composed from:

- A **tenant row** (branding, wallet addresses, feature flags, contact info, custom domain)
- A **per-tenant Dolt schema** (the node's knowledge plane — the actual product value)
- A **per-tenant agent set** registered via the existing [`proj.agent-registry`](../../work/projects/proj.agent-registry.md) (`AgentRegistrationDocument` + `AgentIdentityPort`, P0 of the Identity & Registration track)
- The shared Next.js shell + the shared `@cogni/*` packages everyone already imports

This is the clean composition: **branding + Dolt + agents.** Nothing else.

The fit with `proj.agent-registry` is exact: that project is already building `AgentRegistrationDocument`, content-hashed registration, `OffchainAgentRegistryAdapter`, and (P1) ERC-8004 on-chain publication. A Class B tenant becomes "an entry in the offchain registry whose agents are scoped to its Dolt schema." When ERC-8004 lands, each tenant's agent identity is on-chain too — and the tenant itself is a DAO-governed node without ever having to fork the codebase. This is the operator-plane's natural endgame.

Build **one** Next.js app — `shared-shell` (working name) — that:

1. **Subdomain middleware**: `middleware.ts` reads `host` header, looks up `tenant_id` in a tenants table (cached in KV/Redis), sets a `x-tenant-id` request header, rewrites to internal route. Wildcard cert + Cloudflare for SAN.
2. **Per-tenant config row**: branding, wallet addresses, feature flags. One row per tenant.
3. **Shared business schema with `tenant_id` column** + Postgres **RLS** enforcing `tenant_id = current_setting('app.tenant_id')` (extends `docs/spec/database-rls.md` from user-level to tenant-level).
4. **Per-tenant Dolt schema** for the knowledge plane (or shared Dolt with RLS-scoped rows — design choice, both viable).
5. **Per-tenant agents** = rows in `agent_registrations` filtered by `tenant_id` (the existing P0 schema in `proj.agent-registry` already has the right shape; add the tenant column).
6. **Provisioning = SQL insert + Cloudflare DNS API call.** Zero new k8s objects, zero deploy branches, zero CI lanes per tenant.

This collapses Class B ops cost to O(1) regardless of tenant count: the same single Next.js pod serves 1 or 1000 tenants, with HPA scaling on real load (not per-tenant).

### Within-node structure: 3 route groups, NOT 3 apps

Derek asked: should "nodes" split into 3 apps — public website, signed-in app, admin dashboard?

**No — split into 3 _route groups_ inside ONE Next.js per node.** Three separate apps is a top-1% pattern (Stripe, historically), not top-0.1%. The top-0.1% modern Next.js practice is route-group-segregated within a single deployment, which is what Vercel, Linear's app shell, Cal.com, and the Vercel Platforms Starter Kit all do today.

Current state — already partially correct: every node app (`nodes/{operator,resy,node-template}/app/src/app/`) already has `(public)/`, `(app)/`, and `(infra)/`. **Gap: no `(admin)/` route group exists.** DAO ownership views, DAO setup, future admin-only surfaces have nowhere canonical to land.

Recommended canonical shape for every node (Class A and Class B alike):

| Route group | Auth                        | Rendering                   | Purpose                                               |
| ----------- | --------------------------- | --------------------------- | ----------------------------------------------------- |
| `(public)/` | None                        | `force-static` or ISR       | Marketing, landing, docs, public knowledge views      |
| `(app)/`    | Authed user                 | Dynamic, server components  | Signed-in product surface                             |
| `(admin)/`  | DAO owner / admin role      | Dynamic, server components  | DAO ownership, DAO setup, billing admin, tenant admin |
| `(infra)/`  | Internal / health           | Edge-runtime where possible | `/healthz`, `/version`, ops endpoints                 |
| `api/`      | `proxy.ts` enforces session | Node.js runtime by default  | API v1 routes                                         |

Why route groups, not separate apps:

- ONE auth pipeline (`proxy.ts`), ONE design system (`@cogni/node-ui-kit`), ONE type graph end-to-end → admin tools always agree with app tools.
- Code-level boundaries are still real: `(admin)` features can be locked down by ESLint / dependency-cruiser rules (no `(app)` → `(admin)` imports, etc.) without paying the cost of two deploys.
- Static-rendering `(public)` is one-line-per-page (`export const dynamic = 'force-static'`); pays edge-cache wins without a separate marketing site.
- Lockable per group: `proxy.ts` (or the middleware below it) can gate `(admin)/*` on DAO-owner role with one rule.

When to actually split into a second deployment: only if marketing is owned by a non-engineering team with its own CMS/release cycle (Storybook/Sanity-style stack). Cogni does not have that org shape; do not pre-split.

### Critical evaluation: current setup vs top 0.1% Next.js multi-tenant SaaS

| Dimension                   | Today                               | Top 0.1% target                                        | Gap                                          |
| --------------------------- | ----------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Per-tenant unit             | Whole Next.js + Postgres + k8s lane | Tenant row + RLS + middleware rewrite                  | 🔴 missing for Class B                       |
| Subdomain → tenant routing  | None                                | `middleware.ts` host → tenant_id rewrite               | 🔴 missing                                   |
| Postgres RLS                | Specced, not implemented            | RLS on tenant_id + user_id, contract-tested            | 🔴 spec only                                 |
| Route group structure       | `(public)`, `(app)`, `(infra)`      | `(public)`, `(app)`, `(admin)`, `(infra)`              | 🟡 missing `(admin)`                         |
| Marketing page rendering    | Implicit SSR                        | `force-static` or ISR on `(public)/*`                  | 🟡 unverified per-page                       |
| `(public)` runtime          | Node.js default                     | Edge runtime where viable                              | 🟡 unverified                                |
| Admin role / DAO-owner gate | Ad hoc                              | Single middleware/proxy rule on `(admin)/*`            | 🔴 no group, no rule                         |
| Branding overlay            | Per-fork code edits                 | Per-tenant config row → CSS variables + copy keys      | 🔴 missing                                   |
| Tenant provisioning UX      | Manual node fork + infra wire-up    | Sign-up form → SQL insert + DNS API call               | 🔴 missing                                   |
| Replica count               | 1 per node per env                  | HPA from low floor, scale on real RPS                  | 🟡 MVP-justified today                       |
| Per-env propagation         | 4 deploy branches per node          | One deploy, env via env vars + image tag               | 🟡 deliberate trade-off for promotion safety |
| Agent identity / registry   | In-flight (`proj.agent-registry`)   | On-chain (ERC-8004) + offchain hash + per-tenant scope | 🟢 already in design                         |
| Shared design system        | `@cogni/node-ui-kit`                | One kit, theme-tokened, per-tenant override            | 🟡 missing tenant overlay                    |

Reds and yellows are not all "fix now." The honest priority order:

1. **🔴 Add `(admin)/` route group + DAO-owner gate** — small, unblocks DAO governance UI without architectural debate. Land on `node-template` so every fork inherits it.
2. **🔴 Implement RLS at user-level first** (already specced) — Class A wins immediately; Class B has the foundation it needs the day demand shows up.
3. **🔴 Tenant row + middleware rewrite + branding overlay** — only when Class B demand is real. Building it pre-demand is itself the MVP anti-pattern.
4. **🟡 `force-static` + edge runtime on `(public)/*`** — measurable perf win, ~1-day audit pass across nodes.
5. **🟡 HPA + per-env single-deploy** — deferred until traffic justifies. The current deploy-branches model is non-standard but bought us promotion safety; revisit after `proj.deploy-branch-migration` (Temporal control plane) lands.

### Trade-offs accepted

- **Two patterns coexist.** Adds conceptual surface area. Justified because Class A and Class B have genuinely different isolation requirements (different ports + adapters vs different data + branding only). Trying to collapse Class A into Class B forces shared domain code on apps that legitimately differ; trying to push Class B into per-node deploy is the GHL anti-pattern (200 deployments instead of 200 rows).
- **RLS is a one-time investment.** The existing `database-rls.md` spec marks RLS as "not yet implemented." Class B forces it (correctly — tenant data must not leak via app bugs). Class A benefits too.
- **Class A still pays its costs.** This recommendation does not reduce per-node deploy overhead for `poly`/`resy`/`operator`. Those costs are real and bounded; we accept them in exchange for hard isolation.
- **Migration path between classes is one-way and rare.** A Class B tenant that grows into wanting its own domain code → split into its own Class A node, copy data over, RLS-scope it out. Should be rare by design (the whole point of B is "you don't need your own code").

### Direct answers to the questions

**Q1: How many new nodes can current setup adequately handle?**
~5–13 more Tier 0 Next.js node-template clones per env on the current 6 GB Cherry VM. Memory is the binding constraint; deploy-matrix complexity is the softer ceiling that bites first at ~15+ nodes globally. CPU + disk have ample headroom.

**Q2: Most efficient setup for spawning new node apps, GHL-style?**
For white-label / reseller-style spawns: do NOT add a node app per tenant. Build one `shared-shell` Next.js app — a **Dolt-only node** pattern — composed of `tenant row + per-tenant Dolt schema + per-tenant agents (via `proj.agent-registry`) + branding overlay`. Provisioning = row insert + DNS API call. Reserve per-node deploys for Class A (materially different domain code).

**Q3 (follow-up): Should nodes split into 3 apps (public / app / admin)?**
No — keep one Next.js per node and standardize four route groups: `(public)` static-rendered, `(app)` authed, `(admin)` DAO-owner-gated (new), `(infra)` ops. Three separate apps fragments the design system + auth pipeline; three route groups inside one deploy is the top-0.1% modern Next.js pattern (Vercel Platforms / Cal.com / Linear's app shell).

## Open Questions

1. **Is anyone actually asking for white-label resellers today, or is this anticipation?** The `proj.operator-plane.md` work mentions "paying gateway customer" but not reseller-flavor multi-tenancy. If no Class B demand exists in the next 90 days, this stays as research — no shared-shell to build yet.
2. **Where would `node-template` itself live?** If we build `shared-shell`, is `node-template` (the scaffold) still relevant, or does it become "the upstream of `shared-shell`"? Likely both — Class A forks need a scaffold; Class B has no fork.
3. **How does DAO governance (`.cogni/repo-spec.yaml`) compose with multi-tenancy?** Today each node has its own repo-spec → its own DAO wallet. A shared-shell with N tenants probably needs per-tenant DAO wallets without per-tenant repo-specs. Needs a design pass before any implementation.
4. **VM-level scaling beyond Cherry's 6GB max.** Cherry VPS tops out at 6 vCore / 6 GB. Adopting Akash (already planned, `infra/provision/akash/FUTURE_AKASH_INTEGRATION.md`) or a larger provider unlocks Class A growth past ~10 nodes/env. Tracked separately.
5. **Single-VM-per-env vs single-VM-for-all-envs.** Today the design intent is per-env VMs but `bug.5009` shows candidate-a is shadow-hosting preview + production namespaces. Resolving that bug clarifies the real per-env memory budget — and changes the answer to Q1 if all envs do end up co-located.

## Proposed Layout

### Project

No new `proj.*` required for Q1 (capacity findings are factual; they inform existing infra-hardening work). For Q2 — if and when Class B demand materializes — a `proj.shared-shell-multitenancy` would gate:

- Phase 1: tenants table + middleware subdomain routing + per-tenant config (single tenant in prod).
- Phase 2: RLS policies on shared schema; contract tests proving cross-tenant isolation.
- Phase 3: tenant provisioning UX (DNS API + sign-up) + per-tenant billing.

### Specs

Two existing specs are the natural homes. **Update in-place rather than fan out:**

- `docs/spec/database-rls.md` (currently scoped to user-level RLS) — extend with a tenant-level section once Class B is real.
- `docs/spec/architecture.md` — add a "Node classes (A: code-distinct, B: tenant-distinct)" subsection once Class B exists in code. Until then, this research doc is the as-of artifact.

### Tasks (only if Class B becomes real; do not preemptively decompose)

The honest sequence, sketched at high level:

1. **Spike**: prove subdomain → tenant_id middleware on a throwaway branch of `node-template`. Cloudflare wildcard cert + middleware rewrite. ~1 PR.
2. **Tenants table + RLS policy template** in `packages/db-schema/` (shared schema additions; not per-node).
3. **`shared-shell` node** (new node under `nodes/shared-shell/`) wiring middleware + RLS + config-row reads end-to-end with one fixture tenant.
4. **Tenant provisioning endpoint** (operator-side) — `POST /api/v1/tenants` + Cloudflare DNS call.
5. **Cut over first real white-label tenant** end-to-end; close `proj.shared-shell-multitenancy` Phase 1.

Per `feedback_no_preemptive_work_item_decomposition.md`, these are not filed as tasks today — only when a Class B demand actually shows up.

### Capacity follow-up (Q1)

A follow-up `bug.*` may be warranted to **codify the capacity ceiling**: extend `infra/catalog/` validation or `scripts/check-node-sizing.mjs` (proposed in `nextjs-node-memory-sizing.md`) to refuse adding a 10th+ node to a single VM/env without a paired VM-sizing decision. Cheap insurance against silently breaching the steady-state ceiling. File only if/when we approach the ceiling.

## Sources

- Internal: `infra/catalog/*.yaml`, `infra/k8s/base/node-app/deployment.yaml`, `infra/k8s/argocd/*-applicationset.yaml`, `infra/provision/cherry/base/terraform.tfvars.example`, `scripts/ci/lib/image-tags.sh`, `.github/workflows/promote-and-deploy.yml`
- Prior research: `docs/research/nextjs-node-memory-sizing.md` (Tier 0 sizing standard)
- Specs: `docs/spec/architecture.md`, `docs/spec/database-rls.md`
- [Vercel Platforms — Multi-tenant template](https://vercel.com/platforms/docs/examples/multi-tenant-template)
- [Next.js Guides — Multi-tenant](https://nextjs.org/docs/app/guides/multi-tenant)
- [GoHighLevel — Whitelabel Sub-Accounts (ideas board)](https://ideas.gohighlevel.com/saas/p/whitelabel-sub-accounts)
- [GoHighLevel White Label 2026 (Nebtrix)](https://nebtrix.io/blog/gohighlevel-white-label-agency-guide-2026)
- [GHL Experts — How to White Label GHL](https://www.ghlexperts.com/agency-saas/how-to-white-label-ghl)
- [John Kavanagh — Building Multi-tenant Applications with Next.js](https://johnkavanagh.co.uk/articles/building-a-multi-tenant-application-with-next-js/)
- [Subdomain-Based Routing in Next.js (Sheharyarishfaq)](https://medium.com/@sheharyarishfaq/subdomain-based-routing-in-next-js-a-complete-guide-for-multi-tenant-applications-1576244e799a)
