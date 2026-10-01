---
id: node-launch-spec
type: spec
title: Node Launch — Zero-Touch Provisioning
status: draft
spec_state: draft
trust: draft
summary: Zero-touch node provisioning. Founder clicks "Launch Node" on operator site, async workflow provisions shared-cluster namespace + repo + config, node is live. Provider-agnostic (Cherry k3s today, Akash SDL tomorrow).
read_when: Working on node provisioning automation, multi-tenant k8s, the provisionNode workflow, or Akash migration.
implements:
owner: derekg1729
created: 2026-03-26
verified:
tags: [infra, multi-tenant, akash, node-formation]
---

# Node Launch — Zero-Touch Provisioning

> **⚠️ COMPUTE SECTIONS SUPERSEDED.** This spec's namespace-per-node-on-shared-k3s shape (`NAMESPACE_ISOLATION`, `ClusterProvider`/`CherryK3sProvider`/`AkashSdlProvider`) predates the shipped design: node workloads run on **Akash via `ComputeResourcePort` → `AkashComputeAdapter`** (task.5044; [ci-cd.md](./ci-cd.md) Axiom 23 (`AKASH_IS_NODE_APP_TARGET`, gated on story.5016)). Read [cicd-platform-boundary.md](./cicd-platform-boundary.md) for the live port contract; the non-compute sections (identity, DAO, payments) still apply.

## Context

Today, launching a Cogni node after DAO formation requires 7+ manual steps: SSH keygen, OpenTofu apply, DNS records, GitHub secrets, repo fork, payment activation, and a git push. Each step is individually automatable but no orchestration exists to chain them.

The operator repo provisions one VM per environment (Cherry Servers + k3s + ArgoCD). All deploy automation assumes a single tenant.

**Current manual steps (post-DAO-formation):**

1. Copy repo-spec YAML into fork
2. SSH keygen + upload keys
3. `tofu apply` to provision VM
4. DNS A record in Namecheap UI
5. `pnpm setup:secrets` (interactive, ~30 secrets)
6. Payment activation CLI
7. Push to staging

**Target:** Founder clicks "Launch Node" -> node is live. Zero human steps on the happy path.

## Goal

Reduce the node launch lifecycle to a single user action (button click after DAO formation) backed by an async provisioning workflow. Nodes deploy onto shared infrastructure as isolated namespaces, not dedicated VMs.

## Non-Goals

| Item                                 | Reason                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| Dedicated VM per node                | Shared cluster is cheaper, faster, and Akash-forward               |
| Custom domain on day 1               | Wildcard subdomain sufficient; custom domain is P2                 |
| Multi-cluster federation             | Single cluster until load demands it                               |
| Akash migration in this spec         | Architecture must be Akash-ready, but Cherry is the first provider |
| Operator extraction to separate repo | Monorepo phase; extract when justified                             |

## Core Invariants

1. **ZERO_TOUCH_HAPPY_PATH**: After DAO formation (2 wallet txs), no manual steps before the node is live. The provisionNode workflow handles everything.

2. **SHARED_INFRA_FIRST**: Nodes share cluster, ingress, DB server, Temporal, and LiteLLM. Only fan out to dedicated infra when a tenant justifies it (load, compliance, geography).

3. **NAMESPACE_ISOLATION**: Each node gets its own k8s namespace (`node-{short-id}`), its own database, its own generated secrets. No cross-namespace access.

4. **PROVIDER_AGNOSTIC**: The provisioning workflow calls a `ClusterProvider` interface, not Cherry/Akash directly. Provider swap is an adapter change, not a redesign.

5. **GITOPS_IS_SINK**: ArgoCD reflects desired state; it does not decide when a node should exist. The provisionNode workflow writes manifests; ArgoCD applies them.

6. **WILDCARD_DNS**: One DNS record (`*.nodes.cognidao.org` -> cluster ingress IP) serves all nodes. No per-node DNS changes.

7. **NODE_SOVEREIGNTY_PRESERVED**: The node's repo-spec is authoritative. The operator provisions infrastructure but never overrides node policy. Fork freedom is maintained — a node can always leave shared infra and self-host.

8. **SECRETS_ARE_GENERATED**: Node-specific secrets (AUTH_SECRET, LITELLM_MASTER_KEY, DB password) are derived deterministically from `node_id` + cluster secret, or generated via crypto.randomBytes. No human-provided secrets on the happy path.

## Schema

**Provisioning Input (from DAO formation):**

- `node_id` (UUID) — from formation verify endpoint
- `scope_id` (UUID) — derived from node_id
- `dao_contract` (address) — from formation
- `chain_id` (string) — from formation
- `founder_address` (address) — initialHolder from formation
- `repo_template` (string) — GitHub template repo (default: `Cogni-DAO/cogni`)

**Provisioning Output (written to node record + repo-spec):**

- `namespace` — `node-{short-id}` (first 8 chars of node_id)
- `domain` — `{slug}.nodes.cognidao.org`
- `database_name` — `cogni_{short_id}`
- `operator_wallet_address` — Privy-provisioned
- `split_address` — deployed Split contract
- `payments.status` — `active`

## Design

### The provisionNode Workflow

A single Temporal workflow that chains all provisioning steps. Each activity is idempotent — the workflow can be retried at any point.

```
provisionNode(input: ProvisionInput)
  |
  |-- 1. createNodeRecord(node_id, founder, dao)
  |     Write to operator_node_registrations table.
  |     Status: provisioning.
  |
  |-- 2. createRepoFromTemplate(node_id, slug)
  |     GitHub API: create repo from template in Cogni-DAO org.
  |     Commit .cogni/repo-spec.yaml with all formation data.
  |
  |-- 3. generateNodeSecrets(node_id)
  |     Derive or generate: AUTH_SECRET, LITELLM_MASTER_KEY,
  |     DB credentials, identity signing and encryption keys.
  |     Store in cluster Secret (namespace-scoped).
  |
  |-- 4. provisionDatabase(short_id)
  |     CREATE DATABASE cogni_{short_id} on shared Postgres.
  |     CREATE USER with generated credentials.
  |     Run migrations.
  |
  |-- 5. materializeOverlay(node_id, namespace, config)
  |     Write infra/cd/nodes/{short_id}/kustomization.yaml
  |     pointing at shared base with node-specific patches
  |     (namespace, env, secrets ref, ingress host).
  |     Commit + push to staging branch.
  |     ArgoCD auto-syncs via ApplicationSet git-directory generator.
  |
  |-- 6. activatePayments(node_id)
  |     Privy API: provision operator wallet.
  |     Deploy Split contract (operator wallet + DAO treasury).
  |     Update repo-spec in node's repo.
  |
  |-- 7. waitForHealth(domain)
  |     Poll https://{slug}.nodes.cognidao.org/readyz
  |     Timeout: 10 min. Retry with backoff.
  |
  |-- 8. markNodeReady(node_id)
  |     Update operator_node_registrations status: active.
  |     Notify founder (webhook / UI poll).
```

### Shared Infrastructure Model

```
┌─────────────────────────────────────────────────────┐
│ Shared k3s Cluster (1 VM today, N Akash pods later) │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │ node-abc123 │  │ node-def456 │  │ node-ghi789│  │
│  │ namespace   │  │ namespace   │  │ namespace  │  │
│  │ - app pod   │  │ - app pod   │  │ - app pod  │  │
│  │ - worker pod│  │ - worker pod│  │ - worker   │  │
│  │ - secrets   │  │ - secrets   │  │ - secrets  │  │
│  └─────────────┘  └─────────────┘  └────────────┘  │
│                                                     │
│  ┌───────────── Shared Services ──────────────────┐ │
│  │ Postgres (shared server, per-node databases)   │ │
│  │ Temporal (shared server, per-node namespaces)  │ │
│  │ LiteLLM (shared proxy, per-node API keys)      │ │
│  │ Caddy/Ingress (wildcard TLS)                   │ │
│  │ ArgoCD (manages all node namespaces)           │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Per-node resources (isolated):**

- k8s namespace
- Postgres database (same server, different DB)
- k8s Secret (generated credentials)
- App + worker pods
- Ingress rule (`{slug}.nodes.cognidao.org`)

**Shared resources (cluster-level):**

- Postgres server
- Temporal server
- LiteLLM proxy
- Caddy / Ingress controller
- ArgoCD
- GHCR pull secrets
- Wildcard TLS cert

### Provider Interface

```typescript
interface ClusterProvider {
  /** Ensure cluster exists and return connection info */
  ensureCluster(env: string): Promise<ClusterConnection>;

  /** Create namespace with resource quotas */
  createNamespace(conn: ClusterConnection, name: string): Promise<void>;

  /** Apply kustomize overlay */
  applyManifests(conn: ClusterConnection, path: string): Promise<void>;

  /** Create namespace-scoped secret */
  createSecret(
    conn: ClusterConnection,
    ns: string,
    data: Record<string, string>
  ): Promise<void>;
}
```

**Adapters:**

- `CherryK3sProvider` — today. kubectl via SSH or kubeconfig. ArgoCD handles manifest application (provider just ensures cluster exists).
- `AkashSdlProvider` — future. Translates kustomize output to Akash SDL, deploys via Akash CLI/API. Same workflow, different provider.

### Why This Maps to Akash

Akash deployments are **groups of containers with shared networking** — conceptually identical to a k8s namespace with pods. The translation:

| k3s Concept | Akash Equivalent               |
| ----------- | ------------------------------ |
| Namespace   | Deployment (SDL group)         |
| Pod         | Service (SDL service)          |
| Ingress     | Expose directive               |
| Secret      | Environment variables (sealed) |
| PVC         | Persistent storage directive   |
| Cluster     | Akash provider marketplace     |

The `ClusterProvider` interface abstracts this. When Akash is ready:

1. `AkashSdlProvider.createNamespace()` → create SDL deployment
2. `AkashSdlProvider.applyManifests()` → update SDL
3. Shared services either run on a dedicated Akash deployment or are managed externally (Neon Postgres, Temporal Cloud)

The key architectural bet: **per-node isolation at the namespace/deployment level, shared heavy services.** This works on both k3s and Akash.

### ArgoCD ApplicationSet (Git Directory Generator)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: nodes
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/Cogni-DAO/cogni.git
        revision: staging
        directories:
          - path: infra/cd/nodes/*
  template:
    metadata:
      name: "node-{{path.basename}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/Cogni-DAO/cogni.git
        targetRevision: staging
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "node-{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

Adding a node = commit a directory to `infra/cd/nodes/{short-id}/`. ArgoCD discovers it automatically.

### Per-Node Overlay Structure

```
infra/cd/nodes/{short-id}/
  kustomization.yaml    # namespace, image, env patches
```

Each overlay references the shared base (`../../base/node-app/`) and patches:

- Namespace
- Ingress hostname
- ConfigMap (node_id, scope_id, domain)
- SecretRef (points to namespace-scoped k8s Secret)
- Image tag (latest stable digest)

### repo-spec Additions (v0.2.0)

```yaml
# New fields
infra:
  provider: shared-cluster # shared-cluster | self-hosted | akash
  domain: mynode.nodes.cognidao.org
  namespace: node-abc12345
  cluster: preview # which shared cluster
```

Minimal addition. The app reads `infra.domain` to know its own URL. Everything else is cluster-internal config.

### Secret Strategy

| Secret             | Scope         | Generation                       |
| ------------------ | ------------- | -------------------------------- |
| AUTH_SECRET        | Per-node      | `crypto.randomBytes(32)`         |
| LITELLM_MASTER_KEY | Per-node      | `sk-` + `crypto.randomBytes(24)` |
| DB password        | Per-node      | `crypto.randomBytes(24)`         |
| GHCR pull token    | Cluster-level | Shared                           |
| SOPS age key       | Cluster-level | Shared                           |
| Caddy TLS          | Cluster-level | ACME wildcard                    |
| Postgres root      | Cluster-level | Shared                           |
| Temporal           | Cluster-level | Shared                           |

**Key insight:** Only 4 secrets are per-node, and all are auto-generated. Zero human input required.

## Acceptance Checks

1. `provisionNode` workflow completes end-to-end in <15 minutes
2. Node is accessible at `{slug}.nodes.cognidao.org` after workflow completes
3. `/readyz` returns 200 with valid health data
4. Node's repo contains correct repo-spec with `payments.status: active`
5. ArgoCD shows node application as Synced + Healthy
6. Workflow is idempotent — re-running skips completed steps
7. No manual steps between DAO formation button click and node-live

## Open Questions

1. **Slug format**: UUID prefix (`abc12345`) or user-chosen name (`my-cool-dao`)? User-chosen is nicer but requires uniqueness validation.
2. **Shared Postgres capacity**: At what node count do we need to move to managed Postgres (Neon)?
3. **Akash shared services**: When migrating to Akash, do shared services (Postgres, Temporal) move to managed cloud or run as a separate Akash deployment?
4. **Node teardown**: What happens when a node is deactivated? Namespace delete + DB archive? TTL?

## Dependencies

- task.0149 (k3s + ArgoCD GitOps) — must be merged first
- task.0188 (per-namespace environments) — provides the namespace isolation pattern
- Wildcard DNS setup (one-time, Cloudflare migration)
- ArgoCD ApplicationSet with git-directory generator

## Related

- [Node Formation Spec](./node-formation.md) — DAO formation wizard (precedes this)
- [Node vs Operator Contract](./node-operator-contract.md) — sovereignty invariants
- [Node CI/CD Contract](./node-ci-cd-contract.md) — CI sovereignty
- [Node Formation Project](../../work/projects/proj.node-formation-ui.md)
- [GitOps Project](../../work/projects/proj.cicd-services-gitops.md)
