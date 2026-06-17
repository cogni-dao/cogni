---
id: spec.grafana-observability-access
type: spec
title: Grafana / Loki Observability Access
status: draft
trust: draft
summary: How a developer-RBAC'd dev reads only their node's Grafana/Loki logs without holding a token — the operator is a node-pinned query PROXY (runs the dev's LogQL server-side, constrained to the node label) rather than a credential issuer, because a returned token's reach is ungoverned by the per-node check while a pinned proxy is node-scoped by construction. The operator's own liveness gate still holds no token (it uses the public run-carries rung). Blocked today on node Loki streams lacking a node stream label.
read_when: Wiring or debating whether the operator/API should hold or hand out a Grafana token; granting a dev/agent Loki query access; designing an automated observability gate; reviewing an ExternalSecret that pulls a GRAFANA_* key into a pod; deciding proxy-vs-issuer for observability reads.
owner: derekg1729
created: 2026-06-16
verified: 2026-06-17
tags:
  - secrets
  - observability
  - grafana
---

# Grafana / Loki Observability Access

**Decision (2026-06-17):** for a dev reading **their node's** logs, the operator is a **node-pinned query
PROXY**, NOT a credential issuer. The dev sends a query; the operator runs it server-side **constrained to
`{node="<id>"}`** and returns only that node's lines. **The dev never holds a token** — so access is
node-scoped from day one.

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

## The real blocker — node Loki streams have no `node` label

Neither a proxy nor a scoped token can isolate a node's logs if the logs aren't labeled per node. Today
Alloy/pino label streams `app` / `env` / `service` only; node identity lives in the `pod` name prefix and a
JSON field inside the line — **there is nothing for a `{node="<id>"}` selector to match.** So the
**sequence** is:

1. **Add a `node` (nodeId) stream label** to node Loki streams (Alloy + pino) — the actual substrate gap.
2. **Operator query-proxy** that runs the dev's LogQL server-side, AND-ed with `{node="<id>"}`, returning
   only that node's lines. The operator holds its own read token for this; the dev holds nothing.

Until (1) lands, the dev-read route (`GET /api/v1/nodes/{id}/observability/logs`) is a **guarded stub**:
developer-RBAC-gated, but **always `503 observability_proxy_not_built`** — it holds no token and returns
none, so it cannot leak.

**Out of MVP scope (do not build now):** per-principal label-scoped `glc_` access-policy tokens, per-dev
Grafana service accounts, any "mint a token and hand it to the dev" path. Those re-introduce a held
credential; the proxy makes them unnecessary for the debug-my-node use case.

## The provisioned credentials (unchanged)

Provisioning demands **one** human input — the Grafana Cloud **admin** token (`GH_GRAFANA_CLOUD_ADMIN_TOKEN`
`glc_*` + `GRAFANA_URL`, `fork-quickstart.md` §6). Phase 5e (`scripts/setup/provision-grafana-cloud-mint.sh`)
derives **scoped** credentials — the admin token never leaves the runner (Invariant 13: never written to
OpenBao, never reaches the VM). From that one root:

| consumer           | credential                                            | where it lives                                                    | who/what queries                                                           |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Validator / CI** | child **Viewer** SA `glsa_` (read: datasource + logs) | `cogni/<env>/_shared/{GRAFANA_URL,GRAFANA_SERVICE_ACCOUNT_TOKEN}` | `/validate-candidate` scorecard, `scripts/loki-query.sh`, agent self-trace |
| **Alloy push**     | access-policy `glc_` (write: metrics/logs)            | VM `.env` (Compose)                                               | Alloy remote-write only                                                    |
| **Dev node-read**  | **none — the operator proxies** (its own read token)  | the operator pod (never handed out)                               | the operator, server-side pinned to `{node="<id>"}` on the dev's behalf    |

The validator/CI shared Viewer token is fine: validator and CI are **trusted env-wide consumers**, not
per-node-scoped principals. The per-node concern is the **external dev**, and that path is the proxy above.

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
- `fork-quickstart.md` §6 (Phase 5e mint), `infra/secrets-catalog.yaml` (`GRAFANA_*` = `service: _shared`)
- `docs/spec/secrets-classification.md` (tier/routing), `.claude/skills/cicd-secrets-expert/SKILL.md`
- `nodes/operator/app/src/app/api/v1/nodes/[id]/observability/logs/route.ts` (guarded stub — proxy, never a token)
- `nodes/operator/app/src/features/nodes/flight-status.ts` (`assertLive`), `task.5024`, `task.5025`
