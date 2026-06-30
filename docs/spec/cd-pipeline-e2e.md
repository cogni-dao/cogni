---
id: spec.cd-pipeline-e2e
type: spec
title: CD Pipeline E2E — Multi-Node Argo CD GitOps (Architecture Reference)
status: deprecated
trust: draft
summary: Reference for the multi-node deployment runtime architecture — k3s + Compose two-runtime topology, selectorless-Service/EndpointSlice/NodePort networking, and Argo PreSync migration ordering. The branch model, promotion contract, and slot semantics live in the SSOT docs below.
read_when: Understanding the k3s+Compose runtime topology, Compose↔k3s networking, or migration ordering. For branch model / promotion / merge rules, read the SSOT docs first.
owner: cogni-dev
created: 2026-04-02
verified: 2026-04-20
initiative: proj.cicd-services-gitops
---

# CD Pipeline E2E: Multi-Node Argo CD GitOps

> **Source of truth.** This document is a **runtime-architecture reference** only. The live CI/CD contract — branch model, axioms, artifact identity, promotion, slot lease, merge authority — lives in three SSOT docs: [`ci-cd.md`](./ci-cd.md) (branch model + axioms + promotion), [`cicd-platform-boundary.md`](./cicd-platform-boundary.md) (where new platform work goes), and [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) (sovereignty + file ownership). Merge authority is [`development-lifecycle.md` §8](./development-lifecycle.md#8-request-merge--the-operator-is-the-merge-authority). Where this doc and the SSOT docs disagree, the SSOT docs win. The pipeline-flow / candidate-slot-lease / release-conveyor / gap-analysis sections of earlier revisions were stale and have been removed; what remains is the runtime topology that has no other home.

> End-to-end runtime architecture for operator + node apps via Argo CD on k3s,
> with Docker Compose infrastructure services on the same VM.

---

## 1. Architecture Overview

Single VM per environment. Two runtimes coexist:

| Runtime            | Manages                                                                    | Why                                                                      |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Docker Compose** | Infrastructure: Postgres, Temporal, LiteLLM, Redis, Caddy, Alloy, Autoheal | Stateful, rarely changes, no GitOps churn needed                         |
| **k3s + Argo CD**  | Applications: Operator, node apps, Scheduler-Worker, Sandbox-OpenClaw      | Frequent changes, benefits from declarative sync, self-healing, rollback |

```text
┌─────────────────────────────────────────────────────────────────┐
│  VM (Cherry Servers)                                            │
│                                                                 │
│  ┌─── Docker Compose ──────────────────────────────────┐        │
│  │  caddy (edge)  postgres  temporal  litellm  redis   │        │
│  │  alloy  autoheal  git-sync                          │        │
│  └─────────────────────────────────────────────────────┘        │
│           ↕ 127.0.0.1 (EndpointSlices)                          │
│  ┌─── k3s + Argo CD ──────────────────────────────────┐        │
│  │  operator  <nodes…>  scheduler-worker  openclaw     │        │
│  │  (Argo CD controller + repo-server + ksops)         │        │
│  └─────────────────────────────────────────────────────┘        │
│                                                                 │
│  Caddy :443 → k3s NodePort (operator + node apps)               │
└─────────────────────────────────────────────────────────────────┘
```

### Key Decision: Operator Runs on k3s

The operator app runs on k3s alongside the node apps. Uniformity is the point:

1. **Uniform deploy path** — all apps deploy the same way: image build → deploy-state update → Argo sync
2. **Uniform networking** — all apps are k3s Services, reachable by ClusterIP
3. **LiteLLM routing** — `COGNI_NODE_ENDPOINTS` can use k3s service DNS or NodePort routes consistently
4. **Self-healing** — Argo restarts crashed operator, not just nodes

The operator is both a formation factory and a running Cogni node with its own payments, billing, and database. It is the first node in the network. Running on k3s changes only the deploy mechanism, not the operator's responsibilities.

### Billing Topology

LiteLLM is the single LLM proxy. All nodes call LiteLLM for completions. LiteLLM routes billing callbacks back to each node's `/api/internal/billing/ingest`.

```text
Node (k3s pod) → LiteLLM (Compose, port 4000) → OpenRouter
                      ↓ (async callback)
                 CogniNodeRouter reads node_id from spend_logs_metadata
                      ↓
                 POST to node's billing endpoint via COGNI_NODE_ENDPOINTS
                      ↓
                 Node (k3s pod, via NodePort from Compose)
```

All traffic flows through localhost on the same VM. No cross-network routing.

---

## 2. Component Inventory

### 2.1 What Runs Where

| Component            | Runtime        | Image Source                           | Managed By                   | Changes Frequently? |
| -------------------- | -------------- | -------------------------------------- | ---------------------------- | ------------------- |
| **operator**         | k3s            | `nodes/operator/app/Dockerfile`        | Argo CD                      | Yes                 |
| **node apps**        | k3s            | `nodes/<node>/app/Dockerfile`          | Argo CD                      | Yes                 |
| **scheduler-worker** | k3s            | `services/scheduler-worker/Dockerfile` | Argo CD                      | Yes                 |
| **sandbox-openclaw** | k3s            | GHCR pre-built                         | Argo CD                      | Rarely              |
| **postgres**         | Compose        | `postgres:15`                          | `scripts/ci/deploy-infra.sh` | Never               |
| **temporal**         | Compose        | `temporalio/auto-setup`                | `scripts/ci/deploy-infra.sh` | Never               |
| **litellm**          | Compose        | `infra/images/litellm/Dockerfile`      | `scripts/ci/deploy-infra.sh` | Rarely              |
| **redis**            | Compose        | `redis:7-alpine`                       | `scripts/ci/deploy-infra.sh` | Never               |
| **caddy**            | Compose (edge) | `caddy:2`                              | `scripts/ci/deploy-infra.sh` | Rarely              |
| **alloy**            | Compose        | `grafana/alloy`                        | `scripts/ci/deploy-infra.sh` | Never               |

Node identity SSOT: `nodes/<name>/.cogni/repo-spec.yaml` (`node_id`). Deploy-shape SSOT: `infra/catalog/*.yaml` (ports, tag suffixes, branches). See [ci-cd.md](./ci-cd.md) Axiom 16 (`CATALOG_IS_SSOT`) + `REPO_SPEC_IS_IDENTITY_SSOT`.

---

## 3. Bootstrap Ordering (Fresh Environment)

When a fresh environment first comes up, Compose infra must be healthy before Argo syncs app pods, and databases must exist before app pods that need `DATABASE_URL` start.

| Gap                                                | Problem                                                              | Solution                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **DB must exist before Argo syncs apps**           | Argo will start pods that need DATABASE_URL pointing to existing DBs | Provision DBs before the first app sync of a fresh environment                |
| **LiteLLM must be healthy before app pods**        | App health depends on LiteLLM proxy                                  | Compose infra starts first; apps sync after foundational services are healthy |
| **Temporal must be ready before scheduler-worker** | Scheduler-worker fails if Temporal unreachable                       | Compose Temporal comes up before the scheduler-worker sync or readiness gate  |

Per-node substrate readiness (deploy branch, OpenBao secrets, ESO leaf, edge route, DB) for an _individual_ node added after provisioning is reconciled **inside the per-env flight/promote lane**, not via a full env reprovision — see [ci-cd.md](./ci-cd.md) Axiom 22 (`SUBSTRATE_IS_RECONCILED_BEFORE_PROMOTION`).

---

## 4. Networking

### 4.1 k3s → Compose (Apps Reaching Infrastructure)

Uses **selectorless Services plus EndpointSlices** pointing to `127.0.0.1`.

| k3s Service         | Target    | Compose Service | Port |
| ------------------- | --------- | --------------- | ---- |
| `postgres-external` | 127.0.0.1 | postgres        | 5432 |
| `temporal-external` | 127.0.0.1 | temporal        | 7233 |
| `litellm-external`  | 127.0.0.1 | litellm         | 4000 |
| `redis-external`    | 127.0.0.1 | redis           | 6379 |

### 4.2 Compose → k3s (LiteLLM Reaching Node Billing Endpoints)

LiteLLM runs on Compose and must POST billing callbacks to each node's `/api/internal/billing/ingest`.

| Option                    | How                                                                   | Complexity                  | Chosen? |
| ------------------------- | --------------------------------------------------------------------- | --------------------------- | ------- |
| **k3s NodePort**          | Each node app exposes a NodePort, LiteLLM hits `127.0.0.1:{nodePort}` | Low                         | **Yes** |
| **k3s HostPort**          | Pod spec includes `hostPort`, bypasses Service                        | Low but fragile             | No      |
| **Shared Docker network** | Connect k3s container network to Compose                              | Complex, breaks isolation   | No      |
| **kubectl port-forward**  | Forward pod ports to localhost                                        | Fragile, not for production | No      |

### 4.3 Caddy → k3s (External Traffic to Node Apps)

| Approach                                  | How                                                                   | Pros                          | Cons                           |
| ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------- | ------------------------------ |
| **Caddy → NodePort per app**              | Each app has a NodePort, Caddy routes by subdomain                    | Simple, no k8s ingress needed | NodePort allocation management |
| **Caddy → k3s Ingress**                   | Re-enable traefik or install nginx-ingress, Caddy forwards to ingress | Clean routing, standard k8s   | Extra component, double proxy  |
| **Caddy → single NodePort + Host header** | One ingress NodePort routes by Host                                   | Minimal NodePorts             | Requires ingress controller    |

**Recommended:** Caddy → NodePort per app for the current footprint. The Caddy roster is catalog-driven (`scripts/ci/render-caddyfile.sh`); a new `type: node` auto-routes — see [ci-cd.md](./ci-cd.md) Axiom 16.

### 4.4 NodePort Allocation

NodePorts are baked from each node's catalog `node_port`. Example allocation:

| App              | ClusterIP Port | NodePort | Purpose       |
| ---------------- | -------------- | -------- | ------------- |
| operator         | 3000           | 30000    | Main app      |
| (node app)       | 3000           | 30100…   | Node app      |
| scheduler-worker | 9000           | —        | Internal only |
| sandbox-openclaw | 18789          | —        | Internal only |

---

## 5. Database Migrations

### 5.1 Multi-Node Migration Strategy

All nodes share the same schema. Each node has its own database.

| Approach                          | How                                                                                 | Pros                   | Cons                         |
| --------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| **Argo PreSync Job per node**     | K8s Job runs migrator image with node-specific DATABASE_URL before Deployment syncs | GitOps-native, ordered | Need Job manifest per node   |
| **Single multi-DB migration Job** | One Job iterates `COGNI_NODE_DBS`, migrates each                                    | Simple, one manifest   | Failure on one DB blocks all |
| **Init container**                | App pod runs migrations on startup                                                  | No separate Job        | Races if multiple replicas   |
| **CI step**                       | Migrations run before Argo sync                                                     | Decoupled from Argo    | Breaks GitOps purity         |

**Recommended:** Argo PreSync Job per node.

### 5.2 Migration Ordering

```text
Argo Sync Wave:
  PreSync (wave -1): provision databases if needed
  PreSync (wave 0):  run migrations per node
  Sync (wave 1):     deploy app pods
  PostSync:          health verification
```

---

## 6. ApplicationSet Design

Each `(env, node)` pair has its own AppSet object — `infra/k8s/argocd/<env>-<node>-applicationset.yaml`, named `cogni-<env>-<node>`, rendered from the catalog by `scripts/ci/render-node-appset.sh`. Each AppSet uses `goTemplate: true` with `targetRevision: deploy/<env>-{{.name}}`. This is the lane-isolation primitive — see [ci-cd.md](./ci-cd.md) Axiom 18 (`LANE_ISOLATION` + `BRANCH_HEAD_IS_LEASE`) for why per-`(env, node)` objects (not a shared per-env AppSet) and how the per-node deploy branches map to Argo Applications.

The branch-per-`(env, node)` primitive mirrors [Kargo](https://kargo.akuity.io) Stage semantics, implemented on existing ApplicationSet + deploy-branch infrastructure without new CRDs, controllers, or long-running services.

---

## 7. Rollback

| Scenario             | Action                              | Effect                                                |
| -------------------- | ----------------------------------- | ----------------------------------------------------- |
| Bad app code         | `git revert` deploy-branch commit   | Argo syncs previous digest                            |
| Bad migration        | Manual intervention required        | Drizzle has no auto-rollback; write reverse migration |
| Bad config           | Update ConfigMap/Secret, Argo syncs | Pod restarts with new config                          |
| Full rollback        | Revert all overlay changes          | All apps return to previous version                   |
| Single node rollback | Revert only that node's overlay     | Only that node's pod restarts                         |

---

## Appendix: Glossary

| Term                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| **ApplicationSet**    | Argo CD resource that generates multiple Applications from a template + generator |
| **Candidate slot**    | Fixed pre-running environment used to validate unknown code before merge          |
| **Deploy branch**     | Machine-written branch containing environment state, not application code         |
| **Kustomize overlay** | Environment-specific patches applied on top of a shared base                      |
| **PreSync hook**      | Argo CD annotation that runs a resource before the main sync                      |
| **EndpointSlice**     | k8s resource that maps a Service to arbitrary IP:port endpoints                   |
| **NodePort**          | k8s Service type that exposes a port on every node IP                             |
| **digest ref**        | Immutable container image reference using `@sha256:...`                           |
