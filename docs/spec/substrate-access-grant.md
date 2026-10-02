---
id: spec.substrate-access-grant
type: spec
title: Substrate Access-Grant Plane
status: draft
trust: draft
summary: How an external node developer, on a `developer` RBAC grant for node X, gains permissioned READ access to node X's observability substrates without seeing other nodes. The operator proxies node-scoped observability reads rather than issuing an env-wide credential. Database support is a separate node-owned execution plane tracked by story.5052.
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

> **Classification and drift notice (2026-09-29):** this remains a draft, not an
> implementation source of truth. Node-scoped log reads have shipped; the status
> tables below were written before that delivery. Database support/repair work is
> tracked in Dolt as `story.5052`, and the durable boundary is proposed in Dolt
> knowledge as `operator:node-data-support-plane`
> (`contrib-flock-leader-5be60d48`). Until that contribution is merged,
> [`multi-node-tenancy.md`](./multi-node-tenancy.md) is authoritative: the
> operator authorizes and routes, while the owning node executes database reads
> and mutations. **Do not build an operator-side cross-node SQL proxy or issue an
> env-wide DSN from this draft.**

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
| **Loki / Grafana**       | server-side LogQL pinned to `{node="X"}` via an **operator proxy** (dev holds no token)                                           | ✅ **shipped**                | `GET /api/v1/nodes/{id}/observability/logs` forces node, environment, and service selectors server-side and returns lines without exposing the Grafana credential. See the merged `node-service-logs-read` knowledge guide.                                                                                                                                                                                                                                                                                                                                       | this plane                        |
| **Langfuse** (AI traces) | tag/metadata filter pinned to `nodeId=X` via an **operator proxy** (MVP); **Project** per node is the hard data boundary (future) | ⚠️ **blocked on a tag**       | (1) stamp `nodeId` on every trace as a **tag + metadata** field — today traces carry only `tags:[providerId,graphId]`, no node, so a shared-project key can't filter to one node (the exact parallel to the Loki-label gap); (2) the operator proxy that AND-s `nodeId=<id>` into the dev's trace-list query, run with the operator-held key. (`LANGFUSE_*` is `shared:true` — ONE Langfuse-Cloud project across all nodes today, so the secret key reads every node's traces; project-per-node + per-node key mint is the deferred hardening, PostHog-parallel.) | this plane                        |
| **Postgres (read)**      | owning-node API/tool; a per-node read-only role is reserved for bounded break-glass access                                        | ❌ **not built**              | Replace the shared `app_readonly` role, which has BYPASSRLS access across every node DB. Normal support reads execute through the owning node; the operator only authenticates, authorizes, and routes. Tracked by `story.5052`.                                                                                                                                                                                                                                                                                                                                  | data support/repair plane         |
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

| Rung                                               | Health | Existing workflow                                                                                                                                                                                                                             | New workflow needed                                                                                         |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| RBAC `developer` grant (the gate)                  | 🟢     | `POST /api/v1/nodes/{id}/developers` + OpenFGA `node.developer`/`can_flight`                                                                                                                                                                  | — (gate fires; the node-scoped read behind it is what's missing)                                            |
| Grafana dev-read — **gate that can't leak**        | 🟢     | `GET /api/v1/nodes/{id}/observability/logs` is RBAC-gated, forces node/environment/service server-side, and returns no token                                                                                                                  | live conformance coverage across the fleet                                                                  |
| **`node` Loki stream label**                       | 🟢     | Stable node/environment/service selectors are emitted for app and declared-service lease streams                                                                                                                                              | retain as a log-envelope invariant                                                                          |
| Grafana node-pinned **proxy**                      | 🟢     | shipped; the operator runs LogQL with forced node/environment/service scope and returns only matching lines                                                                                                                                   | harden and monitor the existing route                                                                       |
| **`nodeId` on Langfuse traces** (the real blocker) | 🟡     | **wired on operator** (task.5053): shared `ObservabilityGraphExecutorDecorator` stamps `config.nodeId` onto trace tags + metadata; operator factory injects `container.nodeId`; warn-once if unwired                                          | node-template wires the same one line (non-breaking — `nodeId` optional); then the proxy below can filter   |
| Langfuse node-pinned **proxy**                     | 🟡     | **built** (task.5053): `GET /nodes/{id}/observability/traces` — `developer`-RBAC-gated, `LangfuseReaderPort`/`HttpLangfuseReader` pinned server-side to `tags=<nodeId>` via the operator-held key; dev holds nothing (mirrors the logs proxy) | live cand-a proof (exercise a graph → read the stamped trace through the proxy)                             |
| Postgres read isolation                            | 🔴     | per-node DB + `app_<node>` write roles exist; shared `app_readonly` still spans every node DB                                                                                                                                                 | `story.5052`: node-owned read/repair APIs, separate RBAC capabilities, audit, and bounded break-glass roles |
| PostHog per-node read                              | 🔴     | PostHog Cloud (one project today)                                                                                                                                                                                                             | project-per-node + admin grant via access-control API + dev self-mint / OAuth consent                       |
| Temporal per-node read                             | 🔴     | shared `cogni-<env>` namespace; per-node task queue                                                                                                                                                                                           | **per-node namespace** (substrate change) — tracked on the substrate dev, not here                          |

The log-read path is green; database support/repair, PostHog isolation, Temporal isolation, and fleet-wide
proof remain open. Real confidence needs weeks of green node spawns proving per-node isolation per env.

## Architecture — operator-mediated authorization, substrate-owned execution

For observability substrates, the operator is a **node-pinned query proxy**, NOT a credential issuer. For
node databases, the operator is an **authorization and routing plane**; the owning node executes the
query or repair. The reason is the
**reach** problem: a token handed to a dev — even behind a per-node OpenFGA check — carries its **own**
reach, which the check does not govern. The env's shared Grafana Viewer token reads _every_ node's logs, so
returning it to a dev granted on **one** node is a dormant env-wide leak. A server-side pinned read has no
such gap: the per-node check gates **who**, and the server pin gates **reach**. So:

- The node **declares** which observability substrates it emits to (`.cogni/node.yaml`).
- On a `developer` grant (the existing `POST /nodes/{id}/developers` tuple write), the operator gates the
  dev's observability read with the `node.flight` tuple and proxies Grafana/Loki with a server-forced
  `{node="<id>"}` selector. Database reads and repairs require separate capabilities and are forwarded to
  a node-owned API/tool; the operator does not connect to `cogni_<node>`.
- The dev **holds no env-wide credential**. For observability, the operator is an **MVP query proxy**, not
  a token issuer. For database support, it authorizes and routes to a node-owned API/tool. A
  `GrafanaTokenBroker`-style "mint and hand over" port and an operator-held fleet DB credential are both
  rejected shapes because their reach escapes the per-node check.

This is a new row in the [BaaS Substrate Map](./node-baas-architecture.md#baas-substrate-map):
**Observability Access** — _node declares which substrates it emits to; operator serves per-node-scoped
observability reads on `developer` grant, while database support actions execute through the owning node;
the dev holds no env-wide credential._

## Sequencing (Pareto)

1. **Gate that can't leak** — shipped in task.5025.
2. **Stable node/environment/service log labels** — shipped for app and declared-service lease streams.
3. **Grafana node-pinned proxy** — shipped; the operator runs LogQL with forced node/environment/service
   scope and the developer holds no Grafana credential.
4. **`nodeId` on Langfuse traces** (decorator tag + metadata) — the AI-trace substrate gap, twin of the
   `node` Loki label. **Nothing isolates without it.** Cheap: inject `getNodeId()` where the decorator
   already binds `billingAccountId`.
5. **Langfuse node-pinned proxy** — `GET /nodes/{id}/observability/traces`, the operator runs the dev's
   trace-list AND-ed with `nodeId=<id>` via its own key; dev holds nothing (the secret key reads the shared
   project = every node's traces, so it is never handed over — same reach correction as Grafana).
6. **Node-owned data support/repair plane** — tracked by `story.5052`. Add distinct read/repair
   capabilities, typed audited node APIs, and only then a per-node short-lived read-only role for
   break-glass diagnostics. Never use the shared `app_readonly` role as the product path.
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
