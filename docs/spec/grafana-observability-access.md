---
id: spec.grafana-observability-access
type: spec
title: Grafana / Loki Observability Access
status: draft
trust: draft
summary: How a developer-RBAC'd dev reads only their node's logs through ONE stable operator endpoint (GET /api/v1/nodes/{id}/observability/logs) — the node-dev contract is a fixed envelope over a SWAPPABLE log backend. The operator is a node-pinned query PROXY (runs the read server-side, constrained to the node) rather than a credential issuer, because a returned token's reach is ungoverned by the per-node OpenFGA check. v0 (shipped #1734/task.5025) isolates on Grafana Cloud by forcing the LogQL selector and rejecting braces — a brittle compromise forced by Cloud being a single tenant. The top-0.1% OSS target is self-hosted OSS Loki with native multi-tenancy (X-Scope-OrgID per node), which eliminates the query-surgery, is free + sovereign, and is reachable only via the operator gateway. The backend swaps; the node-dev contract does not.
read_when: Wiring or debating whether the operator/API should hold or hand out a Grafana token; granting a dev/agent log-read access; designing an automated observability gate; reviewing an ExternalSecret that pulls a GRAFANA_* key into a pod; deciding proxy-vs-issuer for observability reads; planning the Grafana-Cloud to self-hosted-OSS-Loki migration; stamping a node id on shared-infra (scheduler-worker / litellm / cicd) log lines.
owner: derekg1729
created: 2026-06-16
verified: 2026-06-18
updated: 2026-06-18
tags:
  - secrets
  - observability
  - grafana
  - loki
  - multi-tenancy
---

# Grafana / Loki Observability Access

## The held design — a stable envelope over a swappable backend

The node-dev observability interface is **one stable operator endpoint** with a **swappable log backend
behind it**:

- **Stable envelope (the contract):** `GET /api/v1/nodes/{id}/observability/logs` — OpenFGA
  `developer`-grant gated, the dev holds **no** backend token. This surface does **not** change across
  backend swaps.
- **Swappable backend (the substrate):** today → **Grafana Cloud Loki**; target → **self-hosted OSS
  Loki**. The operator translates the stable read into whatever the current backend speaks.

This is the same swappable-substrate stance the operator takes for other backends (the
`TEMPORAL_IS_SWAPPABLE_SUBSTRATE` pattern — the node-facing port is portable; the substrate behind it is
the operator's managed convenience, swappable without changing the node's contract). A node that wants its
own log store swaps the backend behind the same endpoint; nothing in its repo-spec or read path changes.
_(The sibling `node-temporal-tenant-interface` design doc is forthcoming — see "Open" below.)_

**Named invariants:**

- **`OBSERVABILITY_BACKEND_IS_SWAPPABLE`** — the node-dev contract is `GET …/observability/logs`; Grafana
  Cloud vs self-hosted OSS Loki is an implementation detail behind it, swapped without breaking the dev.
- **`AUTH_IS_OPENFGA_GATED`** — WHO can read is the `developer`/`node.flight` OpenFGA tuple, on every
  backend. The dev never holds a backend credential.
- **`ISOLATION_IS_TENANT_NATIVE_NOT_QUERY_SURGERY`** (target) — per-node REACH must be enforced by the
  backend's native tenancy (`X-Scope-OrgID`), not by string-building + guarding LogQL. v0 violates this by
  necessity (see shortcomings); the OSS target restores it.
- **`LOKI_ONLY_VIA_GATEWAY`** (target) — OSS Loki trusts `X-Scope-OrgID` blindly, so it must be reachable
  **only** via the operator gateway. Direct network reach = forged-tenant bypass.
- **`OSS_ONLY_OR_CRYPTO_PAID`** — no fiat-billed Cloud-Advanced / LBAC. Per-node tenancy is bought with
  self-hosted OSS, never a paid Grafana Cloud tier.

## Decision: proxy, not issuer

**Decision (2026-06-17):** for a dev reading **their node's** logs, the operator is a **node-pinned query
PROXY**, NOT a credential issuer. The dev sends a query; the operator runs it server-side **constrained to
the node** and returns only that node's lines. **The dev never holds a token** — so access is node-scoped
from day one.

> **Why proxy, not issuer (the load-bearing correction).** Handing the dev a token — even behind a per-node
> OpenFGA check — gates **who** gets the token, not **what the token can reach**. The env's shared Viewer
> token reads _every_ node's logs; the moment ESO wires it into the operator and the route returns it, any
> dev granted on **one** node holds a god-token for **all** nodes in that env. That is the exact inverse of
> the substrate thesis (_operator wires a per-node isolated environment_). A server-side pinned proxy has no
> such gap: the per-node check gates **who**, and the pinned selector gates **reach**. An earlier draft of
> this spec flipped to "issuer not proxy" — that was the wrong turn and is reverted here.

> **Scope keeps the proxy convergent.** The objection to a proxy is "the LogQL/dashboard/datasource query
> space is open-ended and never converges." True for _arbitrary Grafana access_ — so that is NOT the MVP.
> The MVP proxy serves exactly one shape: **read this node's log lines** (LogQL pinned to the node label).
> Dashboards, datasource introspection, and ad-hoc multi-tenant queries are out of scope.

## v0 — shipped (Grafana Cloud, isolation by query surgery)

v0 (`#1734` / `task.5025`, live on candidate-a; node label `task.5028`) proxies the read against **Grafana
Cloud Loki**. The operator builds the LogQL server-side, **forcing** the stream selector to
`{env=…, service="app", node="<nodeId>"}` and returning only that node's lines. **OpenFGA gates WHO** (the
`developer` tuple in the route); **the forced selector gates REACH** (the dev cannot widen scope).

The security core is
[`nodes/operator/app/src/features/nodes/observability-logs.ts`](../../nodes/operator/app/src/features/nodes/observability-logs.ts)
(`buildNodeScopedLogQL`): the selector is constructed by the operator (`SELECTOR_IS_FORCED`), and the
optional dev `filter` is appended **as a LogQL pipeline only** — braces `{`/`}` are rejected so a dev cannot
open a second selector (e.g. `} or {node="other"}`) to escape the pin (`FILTER_IS_PIPELINE_ONLY`).

This works, but be honest about why it has this shape: it is a **compromise forced by Grafana Cloud being a
single tenant** for us. Per-node tenancy on Cloud needs paid LBAC, which we will **not** buy
(`OSS_ONLY_OR_CRYPTO_PAID`). So v0 hand-rolls isolation in the query string.

### v0 shortcomings (state them plainly)

1. **`ISOLATION_BY_QUERY_SURGERY` (the bug surface).** Isolation is enforced by string-building LogQL and
   rejecting `{`/`}` in the dev filter to block selector-injection. Hand-rolled query-string guards are
   brittle and bug-prone — one missed escape or a new LogQL syntax is a cross-node leak. This is the direct
   consequence of Cloud being single-tenant; the OSS target removes the surgery entirely.
2. **`SHARED_INFRA_NOT_NODE_ATTRIBUTABLE` (the real debugging gap).** temporal / scheduler-worker / litellm
   / cicd logs carry **no `node` label** (`scheduler-worker`'s `makeLogger()` binds no `nodeId` —
   empirically 0 lines for a node filter), so a node dev can only see their own **app** pods — they cannot
   debug failures that cross shared infra (a scheduler dispatch, an LLM call, a flight for their node).
   Most real node failures live in shared infra, so this is the gap that matters most. Fix = the
   "Shared-infra attribution" section below (orthogonal to the backend).
3. **`ENV_LIST_HARDCODED` (reduced, #1739).** The proxy no longer keeps its own env copy — it reuses the
   canonical `FLIGHT_ENVS` (candidate-a / preview / production), so a new env is added in one place. But
   `FLIGHT_ENVS` is still a hardcoded const, not catalog-driven; truly env-agnostic reads would source the
   deploy-env set from the catalog.
4. **`COST_CAPACITY_OWNERSHIP`.** Grafana Cloud bills **fiat**, we have already hit a capacity block (logs
   blocked), and it runs on a **personal account** — not sovereign. This violates `OSS_ONLY_OR_CRYPTO_PAID`
   and is the trigger for the migration below.

## Node-dev log scope envelope

What a node developer can read is bounded by what is **node-attributable** (the detail behind shortcoming 2):

| Source                                | `service`          | Node-attributable?                                                                                                       | In the proxy?                                                                                                                      |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Node app pod                          | `app`              | ✅ carries the `node` stream label                                                                                       | **Yes** — the MVP                                                                                                                  |
| Graph execution worker                | `scheduler-worker` | ❌ **not today** — `makeLogger()` binds no `nodeId`; it is node-aware (one Worker per nodeId) so it _could_, but doesn't | **No** — until it stamps `nodeId` (Shared-infra attribution), then reachable through the same gateway (Cloud: filter; OSS: tenant) |
| Temporal / LiteLLM / Caddy / Postgres | shared infra       | ❌ **never** per-line node-attributable unless it stamps `nodeId`                                                        | **No** — operator-only until stamped; a node dev escalates to the operator                                                         |
| CI / build failures                   | `env="ci"`         | not node-scoped (per-PR)                                                                                                 | **No** — the dev sees their PR's checks on GitHub                                                                                  |

**Envelope rule:** the proxy serves only services that carry per-node attribution. Today that is `app`
(via the `node` label). The next rung is binding `nodeId` into node-aware shared services so their per-node
lines become reachable through the same gateway — **not** by widening the selector to a shared service
(that would leak cross-node lines).

## Target — self-hosted OSS Loki with native multi-tenancy

The top-0.1% OSS direction is **self-hosted OSS Loki** (AGPL) using its **native multi-tenancy**: one
**`X-Scope-OrgID=<nodeId>`** tenant per node. Loki enforces per-node isolation **natively** — the operator
gateway sets the header from the OpenFGA grant, and Loki returns only that tenant's streams. This:

- **eliminates the LogQL string-surgery** — no query parsing, no brace-guarding, no forced-selector
  builder; per-node REACH is a backend primitive (`ISOLATION_IS_TENANT_NATIVE_NOT_QUERY_SURGERY`);
- is **free, sovereign, and OpenFGA-aligned** — the per-node grant maps 1:1 to a Loki tenant id, satisfying
  `OSS_ONLY_OR_CRYPTO_PAID`.

**Hard requirement (`LOKI_ONLY_VIA_GATEWAY`).** OSS Loki **trusts `X-Scope-OrgID` blindly** — there is no
auth on the header. So Loki must be reachable **only** via the operator gateway: any direct network path
lets a caller forge the tenant header and read every node. This is a network-isolation invariant — the
operator gateway is the **sole ingress**, and Loki has no externally-routable address.

## Shared-infra attribution (orthogonal — applies to either backend)

Shortcoming (2) is **not** a Cloud-vs-OSS question — it is a **logging-instrumentation** gap that must be
fixed independent of the backend. Node-scoped work running in shared infra must **stamp `nodeId` as a Pino
field** on its log lines:

- **scheduler-worker** — when dispatching/executing for a node (`scheduler-tasks-<nodeId>`);
- **litellm** — on calls attributable to a node;
- **cicd** — on flights run for a node.

With `nodeId` stamped, those lines are filterable (Cloud: into the forced selector / line filter) or
routable (OSS: into the node's `X-Scope-OrgID` tenant) to the node's view. This is the fix for the real
debugging gap and lands the same way regardless of which backend is live.

## Migration — Cloud → OSS Loki (contract unchanged)

The migration **swaps the backend behind the operator endpoint**; the node-dev contract
(`GET …/observability/logs`, OpenFGA-gated, dev holds no token) is **unchanged** — that is the whole point
of the stable envelope.

**Trigger:** `COST_CAPACITY_OWNERSHIP` — the fiat bill, the capacity block, and the personal-account
sovereignty problem.

**Sequence:**

1. **Stamp `nodeId`** on shared-infra log lines (the orthogonal fix above) — unblocks cross-infra
   debugging on the current backend immediately.
2. **Stand up self-hosted OSS Loki** behind the operator gateway, with **no externally-routable address**
   (`LOKI_ONLY_VIA_GATEWAY`).
3. **Point Alloy** at OSS Loki, writing each stream to its node's tenant (`X-Scope-OrgID=<nodeId>`).
4. **Switch the operator proxy** to set `X-Scope-OrgID` from the OpenFGA grant and **drop** the
   forced-selector / brace-guarding LogQL surgery (`ISOLATION_IS_TENANT_NATIVE_NOT_QUERY_SURGERY`).
5. **Decommission** the Grafana Cloud personal account once parity is proven on a live env.

**Out of MVP scope (do not build now):** per-principal label-scoped `glc_` access-policy tokens, per-dev
Grafana service accounts, any paid Cloud-Advanced / LBAC tier, any "mint a token and hand it to the dev"
path. Those re-introduce a held credential or a fiat bill; the proxy + OSS tenancy make them unnecessary.

## Open

- **`node-temporal-tenant-interface` design doc does not exist yet.** This spec cites the
  `TEMPORAL_IS_SWAPPABLE_SUBSTRATE` pattern as a sibling; the design doc is owed (dev-manager). Until it
  lands, the pattern is named here, not hyperlinked, to avoid a dangling reference.

## The provisioned credentials (Cloud v0)

Provisioning demands **one** human input — the Grafana Cloud **admin** token (`GH_GRAFANA_CLOUD_ADMIN_TOKEN`
`glc_*` + `GRAFANA_URL`, `fork-quickstart.md` §6). Phase 5e (`scripts/setup/provision-grafana-cloud-mint.sh`)
derives **scoped** credentials — the admin token never leaves the runner (Invariant 13: never written to
OpenBao, never reaches the VM). From that one root:

| consumer           | credential                                            | where it lives                                                    | who/what queries                                                           |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Validator / CI** | child **Viewer** SA `glsa_` (read: datasource + logs) | `cogni/<env>/_shared/{GRAFANA_URL,GRAFANA_SERVICE_ACCOUNT_TOKEN}` | `/validate-candidate` scorecard, `scripts/loki-query.sh`, agent self-trace |
| **Alloy push**     | access-policy `glc_` (write: metrics/logs)            | VM `.env` (Compose)                                               | Alloy remote-write only                                                    |
| **Dev node-read**  | **none — the operator proxies** (its own read token)  | the operator pod (never handed out)                               | the operator, server-side pinned to the node on the dev's behalf           |

The validator/CI shared Viewer token is fine: validator and CI are **trusted env-wide consumers**, not
per-node-scoped principals. The per-node concern is the **external dev**, and that path is the proxy above.
(Under the OSS target this table collapses: Alloy writes per-node tenants, the operator reads via
`X-Scope-OrgID`, and the shared Viewer token is no longer the node-read path.)

## Why the operator's own liveness gate holds no token (unchanged)

The operator's `flight-status` / `assertLive` gate (`task.5024`, `src/features/nodes/flight-status.ts`) is
**liveness-only**, proven by the two PUBLIC rungs — `serving` (`/readyz`) and `run-carries` (a real graph
run completes). **`run-carries` transitively proves the rest:** a completed run means the scheduler-worker
polled `scheduler-tasks-<nodeId>` (routing), the `SCHEDULER_API_TOKEN` matched (no 401 — `bug.5021`), the
graph executed, and the run was written to the DB. So the **gate** needs no Grafana token and holds none.

This is distinct from the dev-read proxy: the gate gets its verdict **publicly** (run-carries), so it must
not query Loki at all; the dev-read genuinely needs a Loki query, which the operator runs **pinned to one
node**. Both keep arbitrary Loki query power out of the open path.

**Anti-pattern:** wiring `cogni/<env>/_shared/GRAFANA_SERVICE_ACCOUNT_TOKEN` into the operator pod to make
the **liveness gate** self-query Loki (it has a public verdict already), **or** returning any Grafana token
to a dev from an API route (a dormant env-wide leak). The sanctioned shape is the node-pinned proxy.

## See also

- [`docs/spec/substrate-access-grant.md`](./substrate-access-grant.md) — the cross-substrate plane (Grafana/PostHog/DB/Temporal), health scorecard, sequencing
- [`docs/spec/node-baas-architecture.md`](./node-baas-architecture.md) — BaaS substrate map; "node declares shape; operator wires environment"
- `TEMPORAL_IS_SWAPPABLE_SUBSTRATE` — the sibling swappable-substrate pattern (design doc `node-temporal-tenant-interface` forthcoming)
- `fork-quickstart.md` §6 (Phase 5e mint), `infra/secrets-catalog.yaml` (`GRAFANA_*` = `service: _shared`)
- `docs/spec/secrets-classification.md` (tier/routing), `.claude/skills/cicd-secrets-expert/SKILL.md`
- `nodes/operator/app/src/features/nodes/observability-logs.ts` (`buildNodeScopedLogQL` — the v0 forced-selector security core)
- `nodes/operator/app/src/app/api/v1/nodes/[id]/observability/logs/route.ts` (the OpenFGA-gated proxy route — never returns a token)
- `nodes/operator/app/src/features/nodes/flight-status.ts` (`assertLive`), `task.5024`, `task.5025`, `#1734`
