---
id: spec.grafana-observability-access
type: spec
title: Grafana / Loki Observability Access
status: draft
trust: draft
summary: How a developer-RBAC'd dev reads only their node's Grafana/Loki logs without holding a token — the operator is a node-pinned query PROXY (runs the dev's LogQL server-side, scoped to that one node's app stream) rather than a credential issuer, because a returned token's reach is ungoverned by the per-node check while a pinned proxy is node-scoped by construction. BUILT — task.5028 node label plus task.5025 proxy. Scope envelope covers only node-attributable services (app today); shared infra is operator-only. The operator's own liveness gate still holds no token.
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

## Status — built (task.5028 + task.5025)

The two prerequisites landed:

1. **`node` (nodeId) stream label** — Alloy promotes the pino `nodeId` field to a Loki stream label
   (`task.5028`, `infra/compose/runtime/configs/alloy-config{,.metrics}.alloy`). Proven live on
   candidate-a: `{env="candidate-a", service="app", node="<id>"}` selects exactly one node's app logs.
2. **Operator query-proxy** — `GET /api/v1/nodes/{slug|node_id}/observability/logs?env=&query=`
   (`task.5025`, `src/features/nodes/observability-logs.ts`): developer-RBAC-gated. The caller sends the
   **same full LogQL** they'd run against `loki-query.sh` / the MCP (`?query=`); the operator parses the
   stream selector, **forces** `env`/`service`/`node` to the caller's node and lets any other label
   matcher only narrow (out-of-scope selectors → `400`), then runs it with the operator's own read token
   and returns only that node's lines. The dev holds nothing. An empty `query` returns the node's app
   stream. Returns `503 observability_unwired` where the operator pod has no `_shared` Grafana read creds.
   This is 1:1 with the operator-scope MCP path for the caller's slice — same syntax, same JSON output.

**Out of MVP scope (do not build):** per-principal label-scoped `glc_` access-policy tokens, per-dev
Grafana service accounts, any "mint a token and hand it to the dev" path — they re-introduce a held
credential the per-node check can't govern. The proxy makes them unnecessary.

## Node-dev log scope envelope

What a node developer can read is bounded by what is **node-attributable**. Stated so it does not drift:

| Source                                | `service`          | Node-attributable?                                                                                                       | In the proxy?                                                                                                                             |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node app pod                          | `app`              | ✅ carries the `node` stream label                                                                                       | **Yes** — the MVP                                                                                                                         |
| Graph execution worker                | `scheduler-worker` | ❌ **not today** — `makeLogger()` binds no `nodeId`; it is node-aware (one Worker per nodeId) so it _could_, but doesn't | **No** — until it binds `nodeId` (follow-up), then add it to the proxy's allowed services with a forced `\| json \| nodeId="<id>"` filter |
| Temporal / LiteLLM / Caddy / Postgres | shared infra       | ❌ **never** per-line node-attributable (not node-aware)                                                                 | **No** — an operator-only debugging surface; a node dev escalates to the operator                                                         |
| CI / build failures                   | `env="ci"`         | not node-scoped (per-PR)                                                                                                 | **No** — the dev sees their PR's checks on GitHub                                                                                         |

**Envelope rule:** the proxy serves only services that carry per-node attribution. Today that is `app`
(via the `node` label) — a caller `service=` matcher must equal `app` or the query is rejected
`query_out_of_scope`. The next rung is binding `nodeId` into node-aware shared services
(`scheduler-worker` first) so their per-node lines become reachable by widening the `service` allowlist
in `scopeNodeLogQL` — **not** by trusting a caller-supplied selector to a shared service (that would leak
cross-node lines).

**Env envelope:** the readable envs are the canonical `FLIGHT_ENVS` (`candidate-a` · `preview` ·
`production`) — the same set a node deploys through. The proxy imports that list rather than re-declaring
it, so a new deploy env is readable automatically. Note: real multi-node validation is **prod-only**
(operator is the only node deployed to candidate-a).

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
- `nodes/operator/app/src/app/api/v1/nodes/[id]/observability/logs/route.ts` + `src/features/nodes/observability-logs.ts` (the built proxy — node-pin builder, never a token)
- `nodes/operator/app/src/features/nodes/flight-status.ts` (`assertLive`), `task.5024`, `task.5025`
