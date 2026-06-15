---
id: spec.secrets-classification
type: spec
title: Secrets Classification — Routing Tiers
status: draft
spec_state: proposed
trust: draft
summary: Defines the routing tiers (A1 / A2 / B / D / E / F / G) every secret in the catalog is classified into, plus the authority distinction between origin, custody, and consumers. The per-secret data lives in YAML — `nodes/<node>/.cogni/secrets-catalog.yaml` (node-domain) and `infra/secrets-catalog.yaml` (operator-domain) — loaded by `scripts/lib/secrets-catalog-loader.ts` with Zod validation.
read_when: Adding a new secret (decide its tier and custody); porting node-template substrate to cogni or cogni-poly; designing the Compose-infra OpenBao render path; auditing routing decisions.
owner: derekg1729
created: 2026-05-27
verified: 2026-05-27
tags:
  - secrets
  - classification
  - routing
  - catalog
---

# Secrets Classification — Routing Tiers

## Goal

Make every catalog entry unambiguous on two separate dimensions:

- **routing tier** — where the value is rendered (`pod`, `compose`, `ci`,
  repo, local, or derived);
- **authority** — where the value is owned (`openbao`, `github-env`,
  `repo-config`).

The important correction: routing to Compose does not make Compose the
authority. If a value is consumed by a pod, provisions a pod-facing role, or
must agree with a pod-facing value, OpenBao owns it and Compose receives a
rendered copy.

## Non-Goals

- Maintaining a second full inventory of every catalog secret in markdown. The
  per-secret data lives in YAML — `nodes/<node>/.cogni/secrets-catalog.yaml`
  (node-domain) and `infra/secrets-catalog.yaml` (operator-domain). This spec
  defines categories and contract boundaries; the YAML binds each secret to
  one current routing decision.
- Defining OpenBao install topology, ESO chart pinning, or rotation cadence — those live in [`secrets-management.md`](./secrets-management.md).
- Specifying GitHub-side secret naming conventions for CI-only secrets — [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) §Workflow Entrypoints owns that.

## Context

[`secrets-management.md`](./secrets-management.md) defines the OpenBao + ESO contract — the _shape_ of how secrets flow.
[`scripts/setup-secrets.ts`](../../scripts/setup-secrets.ts) is the historical bootstrap helper. It loads the catalog from YAML and can stage bootstrap/CI inputs, but it is not the runtime authority for OpenBao-backed values.
[`scripts/lib/secrets-catalog-loader.ts`](../../scripts/lib/secrets-catalog-loader.ts) is the **loader** — Zod-validates the YAML, asserts uniqueness, and emits the `Secret[]` + routing record the script consumes.
[`.claude/commands/env-update.md`](../../.claude/commands/env-update.md) §0.5 gives the routing rule at the four-row decision-table level.

This spec is the **rules** layer between them: the tier definitions, authority
rules, the decision flow for adding a new secret, and the naming conventions
for OpenBao paths / ExternalSecret manifests / k8s Secret targets. The
per-secret routing decisions live as inline `tier:` fields on each YAML entry;
custody is evaluated separately using `secrets-management.md`.

> **Authority split (intentional):**
> Rules + invariants → this file.
> Per-secret data → YAML catalogs (node-domain or operator-domain).
> No table of "all 60+ secrets" lives in markdown anywhere — it would rot.

`serverEnv()` schemas are runtime validation, not source-of-truth
classification. A value can be required by `serverEnv()` and still be plain
config. Classify by disclosure impact first: if leaking it requires rotation or
incident response, it is a secret; otherwise route it as config through GitOps
ConfigMaps or repo config.

## Invariants

1. **EVERY_SECRET_HAS_EXACTLY_ONE_TIER.** Each YAML catalog entry has a required `tier:` field. The loader's Zod schema rejects entries without it.
2. **NO_NAME_COLLISIONS.** The loader asserts no secret `name:` appears in two catalog files. Trying to declare the same secret in both `nodes/poly/.cogni/secrets-catalog.yaml` and `infra/secrets-catalog.yaml` crashes the loader with both file paths in the error.
3. **CO_CONSUMED_IS_AN_ANNOTATION_NOT_A_TIER.** When a secret is needed by both a k8s pod (A-tier) AND a Compose container (B-tier), `coConsumed: true` is a property on the routing entry, not a separate tier. Custody is evaluated independently. If either consumer is pod-facing, OpenBao owns the value and Compose renders a copy.
4. **A2_NAMING_IS_BARE_NODE.** A2 service names match `nodes/<node>/` directory names exactly — no `-node` suffix in catalog file, OpenBao path, or ExternalSecret directory. ([node-ci-cd-contract.md](./node-ci-cd-contract.md) §Domains is the anchor.)
5. **F_TIER_NEVER_ENTERS_THE_SCRIPT.** `.env.local`-only secrets MUST NOT appear in the catalog materializer or bootstrap staging helpers. They have no deployed runtime or CI custody.
6. **DERIVED_SECRETS_REGENERATE_ON_NODE_LIST_CHANGE.** G-tier values (`COGNI_NODE_DBS`, `COGNI_NODE_ENDPOINTS`) are functions of `nodes/*` listing — adding/removing a node requires re-running setup. This is a property of the substrate, not a manual step.

## Design

### Tier is routing, not authority

The `tier:` field decides the default routing surface. It does **not** decide
which system owns a value. Use the authority model in
[`secrets-management.md`](./secrets-management.md): `origin` says who can
produce the bytes, `custody` says which system is authoritative, and
`consumers` says where the value is rendered.

Hard rule: if a value is consumed by a pod, provisions a pod-facing role, or
must agree with a pod-facing value, custody is OpenBao. A B-tier Compose value
can therefore still be OpenBao-owned when Compose only renders a copy for role
creation or substrate provisioning. GitHub Environment Secrets are authorities
only for CI-only/bootstrap credentials or sealed staging for a workflow that
writes OpenBao.

### Tier definitions

| Tier                             | Routing                                                                                                          | When to use                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 — K8s app (baseline)**      | OpenBao `cogni/<env>/<service>/<KEY>` → ESO → k8s Secret → pod envFrom                                           | Consumed by code under `nodes/*/app/` or `services/<svc>/` in **every fork**. Default tier for application secrets.                                                                                                                                                         |
| **A2 — K8s app (node-specific)** | OpenBao `cogni/<env>/<service>/<KEY>` → ESO → k8s Secret → pod envFrom                                           | Same wire shape as A1; the distinguishing axis is that `<service>` matches a downstream-specific node directory (e.g., `nodes/poly/` for Polymarket). node-template baseline doesn't ship the consuming code; the path is reserved and the example below shows the pattern. |
| **B — Compose-infra**            | Authority-specific render: OpenBao read → VM `.env` / Bao Agent, or GitHub env only for CI/bootstrap-only values | Consumed by containers in `infra/compose/runtime/` (postgres, litellm, temporal, alloy, caddy, pdc-agent) that run outside k3s. If the value creates or agrees with pod-facing runtime material, custody is OpenBao.                                                        |
| **D — CI-only**                  | GitHub Actions secret → workflow `env:` block                                                                    | Used only by `.github/workflows/*.yml` — never written to a runtime container. Provisioning + deploy access only (e.g., SSH_DEPLOY_KEY, VM_HOST).                                                                                                                           |
| **E — Repo-level (cross-env)**   | Repo-scope GH secret/variable (not environment-scoped)                                                           | Shared across `candidate-a` / `preview` / `production`; one value per repo. Almost always CI consumption (`GHCR_DEPLOY_TOKEN`, `SONAR_TOKEN`, `CHERRY_AUTH_TOKEN`, etc.).                                                                                                   |
| **F — Local-only**               | `.env.local` (gitignored)                                                                                        | Pure dev convenience. Never enters CI or any deployed runtime. Not in `setup-secrets.ts` (no `gh secret set` call).                                                                                                                                                         |
| **G — Derived**                  | Auto-generated from repo state at provision time                                                                 | Output of walking `nodes/*/.cogni/repo-spec.yaml` or similar repo metadata. Re-runs of setup pick up new nodes automatically. Example: `COGNI_NODE_DBS`, `COGNI_NODE_ENDPOINTS`.                                                                                            |

### Node-wizard formation contract

For a normal wizard-created node, the per-node human-secret list is empty. The
wizard declares node shape in git; it does not ask for, store, or transmit
secret values. A node formation may depend on environment-level substrate that was
already provisioned for the target environment, and missing environment
substrate is repaired in the owning provisioning/secrets lane rather than
passed as candidate-flight input.

This section intentionally does **not** enumerate the current per-key
classification. The current v0 inventory lives in
[`infra/secrets-catalog.yaml`](../../infra/secrets-catalog.yaml) and any
node-domain `nodes/<node>/.cogni/secrets-catalog.yaml` files. That catalog is
the only current place to decide whether a named key is required, shared,
capability-gated, human-sourced, generated, or service-pinned. This spec
describes how to read those decisions and which architectural constraints they
must satisfy.

For PR #1582 v0, the node substrate lane is a transitional unblocker:

- it preserves existing OpenBao values for the target node;
- it generates or derives missing node-local material without human-entered
  per-node values;
- it may denormalize already-provisioned environment values that the catalog
  currently allows the node to consume;
- it still uses the environment's existing VM runtime bank for DB bridge inputs.

Do not infer the final architecture from that bridge. The follow-up
`secret-materialize <env> <node>` and shared-bank / owner-grant work must make
inheritance explicit, catalog-derived, and OpenBao-owned before this contract
is applied as a stricter vNext gate.

### A1 capability-gating + value-distinctness (`appliesTo` / `shared`)

Added by [`design.secrets-catalog-per-node`](../design/secrets-catalog-per-node.md) §Amendment v2 (task.5094). Nodes are heterogeneous — a Next.js app, a langgraph package, a dolt-memory store — so A1 is not "every fork gets all 36 baseline secrets." A1 baseline secrets live **once** in `infra/secrets-catalog.yaml` (operator-domain) and declare **two orthogonal fields** instead of a single `service:`:

- **`appliesTo: <capability>`** — which nodes receive it. The loader fans it to every `type:node` whose node-spec declares that capability. Capability classes: `all-nodes` (boot-floor), `web`, `database`, `llm`, `openclaw`, `payments`. A marker (not a `_node_baseline` pseudo-service) because it must express **subsets** — a langgraph+dolt node must not be fanned `OPENCLAW_GATEWAY_TOKEN` or a payment key.
- **`shared: true|false`** — value-distinctness, orthogonal to `appliesTo`:

| `shared`          | OpenBao path                | value                           | example                     |
| ----------------- | --------------------------- | ------------------------------- | --------------------------- |
| `false` (default) | `cogni/<env>/<node>/<KEY>`  | **distinct per node**           | node-local runtime material |
| `true`            | `cogni/<env>/_shared/<KEY>` | **same** for all in-scope nodes | shared environment material |

Path resolution lives in `openBaoPathFor()` in `scripts/lib/secrets-catalog-loader.ts`. `appliesTo` and `service:` are **mutually exclusive** (loader rejects both). `NO_NAME_COLLISIONS` (Invariant 2) is preserved — each name is declared once.

**Custody direction:** secrets that prove caller identity, sign transactions,
or unlock node-owned custody should not become ordinary shared baseline
material. The exact per-key capability and sharing flags are catalog decisions
and need human review before being promoted from v0 convention to CI-enforced
vNext gates.

### `authRole` — value-distinctness is NOT the security axis (target)

> The `shared:` flag and the `_shared` pseudo-service below are the **current**
> model; this section is a target direction that still needs human review and a
> separate implementation PR before it becomes a gate.

`shared:` welds **two orthogonal axes** into one flag, and the weld is a bug class:

- **Value-distinctness** (what `shared:` _means_): do all nodes get the same bytes? Harmless on its own.
- **Identity boundary** (what actually owns blast radius): is the token presented to a service as **proof of who is calling**, or does it merely **unlock a resource** the caller could already reach?

A shared value is fine for the second axis (one upstream account) but a
**lateral-movement multiplier** for the first. The target model adds one
dimension and one CI gate:

```
authRole: caller-identity   # token IS the caller's identity to an internal service  → shared: true FORBIDDEN (CI gate)
authRole: resource-unlock   # token only unlocks a shared upstream resource           → shared: true ALLOWED
```

- **caller-identity**: values presented as proof of which node or internal
  service is calling. Target direction: replace shared caller identity with a
  per-node identity mechanism.
- **resource-unlock**: values that unlock a shared upstream resource while
  caller identity is established elsewhere. Target direction: prefer proxy
  injection or scoped sub-keys where the upstream supports it.

### Owner-scoped paths, not a `_shared` bucket

`_shared` has **no owner** — no service mints/rotates it. The target: every secret lives at **`cogni/<env>/<owner>/<KEY>`** where the owner is the service that mints + rotates it (`litellm/`, `scheduler-worker`, `grafana`); the materializer generates or carries the value once; consumers receive an **explicit OpenBao read grant** on that path (policy templating). "Shared" becomes a **derived property** (N consumers granted read), not a storage location. This replaces today's over-broad dual-extract (every node reads **all** of `_shared/*`) with least-privilege per-path grants + a single rotation owner + scoped revocation.

`NEXT_PUBLIC_*` (e.g. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) ships to the browser — it is **public config, not a secret**. Keep it (per-node is fine); route it as config rather than guarding it in the secret substrate as if it were sensitive.

### Migration tracker (task.5094, 2026-05-31)

**What actually carries migration cost.** Only human/vendor values in live
`preview` + `production` need preservation. GitHub Environment Secrets may
currently hold some of those bytes as bootstrap/staging artifacts, but they are
not the target runtime authority. Everything agent-generated in candidate
environments is disposable: the materializer can regenerate missing values into
OpenBao. A human only supplies a new value when we deliberately split a shared
upstream into per-node accounts (Phase 4/6, opt-in).

**Origin split of the live envs** (historically visible through GH-env inventory):

| Class                                                  | Migration cost                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| Agent-generated                                        | none — regenerate on provision                                      |
| Human/vendor or externally issued environment material | preserve bytes while moving custody to OpenBao where runtime-facing |

**Phases** (ranked risk-reduction-per-effort; MVP-gated):

| Phase | Work                                                                                          | Human touch            |
| ----- | --------------------------------------------------------------------------------------------- | ---------------------- |
| 1     | `authRole` field + Zod loader + CI gate forbidding `shared`/`_shared` on caller-identity      | no                     |
| 2     | Purge `_shared/` → owner paths + per-consumer read grants (provision generates-once)          | no                     |
| 3a    | Replace shared upstream master tokens with per-node virtual keys where supported              | no                     |
| 3b    | Replace shared internal caller tokens with per-node identity or projected-ServiceAccount JWTs | no                     |
| 4/6   | Per-node external sub-keys for true per-node attribution where vendors support them           | yes — opt-in, deferred |
| H     | Orphan cleanup — **DONE 2026-05-31** (below)                                                  | —                      |

**Phase H (done).** 8 purged-prototype secrets — `POLY_PROTO_PRIVY_{APP_ID,APP_SECRET,SIGNING_KEY}`, `POLY_PROTO_WALLET_ADDRESS`, `POLY_CLOB_{API_KEY,API_SECRET,PASSPHRASE}`, `COPY_TRADE_TARGET_WALLETS` — deleted from the `candidate-a`, `preview`, and `production` GitHub environments. Confirmed no runtime consumer (`.env.local.example`, [`poly-tenant-and-collateral.md`](./poly-tenant-and-collateral.md), and `work/handoffs/task.0318.phase-{a,b3}` all mark them orphaned post-Stage-4). Removed a stale Privy _signing_ key from production.

### Co-consumed annotation (NOT a separate tier)

When the same value is required by both a k8s app (A-tier) AND a Compose-infra
container (B-tier), the catalog may flag it with `coConsumed: true` on its
routing entry. This is an **annotation, not a tier**.

The target flow is single-custody:

1. `secret-materialize <env> <service>` writes or verifies the OpenBao value.
2. ESO renders the pod copy from OpenBao.
3. The deploy/provision lane renders the Compose copy from the same OpenBao
   value, or a future Bao Agent renders it directly on the host.

The VM `.env` file is a rendered view. It is never allowed to be the source
that later overwrites OpenBao or pod-facing DB roles.

## DATABASE_URL / DATABASE_SERVICE_URL — derived, not catalog

`DATABASE_URL`, `DATABASE_SERVICE_URL`, and `DOLTGRES_URL` are rendered values.
The static bridge stores both the OpenBao-owned credential components and the
rendered DSNs at `cogni/<env>/<node>` so current pod schemas can continue to
read DSNs while provisioners can create roles from the same components.

Longer term, app code should reconstruct DSNs from components or move to
dynamic DB credentials. Components remain the canonical form because:

- Components are the canonical form in OpenBao (one row per concept).
- App-side reconstruction is one line of code.
- Rotating just the password (the common case) doesn't force a DSN re-mint.
- If a future port introduces pgbouncer or a connection-pool sidecar, the DSN host/port may differ between sources — keeping components avoids that lock-in.

No GH-env DSN entry is allowed to be the runtime authority.

## A2 — node-specific naming (aligned to single-node-scope)

Aligned to [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) §Domains (the four canonical domains today are `poly`, `resy`, `node-template`, `operator`):

- Node directory: `nodes/<node>/` — bare name, no `-node` suffix.
- Catalog file: `nodes/<node>/.cogni/secrets-catalog.yaml` (per-node, node-domain). Loader auto-fills `service: <node>` from the parent directory.
- OpenBao service path: `cogni/<env>/<node>` — `<service>` IS the bare node name for node-domain services.
- ExternalSecret manifest dir: `nodes/<node>/k8s/external-secrets/<env>/` (per-node, node-domain) — the single repo-wide convention. Leaves are applied directly (provision Phase 6 globs `nodes/*/k8s/external-secrets/<env>/`; preview/prod overlays pull the leaf via `resources:`). No per-env aggregator — only the cluster-scoped `ClusterSecretStore` lives under `infra/k8s/secrets/external-secrets/`.
- k8s Secret target name: `<node>-env-secrets` (per Invariant 2 of secrets-management.md).
- Pod envFrom: `secretRef: name: <node>-env-secrets`.

If any of those four artifacts (catalog → ExternalSecret manifest → k8s Secret name → pod envFrom) disagrees, the secret has been introduced incorrectly.

**Status in node-template:** the path namespace is reserved. Current A2
placeholder entries live in `infra/secrets-catalog.yaml`; when a downstream
node owns those secrets in its own tree, move them to that node-domain catalog
instead of duplicating the inventory in markdown.

**Renaming on port — cogni / cogni-poly current state (read before task.5052 / task.5053).** Today cogni and cogni-poly create k8s Secrets imperatively (`kubectl create secret`) with the name `<node>-node-app-secrets` (e.g., `poly-node-app-secrets`), set via a kustomize overlay patch on `infra/k8s/base/node-app/deployment.yaml` (base name `node-app-secrets`, overlay-rebranded per node). Reference: cogni-monorepo `docs/guides/node-formation-guide.md` §"Create k8s secrets" + `infra/k8s/overlays/canary/poly/kustomization.yaml`. On ESO port, the manifest naming changes from `<node>-node-app-secrets` (imperative) to `<node>-env-secrets` (ESO-managed). Migration path:

1. Author ExternalSecret reconciling the NEW name `<node>-env-secrets`.
2. Update the overlay's secret-name patch to point at the new name.
3. Once pods are rolled with the new envFrom (Reloader or manual `kubectl rollout restart`), delete the legacy imperative Secret.
4. Update `node-formation-guide.md` to drop the "Create k8s secrets" manual step — ESO does it now.

This is the only material naming change the port imposes. The catalog file, node directory, and OpenBao path stay as bare `<node>`.

## Per-service OpenBao path summary (A-tier and G-tier only)

| OpenBao path                   | Tier   | Consumer                                                     | Status in node-template                                                                                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cogni/<env>/node-template`    | A1     | `nodes/node-template/app/` Deployment                        | ✅ ExternalSecret + catalog present                                                                                                         |
| `cogni/<env>/scheduler-worker` | A1     | `services/scheduler-worker/` Deployment                      | ✅ ExternalSecret + catalog present                                                                                                         |
| `cogni/<env>/_shared`          | A1 / G | Multiple services that opt in                                | ⚠️ Transitional shared-bank pattern; owner-grant replacement belongs in vNext                                                               |
| `cogni/<env>/poly`             | A2     | `nodes/poly/app/` (cogni-poly only)                          | 🔜 Reserved; lands with `task.5053` cogni-poly port. Catalog: `infra/catalog/poly.yaml::name=poly` (already present in cogni / cogni-poly). |
| `cogni/<env>/_system`          | G      | `provision-env-vm.sh` / `deploy-infra.sh` (deploy-time only) | ⚠️ Pattern documented; OIDC federation for CI writers not yet wired                                                                         |

## Adding a new secret — decision flow

1. **Pick a tier** from the table at top, then pick custody from
   `secrets-management.md`.
   - Consumed by k8s pod code? → A1 (if baseline) or A2 (if node-specific).
   - Consumed by a Compose container? → B (and add `coConsumed: true` if also k8s).
   - Used only by `.github/workflows/`? → D / E.
   - Used only locally? → F (don't add to `setup-secrets.ts`).
   - Auto-derived from repo state? → G.
2. **If A-tier:** confirm the OpenBao service path matches `infra/catalog/<service>.yaml::name`. If a new service, add the catalog entry + ExternalSecret first.
3. **Add the entry to the right YAML catalog:**
   - Node-specific (A1 consumed by the node, or A2) → `nodes/<node>/.cogni/secrets-catalog.yaml`. Single PR scoped to that node domain.
   - Cross-cutting (`_shared`, `_system`, or any B/D/E/G entry) → `infra/secrets-catalog.yaml`. Operator-domain PR.
   - The loader's Zod schema enforces required fields at module load. Missing `tier`, malformed `service`, or name collision = the script fails loudly on next invocation.
4. **Follow [`.claude/commands/env-update.md`](../../.claude/commands/env-update.md)** for the file-by-file propagation across server-env.ts, .env.local.example, ci.yaml, docker-compose.yml, deploy-infra.sh, etc.

## Compose-infra render path

The B-tier rows exist because Compose-infra containers have no Kubernetes
ServiceAccount and cannot use the k8s auth method that ESO + pods use. For
OpenBao-custodied B-tier values, deploy-time rendering is an implementation
detail, not a second authority. Three vendor-supported render paths:

| Option                                     | Mechanism                                                                                                       | Tradeoff                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Kubernetes reader at deploy**            | `deploy-infra.sh` runs on the VM, mints a reader token with a ServiceAccount JWT, reads OpenBao, writes `.env`. | Current preferred bridge; no OpenBao ingress and no root token.                             |
| **AppRole at deploy**                      | `deploy-infra.sh` does `bao login -method=approle` on the VM, walks OpenBao paths, writes `.env`.               | Useful if a future host lacks k3s auth; avoid long-lived secret IDs.                        |
| **GHA OIDC → dynamic secret-id → AppRole** | Deploy job uses GH OIDC token to mint a one-shot secret-id from OpenBao; uses it immediately.                   | No long-lived secret-id anywhere. Same rotation latency. Cleanest end state.                |
| **Bao Agent sidecar in compose.yml**       | Templates secrets into shared tmpfs; containers read from file.                                                 | Sub-minute rotation. Requires container restart hook for picking up changes. Adds a daemon. |

Bao Agent is the long-term host-rendering shape if sub-minute rotation becomes
a requirement. Until then, the Kubernetes reader role is the simplest bridge
because the deploy host already runs k3s.

## Open follow-ups

- `setup-secrets.ts` still exists as historical bootstrap/staging tooling. Do
  not extend it as runtime authority; new runtime materialization belongs in
  `secret-materialize`.
- Human review is needed before vNext hardens the current catalog flags into
  stricter capability, sharing, and readiness gates. Until then, avoid adding
  parallel per-key classifications in docs.

## Related

- [Secrets Management](./secrets-management.md) — the OpenBao + ESO contract
- [Node CI/CD Contract](./node-ci-cd-contract.md) — single-node-scope domains; A2 service naming is anchored here
- [Access Control Charter](./access-control-charter.md) — L3 layer and dependencies
- [`scripts/setup-secrets.ts`](../../scripts/setup-secrets.ts) — historical bootstrap/staging helper that consumes the loader output
- [`scripts/lib/secrets-catalog-loader.ts`](../../scripts/lib/secrets-catalog-loader.ts) — Zod-validated YAML loader (the per-secret data this spec delegates to)
- [`nodes/node-template/.cogni/secrets-catalog.yaml`](../../nodes/node-template/.cogni/secrets-catalog.yaml) — node-template's per-node catalog (example for new nodes)
- [`infra/secrets-catalog.yaml`](../../infra/secrets-catalog.yaml) — operator-domain catalog (`_shared`, `_system`, B/D/E/G, A2 placeholders)
- [`docs/design/secrets-catalog-per-node.md`](../design/secrets-catalog-per-node.md) — rationale for the YAML-per-node layout
- [`scripts/setup/SETUP_DESIGN.md`](../../scripts/setup/SETUP_DESIGN.md) — design-doc companion to the script (descriptive, not authoritative for routing)
- [`.claude/commands/env-update.md`](../../.claude/commands/env-update.md) — file-by-file propagation checklist
- [`task.5052`](https://cognidao.org/work/items/task.5052) — cogni port (consumes this catalog)
- [`task.5053`](https://cognidao.org/work/items/task.5053) — cogni-poly port (consumes this catalog + A2 rows)
- [`task.5062`](https://cognidao.org/work/items/task.5062) — live-VM E2E runbook
- [`task.5063`](https://cognidao.org/work/items/task.5063) — this spec + charter
- [`task.5071`](https://cognidao.org/work/items/task.5071) — the per-node catalog refactor
