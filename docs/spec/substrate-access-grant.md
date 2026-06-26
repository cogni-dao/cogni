---
id: spec.substrate-access-grant
type: spec
title: Substrate Access-Grant Plane
status: draft
trust: draft
summary: How an external node developer, on a `developer` RBAC grant for node X, gains permissioned READ access to node X's observability substrates (Grafana/Loki, PostHog, DB) without seeing other nodes. The operator serves node-scoped reads as a query PROXY pinned to the node (the dev holds no token) rather than issuing a credential, because a returned token's reach escapes the per-node check. Splits substrates into runtime (operator-to-pod secrets plane) vs developer-observability (operator-proxied); per-node isolation feasibility differs by each substrate's native primitive, and the real blocker is the missing node Loki stream label.
read_when: Designing how a dev/agent gains access to a node's logs/analytics/DB; adding a substrate to the access-grant fan-out; deciding whether the operator issues vs proxies a credential; assessing per-node isolation feasibility for a substrate; reviewing the developer-grant route or `node.yaml` substrate declarations.
implements: []
owner: derekg1729
created: 2026-06-16
verified: 2026-06-25
tags:
  - secrets
  - observability
  - rbac
  - node-formation
  - multi-tenancy
---

# Substrate Access-Grant Plane

## Why this exists

The product is the **external node developer workflow**: a dev (human or agent) is granted `developer`
on node X and must be able to **debug node X** — read its logs, analytics, and operational data — **without
Derek handholding** and **without seeing node Y**. Today the grant writes only an OpenFGA tuple; it
provisions **no substrate credential**, so every dev's observability access bottoms out in Derek pasting a
shared token. This spec defines the plane that closes that gap, aligned with the BaaS invariant from
[`node-baas-architecture.md`](./node-baas-architecture.md): **node declares shape; operator wires environment.**

## The two access axes (do not conflate them)

A flat list of substrates (Temporal, Grafana, PostHog, LiteLLM…) hides that they sit on **two different
planes**:

| Axis                        | Flows                                                       | Substrates                                                                   | Status                                                                                                                             |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime substrate**       | operator → pod (the node's app consumes it)                 | LiteLLM virtual key, Temporal _connection_, DSN-write, `SCHEDULER_API_TOKEN` | the **secrets plane** ([`cicd-secrets-expert`](../../.claude/skills/cicd-secrets-expert/SKILL.md)) — a dev never "requests access" |
| **Developer-observability** | dev → operator **proxies** node-scoped (dev holds no token) | Grafana/Loki read, **Langfuse trace read**, PostHog read, read-only DB       | **this plane** — node-scoped reads behind the `developer` gate                                                                     |

LiteLLM is **runtime**: a dev sees their node's LLM _cost_ via Grafana/PostHog, not by holding a LiteLLM
key. It is **out of scope** for the grant plane (its per-node isolation — a per-node virtual key + team +
budget — is a secrets-plane concern).

## Per-node isolation feasibility matrix

Isolation is **not uniform** — each substrate's **native** primitive decides whether per-node read scoping
is even possible. Grounded 2026-06-16:

| Substrate                | Per-node isolation primitive                                                                                                      | Feasible today?               | What's required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owner                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Loki / Grafana**       | server-side LogQL pinned to `{node="X"}` via an **operator proxy** (dev holds no token)                                           | ⚠️ **blocked on a label**     | (1) add a `node` **stream label** in Alloy + pino (today: `app/env/service` only; node id is only in the `pod` prefix) — the real gap; (2) the operator proxy that AND-s `{node="<id>"}` into the dev's query. (Label-scoped `glc_` tokens are an out-of-MVP alternative.)                                                                                                                                                                                                                                                                                        | this plane                        |
| **Langfuse** (AI traces) | tag/metadata filter pinned to `nodeId=X` via an **operator proxy** (MVP); **Project** per node is the hard data boundary (future) | ⚠️ **blocked on a tag**       | (1) stamp `nodeId` on every trace as a **tag + metadata** field — today traces carry only `tags:[providerId,graphId]`, no node, so a shared-project key can't filter to one node (the exact parallel to the Loki-label gap); (2) the operator proxy that AND-s `nodeId=<id>` into the dev's trace-list query, run with the operator-held key. (`LANGFUSE_*` is `shared:true` — ONE Langfuse-Cloud project across all nodes today, so the secret key reads every node's traces; project-per-node + per-node key mint is the deferred hardening, PostHog-parallel.) | this plane                        |
| **Postgres (read)**      | per-node DB `cogni_<node>` + a per-node read-only role                                                                            | ✅ **trivial**                | add `app_<node>_readonly` to the existing per-node provision loop (the per-node DB already exists; today's `app_readonly` is **one shared BYPASSRLS role across all DBs** — a cross-node leak)                                                                                                                                                                                                                                                                                                                                                                    | this plane                        |
| **PostHog**              | **Project** per node (the hard data-isolation boundary)                                                                           | ✅ but split mint             | admin programmatically grants project-X read (default "No access" elsewhere) via the roles/access-control API; **the read key is dev-self-minted or OAuth-consent** — PostHog has no admin-mint-on-behalf and no service-account construct                                                                                                                                                                                                                                                                                                                        | this plane + dev step             |
| **Temporal**             | **Namespace** (Temporal's only authz/visibility unit)                                                                             | ❌ **needs substrate change** | Cogni shares ONE `cogni-<env>` namespace across all nodes; task-queue-per-node (`scheduler-tasks-<nodeId>`) is throughput, **not** authz. Clean fix = **one namespace per node**. A custom authorizer fork leaks `List`/visibility.                                                                                                                                                                                                                                                                                                                               | **substrate dev, not this plane** |
| **LiteLLM**              | per-node virtual key + team + budget                                                                                              | n/a (runtime)                 | secrets-plane concern; dev observes cost via Grafana/PostHog                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | secrets plane                     |

**Key correction baked into this matrix:** the MVP does **not** hand the dev any Grafana token. A returned
token carries its **own** reach, which the per-node OpenFGA check does not govern — a Viewer `glsa_` reads
every node's logs, so issuing it on a single-node grant is a dormant env-wide leak. The operator instead
**proxies** the read, pinned server-side to `{node="X"}`. See
[`grafana-observability-access.md`](./grafana-observability-access.md).

## Current-health scorecard

Confidence is low by design — this plane is barely built. Re-grade as each rung ships and is proven on a
real env.

| Rung                                               | Health | Existing workflow                                                                                                                                                                                                                             | New workflow needed                                                                                        |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| RBAC `developer` grant (the gate)                  | 🟢     | `POST /api/v1/nodes/{id}/developers` + OpenFGA `node.developer`/`can_flight`                                                                                                                                                                  | — (gate fires; the node-scoped read behind it is what's missing)                                           |
| Grafana dev-read — **gate that can't leak**        | 🟡     | `GET /api/v1/nodes/{id}/observability/logs` (task.5025) — RBAC-gated, **always 503 `observability_proxy_not_built`**, holds/returns NO token                                                                                                  | the proxy itself (below), once the Loki label lands                                                        |
| **`node` Loki stream label** (the real blocker)    | 🔴     | Alloy/pino label `app/env/service` only; node id only in `pod` prefix                                                                                                                                                                         | add a `node` (nodeId) stream label in Alloy + pino — **nothing isolates without it** (the MVP task)        |
| Grafana node-pinned **proxy**                      | 🔴     | —                                                                                                                                                                                                                                             | operator runs the dev's LogQL server-side AND-ed with `{node="<id>"}`; dev holds nothing (after the label) |
| **`nodeId` on Langfuse traces** (the real blocker) | 🟡     | **wired on operator** (task.5053): shared `ObservabilityGraphExecutorDecorator` stamps `config.nodeId` onto trace tags + metadata; operator factory injects `container.nodeId`; warn-once if unwired                                          | node-template wires the same one line (non-breaking — `nodeId` optional); then the proxy below can filter  |
| Langfuse node-pinned **proxy**                     | 🟡     | **built** (task.5053): `GET /nodes/{id}/observability/traces` — `developer`-RBAC-gated, `LangfuseReaderPort`/`HttpLangfuseReader` pinned server-side to `tags=<nodeId>` via the operator-held key; dev holds nothing (mirrors the logs proxy) | live cand-a proof (exercise a graph → read the stamped trace through the proxy)                            |
| Postgres read isolation                            | 🔴     | per-node DB + `app_<node>` write roles exist (`postgres-init/provision.sh`)                                                                                                                                                                   | per-node `app_<node>_readonly` role (trivial loop add); operator proxies or hands a scoped read DSN        |
| PostHog per-node read                              | 🔴     | PostHog Cloud (one project today)                                                                                                                                                                                                             | project-per-node + admin grant via access-control API + dev self-mint / OAuth consent                      |
| Temporal per-node read                             | 🔴     | shared `cogni-<env>` namespace; per-node task queue                                                                                                                                                                                           | **per-node namespace** (substrate change) — tracked on the substrate dev, not here                         |

🔴 leads because **only the RBAC gate is green**; the node-scoped read behind it is unbuilt, and its
prerequisite (the `node` Loki label) does not exist. Real confidence needs weeks of green node spawns
proving per-node isolation per env.

## Architecture — operator-mediated, node-scoped reads (proxy, not issuer)

The operator is a **node-pinned proxy / scoped-DSN broker**, NOT a credential issuer. The reason is the
**reach** problem: a token handed to a dev — even behind a per-node OpenFGA check — carries its **own**
reach, which the check does not govern. The env's shared Grafana Viewer token reads _every_ node's logs, so
returning it to a dev granted on **one** node is a dormant env-wide leak. A server-side pinned read has no
such gap: the per-node check gates **who**, and the server pin gates **reach**. So:

- The node **declares** which observability substrates it emits to (`.cogni/node.yaml`).
- On a `developer` grant (the existing `POST /nodes/{id}/developers` tuple write), the operator gates the
  dev's read with the `node.flight` tuple, then serves it **node-scoped**: Grafana/Loki via a server-side
  proxy pinned to `{node="<id>"}`; Postgres via a per-node read-only DSN scoped to `cogni_<node>`.
- The dev **holds no env-wide credential**. The operator is an **MVP query proxy / scoped-DSN broker**, not
  a token issuer. (A `GrafanaTokenBroker`-style "mint and hand over" port is the rejected shape — each
  returned token's reach escapes the per-node check.)

This is a new row in the [BaaS Substrate Map](./node-baas-architecture.md#baas-substrate-map):
**Observability Access** — _node declares which substrates it emits to; operator serves per-node-scoped
reads on `developer` grant (proxy / scoped DSN), the dev holding no env-wide credential._

## Sequencing (Pareto)

1. **Gate that can't leak** — ship the RBAC-gated dev-read route as a guarded `503` stub (done, task.5025).
   Proves the per-node gate in a live deploy; cannot leak a token because it returns none.
2. **`node` Loki stream label** (Alloy + pino) — the actual substrate gap. **Nothing isolates without it.**
   This is the real MVP task; everything Grafana waits on it.
3. **Grafana node-pinned proxy** — operator runs the dev's LogQL AND-ed with `{node="<id>"}`. Dev holds
   nothing; node-scoped from day one.
4. **`nodeId` on Langfuse traces** (decorator tag + metadata) — the AI-trace substrate gap, twin of the
   `node` Loki label. **Nothing isolates without it.** Cheap: inject `getNodeId()` where the decorator
   already binds `billingAccountId`.
5. **Langfuse node-pinned proxy** — `GET /nodes/{id}/observability/traces`, the operator runs the dev's
   trace-list AND-ed with `nodeId=<id>` via its own key; dev holds nothing (the secret key reads the shared
   project = every node's traces, so it is never handed over — same reach correction as Grafana).
6. **`app_<node>_readonly` role** — trivial loop add; per-node DB read via a scoped DSN.
7. **PostHog project-per-node** + admin grant + dev self-mint — when analytics matters. **Langfuse
   project-per-node** + per-node key mint + ESO is the same shape, deferred until shared-project tag
   isolation proves insufficient.
8. **Temporal per-node namespace** — a substrate-dev dependency on `story.5006`; explicitly **not**
   solvable by this plane (namespace is Temporal's only isolation unit and is shared today).

**Explicitly out of MVP scope (do not build now):** per-principal label-scoped `glc_` access-policy tokens,
per-dev Grafana service accounts, any path that mints a token and hands it to a dev. They re-introduce a
held credential whose reach the per-node check cannot govern; the proxy makes them unnecessary.

## See also

- [`grafana-observability-access.md`](./grafana-observability-access.md) — Grafana proxy-not-issuer + the Loki-label blocker
- [`node-baas-architecture.md`](./node-baas-architecture.md) — BaaS substrate map + "node declares shape; operator wires environment"
- [`rbac.md`](./rbac.md) — OpenFGA `node.developer`/`can_flight`, the grant→approve loop
- [`.claude/skills/cicd-secrets-expert/SKILL.md`](../../.claude/skills/cicd-secrets-expert/SKILL.md) — runtime-substrate secrets plane (the other axis)
- `nodes/operator/app/src/app/api/v1/nodes/[id]/observability/logs/route.ts` — the guarded gate (proxy, never a token)
