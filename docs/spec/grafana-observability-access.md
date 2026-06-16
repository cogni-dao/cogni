---
id: spec.grafana-observability-access
type: spec
title: Grafana / Loki Observability Access
status: draft
trust: draft
summary: How Grafana/Loki query credentials are granted across Cogni — one provisioned admin root mints three scoped consumers (validator/CI `_shared` Viewer, Alloy push, dev-direct RBAC tokens). The operator control plane is NOT a Grafana proxy and holds no query token; assertLive gates on the public run-carries rung.
read_when: Wiring or debating whether the operator/API should hold a Grafana token; granting a dev/agent Loki query access; designing an automated observability gate; reviewing an ExternalSecret that pulls a GRAFANA_* key into a pod.
owner: derekg1729
created: 2026-06-16
verified: 2026-06-16
tags:
  - secrets
  - observability
  - grafana
---

# Grafana / Loki Observability Access

**Decision (2026-06-16):** the operator control plane does **NOT** hold a Grafana query token, and the
API is **NOT** a Grafana proxy. Observability querying is a **read-only credential granted directly to
the consumer**, because the space of future LogQL / dashboard / datasource queries is open-ended and
proxying it through typed API routes would never converge.

## The one root, three consumers

Provisioning demands **one** human input — the Grafana Cloud **admin** token (`GH_GRAFANA_URL` +
admin token, `fork-quickstart.md` §6). Phase 5e (`provision-grafana-cloud-mint.sh`) uses it to mint
**derived, scoped** credentials — never the admin token itself leaves the runner. From that one root:

| consumer                       | credential                                            | where it lives                                                    | who/what queries                                                           |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Validator / CI**             | child **Viewer** SA `glsa_` (read: datasource + logs) | `cogni/<env>/_shared/{GRAFANA_URL,GRAFANA_SERVICE_ACCOUNT_TOKEN}` | `/validate-candidate` scorecard, `scripts/loki-query.sh`, agent self-trace |
| **Alloy push**                 | access-policy `glc_` (write: metrics/logs)            | VM `.env` (Compose)                                               | Alloy remote-write only                                                    |
| **Devs / agents (open-ended)** | per-principal Viewer `glsa_`, RBAC-granted            | the dev's own `.env.cogni` / session                              | anything — ad-hoc LogQL, dashboards, datasource introspection              |

**The admin token can spawn any of these on demand** — so a new dev/agent who needs Grafana gets a
_direct_ read-only token (grant via RBAC, mint a per-principal Viewer SA), **not** a new API route.

## Why the operator holds no token

The operator's `flight-status` / `assertLive` gate (`task.5024`,
`src/features/nodes/flight-status.ts`) is **liveness-only**, proven by the two PUBLIC rungs — `serving`
(`/readyz`) and `run-carries` (a real graph run completes). **`run-carries` transitively proves the
rest:** a completed run means the scheduler-worker polled `scheduler-tasks-<nodeId>` (routing), the
`SCHEDULER_API_TOKEN` matched (no 401 — `bug.5021`), the graph executed, and the run was written to the
DB. So the gate needs **no** Grafana token, and the operator prober holds none.

Deeper **observability verification** (did the node's runs actually emit logs in Loki? is the worker
polling the UUID queue?) is a query against Loki, and querying belongs to whoever **directly** holds a
read token — the dev in `/validate-candidate`, or CI — **not** the operator. That is north-star ②
(`task.5025`): a flighting dev gets a developer-RBAC-scoped `glsa_` read token (minted from the admin
root, OpenBao/ESO custody) and reads their deployment's Grafana/Loki **directly**.

**Anti-pattern:** wiring `cogni/<env>/_shared/GRAFANA_SERVICE_ACCOUNT_TOKEN` into the operator pod's
ExternalSecret to make the gate self-query Loki. That turns the control plane into a Grafana proxy for a
verdict it already gets publicly, and a proxy never converges on the open-ended query space. Don't.

## See also

- `fork-quickstart.md` §6 (Phase 5e mint), `infra/secrets-catalog.yaml` (`GRAFANA_*` = `service: _shared`)
- `docs/spec/secrets-classification.md` (tier/routing), `.claude/skills/cicd-secrets-expert/SKILL.md`
- `nodes/operator/app/src/features/nodes/flight-status.ts` (`assertLive`), `task.5024`
