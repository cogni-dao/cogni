---
id: spec.secrets-classification
type: spec
title: Secrets Classification — Routing Tiers
status: draft
spec_state: proposed
trust: draft
summary: Defines the routing tiers (A1 / A2 / B / D / E / F / G) every secret in the catalog is classified into, plus the naming conventions for OpenBao paths, ExternalSecret manifests, and k8s Secret targets. The per-secret data lives in YAML — `nodes/<node>/.cogni/secrets-catalog.yaml` (node-domain) and `infra/secrets-catalog.yaml` (operator-domain) — loaded by `scripts/lib/secrets-catalog-loader.ts` with Zod validation. This spec defines the categories and the rules; the loader binds each secret to one routing decision.
read_when: Adding a new secret (decide its tier); porting node-template substrate to cogni or cogni-poly; designing the Compose-infra→OpenBao migration; auditing routing decisions.
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

Make every secret in the catalog route to exactly one substrate (OpenBao path, GitHub env, CI workflow, repo-level, local-only, or derived) without ambiguity, so downstream ports (task.5052 cogni, task.5053 cogni-poly) and Compose→OpenBao migration have a single authoritative routing decision per secret.

## Non-Goals

- Listing every secret in markdown. The per-secret data lives in YAML — `nodes/<node>/.cogni/secrets-catalog.yaml` (node-domain) and `infra/secrets-catalog.yaml` (operator-domain). This spec defines the categories; the YAML binds each secret to one.
- Defining OpenBao install topology, ESO chart pinning, or rotation cadence — those live in [`secrets-management.md`](./secrets-management.md).
- Specifying GitHub-side secret naming conventions for CI-only secrets — [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) §Workflow Entrypoints owns that.

## Context

[`secrets-management.md`](./secrets-management.md) defines the OpenBao + ESO contract — the _shape_ of how secrets flow.
[`scripts/setup-secrets.ts`](../../scripts/setup-secrets.ts) is the **runtime tool** — it loads the catalog from YAML, walks GH env, prompts for human values, generates agent values, and writes them to GitHub + `.env.<env>`.
[`scripts/lib/secrets-catalog-loader.ts`](../../scripts/lib/secrets-catalog-loader.ts) is the **loader** — Zod-validates the YAML, asserts uniqueness, and emits the `Secret[]` + routing record the script consumes.
[`.claude/commands/env-update.md`](../../.claude/commands/env-update.md) §0.5 gives the routing rule at the four-row decision-table level.

This spec is the **rules** layer between them: the tier definitions, the decision flow for adding a new secret, and the naming conventions for OpenBao paths / ExternalSecret manifests / k8s Secret targets. The per-secret routing decisions live as inline `tier:` fields on each YAML entry — the loader's load-time validation guarantees every catalog entry has exactly one routing decision.

> **Source-of-truth split (intentional):**
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
3. **CO_CONSUMED_IS_AN_ANNOTATION_NOT_A_TIER.** When a secret is needed by both a k8s pod (A-tier) AND a Compose container (B-tier), its primary tier remains whichever determines origination; `coConsumed: true` is a property on the routing entry, not a separate tier. Prevents tier proliferation.
4. **A2_NAMING_IS_BARE_NODE.** A2 service names match `nodes/<node>/` directory names exactly — no `-node` suffix in catalog file, OpenBao path, or ExternalSecret directory. ([node-ci-cd-contract.md](./node-ci-cd-contract.md) §Domains is the anchor.)
5. **F_TIER_NEVER_ENTERS_THE_SCRIPT.** `.env.local`-only secrets MUST NOT appear in `setup-secrets.ts` SECRETS — they have no `gh secret set` call site. If you find an F-tier entry in the script, that's a bug.
6. **DERIVED_SECRETS_REGENERATE_ON_NODE_LIST_CHANGE.** G-tier values (`COGNI_NODE_DBS`, `COGNI_NODE_ENDPOINTS`) are functions of `nodes/*` listing — adding/removing a node requires re-running setup. This is a property of the substrate, not a manual step.

## Design

### Tier definitions

| Tier                             | Routing                                                                                    | When to use                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 — K8s app (baseline)**      | OpenBao `cogni/<env>/<service>/<KEY>` → ESO → k8s Secret → pod envFrom                     | Consumed by code under `nodes/*/app/` or `services/<svc>/` in **every fork**. Default tier for application secrets.                                                                                                                                                         |
| **A2 — K8s app (node-specific)** | OpenBao `cogni/<env>/<service>/<KEY>` → ESO → k8s Secret → pod envFrom                     | Same wire shape as A1; the distinguishing axis is that `<service>` matches a downstream-specific node directory (e.g., `nodes/poly/` for Polymarket). node-template baseline doesn't ship the consuming code; the path is reserved and the example below shows the pattern. |
| **B — Compose-infra**            | GitHub Environment Secret → `deploy-infra.sh` → `.env` on VM → `docker compose --env-file` | Consumed by containers in `infra/compose/runtime/` (postgres, litellm, temporal, alloy, caddy, pdc-agent) that run outside k3s. Migration to OpenBao via AppRole/OIDC is a separate task (see "Compose→OpenBao migration" below).                                           |
| **D — CI-only**                  | GitHub Actions secret → workflow `env:` block                                              | Used only by `.github/workflows/*.yml` — never written to a runtime container. Provisioning + deploy tooling only (e.g., SSH_DEPLOY_KEY, VM_HOST).                                                                                                                          |
| **E — Repo-level (cross-env)**   | Repo-scope GH secret/variable (not environment-scoped)                                     | Shared across `candidate-a` / `preview` / `production`; one value per repo. Almost always CI consumption (`GHCR_DEPLOY_TOKEN`, `SONAR_TOKEN`, `CHERRY_AUTH_TOKEN`, etc.).                                                                                                   |
| **F — Local-only**               | `.env.local` (gitignored)                                                                  | Pure dev convenience. Never enters CI or any deployed runtime. Not in `setup-secrets.ts` (no `gh secret set` call).                                                                                                                                                         |
| **G — Derived**                  | Auto-generated from repo state at provision time                                           | Output of walking `nodes/*/.cogni/repo-spec.yaml` or similar repo metadata. Re-runs of setup pick up new nodes automatically. Example: `COGNI_NODE_DBS`, `COGNI_NODE_ENDPOINTS`.                                                                                            |

### A1 capability-gating + value-distinctness (`appliesTo` / `shared`)

Added by [`design.secrets-catalog-per-node`](../design/secrets-catalog-per-node.md) §Amendment v2 (task.5094). Nodes are heterogeneous — a Next.js app, a langgraph package, a dolt-memory store — so A1 is not "every fork gets all 36 baseline secrets." A1 baseline secrets live **once** in `infra/secrets-catalog.yaml` (operator-domain) and declare **two orthogonal fields** instead of a single `service:`:

- **`appliesTo: <capability>`** — which nodes receive it. The loader fans it to every `type:node` whose node-spec declares that capability. Capability classes: `all-nodes` (boot-floor), `web`, `database`, `llm`, `openclaw`, `payments`. A marker (not a `_node_baseline` pseudo-service) because it must express **subsets** — a langgraph+dolt node must not be fanned `OPENCLAW_GATEWAY_TOKEN` or a payment key.
- **`shared: true|false`** — value-distinctness, orthogonal to `appliesTo`:

| `shared`          | OpenBao path                | value                                     | example                          |
| ----------------- | --------------------------- | ----------------------------------------- | -------------------------------- |
| `false` (default) | `cogni/<env>/<node>/<KEY>`  | **distinct per node** (generated at seed) | `AUTH_SECRET`, `APP_DB_PASSWORD` |
| `true`            | `cogni/<env>/_shared/<KEY>` | **same** for all in-scope nodes           | `EVM_RPC_URL`, `POSTHOG_API_KEY` |

Path resolution lives in `openBaoPathFor()` in `scripts/lib/secrets-catalog-loader.ts`. `appliesTo` and `service:` are **mutually exclusive** (loader rejects both). `NO_NAME_COLLISIONS` (Invariant 2) is preserved — each name is declared once.

**Custody (firm, not best-effort):** a shared `AUTH_SECRET` enables cross-node session forgery; a shared `PRIVY_SIGNING_KEY` **moves every node's money**. Payment/wallet/signing keys MUST be `appliesTo: payments`, `shared: false`, **never baseline** — OpenBao isolates read (per-node path + reader role); per-wallet owner-keys (#1411) isolate signing.

### `authRole` — value-distinctness is NOT the security axis (DECIDED, migration in `proj.secrets-substrate`)

> Decided direction from two independent security reviews (task.5094, 2026-05-31). The `shared:` flag and the `_shared` pseudo-service below are the **current** model; this section is the **target**. The `PRIVY_SIGNING_KEY` custody carve-out above is the first instance of this rule — `authRole` generalizes it instead of special-casing each secret.

`shared:` welds **two orthogonal axes** into one flag, and the weld is a bug class:

- **Value-distinctness** (what `shared:` _means_): do all nodes get the same bytes? Harmless on its own.
- **Identity boundary** (what actually owns blast radius): is the token presented to a service as **proof of who is calling**, or does it merely **unlock a resource** the caller could already reach?

A shared value is fine for the second axis (one upstream account) but a **lateral-movement multiplier** for the first: if `LITELLM_MASTER_KEY` is the proxy admin key in every pod, one compromised pod controls the proxy for every node. So add one dimension + one CI gate, mirroring `custody:signing`:

```
authRole: caller-identity   # token IS the caller's identity to an internal service  → shared: true FORBIDDEN (CI gate)
authRole: resource-unlock   # token only unlocks a shared upstream resource           → shared: true ALLOWED
```

- **caller-identity** (`LITELLM_MASTER_KEY`, `SCHEDULER_API_TOKEN`, `BILLING_INGEST_TOKEN`, `GH_REVIEW_APP_PRIVATE_KEY_BASE64`): sharing is forbidden. Replace with a **per-node identity** — LiteLLM per-node virtual key, k8s projected-ServiceAccount JWT (`aud=scheduler|billing-ingest`, node derived from `sub`), or a per-node minted token + server-side `token→node` map. The master/signing key lives **only in the provisioner**, never the data plane.
- **resource-unlock** (`OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `POSTHOG_*`, `LANGFUSE_*`, `EVM_RPC_URL`, `PROMETHEUS_READ_*`): sharing legal. Prefer **egress-proxy injection** (pods never hold the value — route node→LiteLLM→OpenRouter) and **scoped per-node sub-keys** for attribution + per-node revoke on one account.

### Owner-scoped paths, not a `_shared` bucket

`_shared` has **no owner** — no service mints/rotates it, so the seed can only pass it through from `.env` and **silently drops** a missing one (the task.5094 bug). The target: every secret lives at **`cogni/<env>/<owner>/<KEY>`** where the owner is the service that mints + rotates it (`litellm/`, `scheduler-worker/`, `grafana/`); the **owner's provision step generates-once**; consumers receive an **explicit OpenBao read grant** on that path (policy templating). "Shared" becomes a **derived property** (N consumers granted read), not a storage location. This (a) eliminates the pass-through-from-`.env` silent-skip class, and (b) replaces today's over-broad dual-extract (every node reads **all** of `_shared/*`) with least-privilege per-path grants + a single rotation owner + scoped revocation.

`NEXT_PUBLIC_*` (e.g. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) ships to the browser — it is **public config, not a secret**. Keep it (per-node is fine); route it as config rather than guarding it in the secret substrate as if it were sensitive.

### Migration tracker (task.5094, 2026-05-31)

**What actually carries migration cost.** Only the **live `preview` + `production` GitHub Environment secrets** matter. Everything in candidate-a/-b (OpenBao + their GH secrets) is **agent-generated → disposable** — a re-provision regenerates it. And the owner+grant move re-homes values _inside_ OpenBao via provision; it **does not rename GH env keys** — so the structural migration forces **zero human re-entry**. A human only pastes a new value when we _deliberately_ split a shared upstream into per-node accounts (Phase 4/6, opt-in).

**Source split of the live envs** (preview 77 / production 81 GH-env secrets):

| Class                                                                                                                      | ~count | Migration cost                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| Agent-generated (passwords, DSNs, `AUTH_SECRET`, `LITELLM_MASTER_KEY`, internal tokens, AEAD, SSH key)                     | ~25    | none — regenerate on provision                                   |
| Human-pasted (OpenRouter, RPC URLs, Grafana/Prometheus/Langfuse/PostHog, GH App, OAuth, Privy, Dolt creds, PATs, `DOMAIN`) | ~48    | preserved in place — names stable; re-entry only on opt-in split |

**Phases** (ranked risk-reduction-per-effort; MVP-gated):

| Phase | Work                                                                                                      | Human touch            |
| ----- | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1     | `authRole` field + Zod loader + CI gate forbidding `shared`/`_shared` on caller-identity                  | no                     |
| 2     | Purge `_shared/` → owner paths + per-consumer read grants (provision generates-once)                      | no                     |
| 3a    | `LITELLM_MASTER_KEY` → per-node LiteLLM virtual keys (minted at provision; master stays in provisioner)   | no                     |
| 3b    | `SCHEDULER_API_TOKEN` / `BILLING_INGEST_TOKEN` → per-node token + `token→node` map, then projected-SA JWT | no                     |
| 4/6   | Per-node GitHub App / PostHog project / OpenRouter sub-keys for true per-node attribution                 | yes — opt-in, deferred |
| H     | Orphan cleanup — **DONE 2026-05-31** (below)                                                              | —                      |

**Phase H (done).** 8 purged-prototype secrets — `POLY_PROTO_PRIVY_{APP_ID,APP_SECRET,SIGNING_KEY}`, `POLY_PROTO_WALLET_ADDRESS`, `POLY_CLOB_{API_KEY,API_SECRET,PASSPHRASE}`, `COPY_TRADE_TARGET_WALLETS` — deleted from the `candidate-a`, `preview`, and `production` GitHub environments. Confirmed no runtime consumer (`.env.local.example`, [`poly-tenant-and-collateral.md`](./poly-tenant-and-collateral.md), and `work/handoffs/task.0318.phase-{a,b3}` all mark them orphaned post-Stage-4). Removed a stale Privy _signing_ key from production.

### Co-consumed annotation (NOT a separate tier)

When the same value is required by both a k8s app (A-tier) AND a Compose-infra container (B-tier) — e.g., `LITELLM_MASTER_KEY`, `BILLING_INGEST_TOKEN`, `APP_DB_*`, `METRICS_TOKEN`, `DOMAIN` — the script flags it with `coConsumed: true` on its routing entry. This is an **annotation, not a tier**: the primary tier remains whichever determines where the value originates from (usually A1 for application credentials, B for Compose-only).

How the dual-substrate flow actually works:

1. `setup-secrets.ts` writes the value to GitHub environment secrets AND to `.env.<env>` (the local cache file used by VM provisioning).
2. `scripts/ci/deploy-infra.sh` reads the GitHub env secret and writes it into `/opt/cogni-template-runtime/.env` on the VM for the Compose stack.
3. `scripts/setup/provision-env-vm.sh` Phase 5c reads `.env.<env>` from the operator's laptop and seeds OpenBao under the appropriate `cogni/<env>/<service>` path.

The two stores must agree. There is **no atomic dual-write** today; consistency is enforced by both flows reading from the same `.env.<env>` source-of-record at provision time. Divergence is a Phase 5c seed-loop bug.

**Two retirement events, not one:**

- When task.5052 / task.5053 land (k8s ports), the OpenBao half of A1+B co-consumed secrets is the SoT; the GH-env entry stays because Compose still needs it.
- When Compose-infra → OpenBao migrates (see end of document), the GH-env half retires and OpenBao becomes the sole store.

## DATABASE_URL / DATABASE_SERVICE_URL — derived, not catalog

`setup-secrets.ts` does NOT list `DATABASE_URL` or `DATABASE_SERVICE_URL` as catalog entries. Instead, `buildDSNs()` constructs them from `APP_DB_USER` + `APP_DB_PASSWORD` + `APP_DB_NAME` (and the service-role equivalents) at the end of the setup flow, then writes them as separate GH-env secrets.

**Open question for the OpenBao port:** does OpenBao store the constructed DSNs, or the components with app-side reconstruction? Recommendation: **store components, NOT DSNs.** Rationale:

- Components are the canonical form in OpenBao (one row per concept).
- App-side reconstruction is one line of code.
- Rotating just the password (the common case) doesn't force a DSN re-mint.
- If a future port introduces pgbouncer or a connection-pool sidecar, the DSN host/port may differ between sources — keeping components avoids that lock-in.

`task.5052` / `task.5053` must flip the app's env reader from `DATABASE_URL` to component reconstruction before the GH-env DSN entries retire.

## A2 — node-specific naming (aligned to single-node-scope)

Aligned to [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) §Domains (the four canonical domains today are `poly`, `resy`, `node-template`, `operator`):

- Node directory: `nodes/<node>/` — bare name, no `-node` suffix.
- Catalog file: `nodes/<node>/.cogni/secrets-catalog.yaml` (per-node, node-domain). Loader auto-fills `service: <node>` from the parent directory.
- OpenBao service path: `cogni/<env>/<node>` — `<service>` IS the bare node name for node-domain services.
- ExternalSecret manifest dir: `nodes/<node>/k8s/external-secrets/<env>/` (per-node, node-domain). Aggregator at `infra/k8s/secrets/external-secrets/<env>/kustomization.yaml` references the node-tree path.
- k8s Secret target name: `<node>-env-secrets` (per Invariant 2 of secrets-management.md).
- Pod envFrom: `secretRef: name: <node>-env-secrets`.

If any of those four artifacts (catalog → ExternalSecret manifest → k8s Secret name → pod envFrom) disagrees, the secret has been introduced incorrectly.

**Status in node-template:** the path namespace is reserved; no code under `nodes/node-template/app/` currently consumes any A2 secret. The poly-only entries (`POLYGON_RPC_URL`, `PRIVY_USER_WALLETS_*`, `POLY_WALLET_AEAD_KEY_*`) live in `infra/secrets-catalog.yaml` with `service: poly` as placeholders. When cogni-poly ports (`task.5053`), those entries should be moved to `nodes/poly/.cogni/secrets-catalog.yaml` in the cogni-poly tree — a single node-domain PR.

**Caveat:** `POLYGON_RPC_URL` is currently marked `required: true` in the YAML. node-template baseline has no consumer code; the flag is over-specified for the baseline fork. Recommended fix in a follow-up: relax to `required: false` in node-template, leave `required: true` in cogni-poly's per-node catalog.

**Renaming on port — cogni / cogni-poly current state (read before task.5052 / task.5053).** Today cogni and cogni-poly create k8s Secrets imperatively (`kubectl create secret`) with the name `<node>-node-app-secrets` (e.g., `poly-node-app-secrets`), set via a kustomize overlay patch on `infra/k8s/base/node-app/deployment.yaml` (base name `node-app-secrets`, overlay-rebranded per node). Reference: cogni-monorepo `docs/guides/node-formation-guide.md` §"Create k8s secrets" + `infra/k8s/overlays/canary/poly/kustomization.yaml`. On ESO port, the manifest naming changes from `<node>-node-app-secrets` (imperative) to `<node>-env-secrets` (ESO-managed). Migration path:

1. Author ExternalSecret reconciling the NEW name `<node>-env-secrets`.
2. Update the overlay's secret-name patch to point at the new name.
3. Once pods are rolled with the new envFrom (Reloader or manual `kubectl rollout restart`), delete the legacy imperative Secret.
4. Update `node-formation-guide.md` to drop the "Create k8s secrets" manual step — ESO does it now.

This is the only material naming change the port imposes. The catalog file, node directory, and OpenBao path stay as bare `<node>`.

## Per-service OpenBao path summary (A-tier and G-tier only)

| OpenBao path                   | Tier   | Consumer                                                                                                            | Status in node-template                                                                                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cogni/<env>/node-template`    | A1     | `nodes/node-template/app/` Deployment                                                                               | ✅ ExternalSecret + catalog present                                                                                                         |
| `cogni/<env>/scheduler-worker` | A1     | `services/scheduler-worker/` Deployment                                                                             | ✅ ExternalSecret + catalog present                                                                                                         |
| `cogni/<env>/_shared`          | A1 / G | Multiple services that opt in (LITELLM_MASTER_KEY, SCHEDULER_API_TOKEN, BILLING_INGEST_TOKEN, COGNI_NODE_ENDPOINTS) | ⚠️ Pattern documented; no ExternalSecret yet — add when first cross-service key lands                                                       |
| `cogni/<env>/poly`             | A2     | `nodes/poly/app/` (cogni-poly only)                                                                                 | 🔜 Reserved; lands with `task.5053` cogni-poly port. Catalog: `infra/catalog/poly.yaml::name=poly` (already present in cogni / cogni-poly). |
| `cogni/<env>/_system`          | G      | `provision-env-vm.sh` / `deploy-infra.sh` (deploy-time only)                                                        | ⚠️ Pattern documented; OIDC federation for CI writers not yet wired                                                                         |

## Adding a new secret — decision flow

1. **Pick a tier** from the table at top.
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

## Compose-infra → OpenBao migration (future)

The B-tier rows exist because Compose-infra containers have no Kubernetes ServiceAccount and cannot use the k8s auth method that ESO + pods use. Three vendor-supported paths to unify under OpenBao:

| Option                                     | Mechanism                                                                                                         | Tradeoff                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **AppRole at deploy**                      | `deploy-infra.sh` does `bao login -method=approle` on the VM, walks `cogni/<env>/compose-infra/*`, writes `.env`. | Simplest. Secret-ID bootstrap stored as GH secret initially. Rotation latency = next deploy. |
| **GHA OIDC → dynamic secret-id → AppRole** | Deploy job uses GH OIDC token to mint a one-shot secret-id from OpenBao; uses it immediately.                     | No long-lived secret-id anywhere. Same rotation latency. Cleanest end state.                 |
| **Bao Agent sidecar in compose.yml**       | Templates secrets into shared tmpfs; containers read from file.                                                   | Sub-minute rotation. Requires container restart hook for picking up changes. Adds a daemon.  |

**Recommendation:** AppRole at deploy first (mechanical change to `deploy-infra.sh`), GHA OIDC migration second (no app-side change). Bao Agent only if sub-minute rotation becomes a requirement.

Out-of-scope here; tracked in a separate spec + task to be filed.

## Open follow-ups

- `setup-secrets.ts` hardcodes `REPO = "Cogni-DAO/cogni"` regardless of which fork hosts the source tree. Fork-aware REPO resolution is a separate task; today this script is org-admin tooling that targets the cogni-template GH org for secret writes.
- `OPENCLAW_GITHUB_RW_TOKEN` is tagged `tier: B` based on SETUP_DESIGN.md's "host-side git relay" description. If openclaw becomes a k8s pod (vs Compose container), retag.
- `POLYGON_RPC_URL` `required: true` flag is over-specified for node-template baseline (no consumer). Relax in node-template, keep tight in cogni-poly fork.

## Related

- [Secrets Management](./secrets-management.md) — the OpenBao + ESO contract
- [Node CI/CD Contract](./node-ci-cd-contract.md) — single-node-scope domains; A2 service naming is anchored here
- [Access Control Charter](./access-control-charter.md) — L3 layer and dependencies
- [`scripts/setup-secrets.ts`](../../scripts/setup-secrets.ts) — runtime tool that consumes the loader output
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
- [`task.5071`](https://cognidao.org/work/items/task.5071) — the per-node catalog refactor (this PR)
