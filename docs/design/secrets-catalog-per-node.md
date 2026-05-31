---
id: design.secrets-catalog-per-node
type: design
title: "Per-Node Secrets Catalog — Refactor"
status: draft
created: 2026-05-28
implements:
  - task.5071
---

# Per-Node Secrets Catalog — Refactor

## Situation

Today every new secret a node consumes (poly's `POLY_NEW_KEY`, resy's `RESY_NEW_KEY`, future billing-node's `BILLING_X`, etc.) requires PRs against **operator-domain files**:

| File                                                                      | Today                                                           | Domain   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| `scripts/setup-secrets.ts`                                                | Hardcoded `SECRETS[71]` + `SECRET_ROUTING` + `isPolySecret()`   | operator |
| `infra/catalog/<service>.yaml`                                            | Per-service infra declaration (port, dockerfile, deploy branch) | operator |
| `infra/k8s/secrets/external-secrets/<env>/<service>/external-secret.yaml` | ExternalSecret manifest                                         | operator |

`node-ci-cd-contract.md` §SINGLE_DOMAIN_HARD_FAIL blocks `poly + operator` combo PRs (operator is not in the ride-along whitelist for `infra/` or `scripts/`). So a poly engineer adding a poly secret must do **two PRs**: operator-domain first, then poly-domain. Every new secret. This violates the design intent of single-node-scope and silently penalizes node sovereignty.

## Goal

A node engineer can add, rotate, or remove a secret consumed by their node in **one PR** scoped to their node domain. Operator-domain code owns the substrate (loader, ExternalSecret reconciliation, OpenBao policies) but does not own the per-node catalog data.

## Non-Goals

- Changing the OpenBao path convention (`cogni/<env>/<service>/<KEY>` stays).
- Changing the ExternalSecret wire shape (`dataFrom: extract`, target `<service>-env-secrets` stays).
- Changing the k8s Secret target name pattern. (Renaming-on-port from `secrets-classification.md` is a separate concern.)
- Tooling for `_shared` cross-node secrets — they correctly stay operator-domain.
- Per-team writer-role scoping in OpenBao — separate concern, tracked under `task.5072`.

## Design

### Shipped file layout

(Differs slightly from the initial proposal — consolidated to two file types
instead of one-file-per-service. Reason: fewer files, single read path in the
loader, and `_shared` / `_system` are small enough that splitting them adds
churn without separation value.)

```
nodes/<node>/
  .cogni/
    repo-spec.yaml                     ← exists today (node_id, scope_id)
    secrets-catalog.yaml               ← NEW: per-node secrets declarations
  k8s/
    external-secrets/                  ← NEW: per-node ExternalSecret manifests
      candidate-a/
        external-secret.yaml
        kustomization.yaml
      preview/                         ← (empty until preview env spins up)
      production/                      ← (empty until production env spins up)

infra/
  catalog/
    <node>.yaml                        ← stays: per-service infra topology
    _schema.json                       ← stays
    secrets-catalog.yaml               ← NEW: ONE consolidated operator-domain catalog
                                           — _shared, _system, B/D/E, A2 placeholders
  k8s/secrets/external-secrets/
    cluster-secret-store.yaml          ← stays: substrate, env-agnostic
    candidate-a/
      kustomization.yaml               ← aggregator: references node-tree paths
      scheduler-worker/                ← stays operator-domain (not a node)

scripts/
  lib/
    secrets-catalog-loader.ts          ← NEW: Zod-validated YAML loader
  setup-secrets.ts                     ← REFACTORED: loader-driven, ~600 lines (was ~1600)
```

The split: **substrate** (CSS, policies, loader, ExternalSecret reconciliation)
stays operator-domain. **Per-node declarations** (which secrets, which tier,
which OpenBao path, which ExternalSecret) move to node-domain.

### Proposed YAML schema for `nodes/<node>/.cogni/secrets-catalog.yaml`

```yaml
# yaml-language-server: $schema=../../../infra/catalog/_secrets-catalog.schema.json
service: poly # MUST match nodes/<node>/ directory name
secrets:
  - name: POLYGON_RPC_URL
    tier: A2
    source: human
    required: false # node-local override of script-wide default
    category: "Polymarket / RPC"
    description: Polygon mainnet RPC endpoint for poly runtime reads
    url: https://dashboard.alchemy.com/
    steps:
      - Create a new app (chain: Polygon mainnet)
      - Copy the full HTTPS URL including API key
  - name: PRIVY_USER_WALLETS_APP_ID
    tier: A2
    source: human
    required: false
    category: "Poly Wallets (Privy)"
    description: Privy app ID for per-tenant Poly trading wallets
    url: https://dashboard.privy.io
    steps:
      - Open the dedicated user-wallets Privy app
      - Settings -> Basics
      - Copy App ID
  - name: POLY_WALLET_AEAD_KEY_HEX
    tier: A2
    source: agent
    required: false
    category: "Poly Wallets (Privy)"
    description: AES-256-GCM key for encrypting tenant Poly wallet CLOB creds
    generate: { kind: hex, bytes: 32 } # declarative — interpreted by setup-secrets.ts
    steps:
      - Auto-generated 32-byte hex key
```

The `service:` field is the OpenBao path component (per `secrets-classification.md` A2 naming). It MUST equal the parent directory name — load-time validator asserts this.

`generate:` is a declarative tag interpreted by the loader (`{ kind: hex, bytes: 32 }` → `openssl rand -hex 32`). Avoids embedding JS lambdas in YAML. Supported kinds: `hex`, `base64`, `sk-cogni`, `static` (with `value:`).

### `infra/secrets-catalog.yaml` (operator-domain)

Same schema, but each entry declares its own `service:` field. Holds:

- `service: _shared` — cross-node A1 baseline (LITELLM_MASTER_KEY, SCHEDULER_API_TOKEN, BILLING_INGEST_TOKEN, GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN)
- `service: _system` — G-tier derived (COGNI_NODE_DBS)
- `service: <node>` for A2 placeholders (poly entries, until cogni-poly ports them to `nodes/poly/.cogni/secrets-catalog.yaml`)
- no `service:` field — B/D/E tiers (Compose-infra, CI-only, repo-level)

Loader validates that `service:` (when declared) matches `_shared | _system | <known nodes/ dir>` — typos like `nodee-template` are rejected at module load.

### Loader change in `scripts/setup-secrets.ts`

```typescript
// Replace hardcoded SECRETS[71] with:
import { loadSecretsCatalog } from "./lib/secrets-catalog-loader";

const SECRETS: Secret[] = loadSecretsCatalog({
  nodeCatalogGlob: "nodes/*/.cogni/secrets-catalog.yaml",
  sharedCatalogPath: "infra/catalog/_shared-secrets.yaml",
});
```

The loader:

1. Walks `nodes/*/.cogni/secrets-catalog.yaml` — Zod-parses each, validates `service:` matches parent dir.
2. Parses `_shared-secrets.yaml` similarly.
3. Builds the flat `Secret[]` array shape that the rest of the script consumes (no main-loop changes needed).
4. Builds `SECRET_ROUTING` from inline `tier:` field on each entry.
5. Asserts no name collisions across nodes (poly cannot declare `LITELLM_MASTER_KEY` — that's `_shared`).
6. Asserts every entry has a tier; every entry's `service:` is either `_shared`, `_system`, or a directory under `nodes/`.

The existing load-time assertion (`SECRET_ROUTING ↔ SECRETS` 1:1) becomes a property OF the loader rather than a separate check.

### `SECRET_ROUTING` decision: inline vs centralized

**Recommend INLINE** (`tier:` field on each catalog entry).

Rationale:

- Co-location with the catalog entry was the load-bearing improvement of PR #53. Splitting them again recreates the drift class.
- Per-node catalogs are themselves small (poly will have ~5 A2 entries; resy similar) — `tier:` adds 1 line per entry.
- Centralized `SECRET_ROUTING` would force operator-domain edits when a node adds a secret — the exact thing this refactor exists to eliminate.

### ExternalSecret manifest relocation

Today: `infra/k8s/secrets/external-secrets/<env>/<service>/external-secret.yaml`
Proposed: `nodes/<node>/k8s/external-secrets/<env>/external-secret.yaml`

The ExternalSecret references `ClusterSecretStore openbao-backend` which stays in operator-domain (`infra/k8s/secrets/external-secrets/cluster-secret-store.yaml`). ExternalSecrets are CRDs scoped to a namespace; the manifest can live anywhere in the repo tree as long as kustomize finds it.

Update the kustomize overlay at `infra/k8s/overlays/<env>/<node>/kustomization.yaml` to add `resources: [../../../../nodes/<node>/k8s/external-secrets/<env>]`. (The overlay itself is operator-domain — but kustomize resource references are mechanical wiring, not policy.)

**Open question:** does kustomize `resources` pointing at a sibling node-tree path satisfy single-node-scope when the overlay file is touched? Probably not — overlay edits are operator intent. Mitigation: ship overlays once per env that auto-discover node trees via a directory glob (if kustomize supports it) or via a build-time script. **Decision deferred to implementation; if expensive, accept the overlay edit as operator-domain and absorb it via the documentation that nodes-add-secrets is one PR / nodes-add-services is two.**

### Migration plan (one PR, low-risk staged)

1. **Add the loader + schema** (`scripts/lib/secrets-catalog-loader.ts` + `infra/catalog/_secrets-catalog.schema.json`). Existing `SECRETS[71]` untouched.
2. **Author `infra/catalog/_shared-secrets.yaml`** with the cross-node entries from current SECRETS array (LITELLM, SCHEDULER_API_TOKEN, BILLING_INGEST_TOKEN, COGNI_NODE_DBS, COGNI_NODE_ENDPOINTS).
3. **Author `nodes/node-template/.cogni/secrets-catalog.yaml`** with the node-template-specific entries (AUTH_SECRET, OPENCLAW_GATEWAY_TOKEN, OAuth providers, Grafana, Privy operator wallet, etc.).
4. **Move ExternalSecret manifests**: `git mv infra/k8s/secrets/external-secrets/<env>/node-template nodes/node-template/k8s/external-secrets/<env>` + update overlay `resources:`.
5. **Wire the loader**: replace `const SECRETS: Secret[] = [...]` with `loadSecretsCatalog(...)`. Run `pnpm setup:secrets --env candidate-a` end-to-end against the loader; assert behavior unchanged.
6. **Delete the hardcoded SECRETS array** and `SECRET_ROUTING` constant from setup-secrets.ts (they're now built by the loader).
7. **Delete `isPolySecret()` function** — node membership IS the categorization (the catalog file's parent directory).
8. **Replace `--poly` flag** with `--node <name>` (or auto-derive from file globs). Backward-compat: keep `--poly` as alias mapping to `--node poly` for one release.
9. **Update docs**:
   - `secrets-classification.md` §Per-service OpenBao path summary — note new file locations
   - `secrets-classification.md` §Adding a new secret — decision flow updated
   - `.claude/commands/env-update.md` §0.5 — point at new file paths
   - `node-formation-guide.md` — new node template includes `secrets-catalog.yaml` stub

**Risk surface:**

- (Low) Loader schema rejection — caught at module load by Zod. Existing behavior preserved.
- (Low) Kustomize resource path change — caught by `kustomize build` in CI before any deploy.
- (Med) `--poly` flag callers — find via `rg "setup:secrets:poly|--poly"` in cogni / cogni-poly before retiring.
- (Low) Generator function YAML serialization — `generate: { kind: ... }` is declarative; lambdas only live in the loader.

### What ships AFTER this design lands

- `task.5052` (cogni port) inherits the NEW per-node shape. Cogni's existing nodes (poly, resy if applicable) each get their own `nodes/<node>/.cogni/secrets-catalog.yaml`. Each is a separate poly-domain or resy-domain PR after the operator-domain refactor lands.
- `task.5053` (cogni-poly port) — same.
- `task.5071` (this) closes when the refactor PR merges + downstream ports start consuming the new shape.

### Reverse compatibility

The OpenBao path convention does not change. ESO continues to reconcile from the same paths. Pods continue to consume the same k8s Secret targets. **A running cluster is not affected by this refactor** — only the developer flow for adding new secrets changes. The migration is purely about file ownership.

## Open Questions

- [ ] Kustomize overlay `resources:` edits when a node adds an ExternalSecret — operator-domain or node-domain? Decided in implementation per the trade-off above.
- [ ] Should `tier:` accept a default per-file (e.g., file-level `default-tier: A1`) to reduce per-entry verbosity? Defer to v2 — explicit is fine for now.
- [ ] Where does `_system` tier (G-derived secrets like `COGNI_NODE_DBS`) live? Recommend `infra/catalog/_system-secrets.yaml` alongside `_shared` — operator-domain because it walks the nodes list.
- [ ] Should the loader emit a printed routing table (`pnpm setup:secrets --list`) for auditor evidence? Cheap to add; useful for SOC2 documentation.

## Amendment 2026-05-31 (v2, post-review) — capability-gated secret fan-out

> Supersedes the v1 `_node_baseline` sketch below the fold. Two independent co-reviews + the repo-spec→node-spec work converged here. The bug that surfaced it (#1406 added `canary` as a byte-identical copy of node-template's 36-entry catalog → loader `AUTH_SECRET declared in both`) is a symptom; the model is the fix.

### The reframe: a "node" is a capability set, not an app

The repo-spec→node-spec work makes nodes **heterogeneous**: some are full Next.js apps (operator), some are langgraph agent packages, some are dolt memory stores — and several may run as packages **inside one shared operator/registry app** rather than as standalone deployables. So "same image ⇒ same 36 secrets" is wrong: a langgraph+dolt node must never be fanned `OPENCLAW_GATEWAY_TOKEN`, and **never** a payment key.

Two identities, kept distinct:

- **Logical node** = a `node_id` (from `nodes/<x>/.cogni/repo-spec.yaml`) + a set of **capabilities**. Owns a secret namespace `cogni/<env>/<node>/*`.
- **Physical deployable** = a pod. Standalone: 1 node → 1 pod. Shared operator app: N nodes → 1 pod that mounts each hosted node's `<node>-env-secrets`.

### The model: `appliesTo:` capability marker (NOT a pseudo-service)

A secret declares **which capability it serves**; a node declares **which capabilities it has** (node-spec); the loader fans each secret to the matching nodes. A marker expresses **subsets**; a pseudo-service (`_node_baseline`) can only express "all" — which is why both reviewers rejected it.

```yaml
# infra/secrets-catalog.yaml (operator-domain) — declared ONCE
- name: AUTH_SECRET
  appliesTo: web # only nodes with a web/auth surface
  source: agent
  generate: { kind: base64, bytes: 32 } # distinct value per node
- name: APP_DB_PASSWORD
  appliesTo: database
  source: agent
  generate: { kind: hex, bytes: 24 }
- name: PRIVY_SIGNING_KEY
  appliesTo: payments # NEVER baseline — custody isolation (see below)
  source: human
- name: OPENROUTER_API_KEY
  appliesTo: all-nodes
  shared: true # SAME value all nodes → cogni/<env>/_shared/<KEY>
```

`appliesTo` resolves: `all-nodes` → every `type:node`; `<capability>` → nodes whose node-spec lists that capability. The **boot-floor** (`appliesTo: all-nodes`, `shared: false`) shrinks to the genuine minimum (identity + the node's own DB creds); everything else is capability-gated. Capability classes (initial): `web`, `database`, `llm`, `openclaw`, `payments`.

### Distinct-value vs shared-value (the custody line)

`shared:` on the entry decides the path + isolation, orthogonal to `appliesTo`:

| `shared`          | path                        | value                                    | example                                               |
| ----------------- | --------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `false` (default) | `cogni/<env>/<node>/<KEY>`  | **distinct per node**, generated at seed | `AUTH_SECRET`, `APP_DB_PASSWORD`, `PRIVY_SIGNING_KEY` |
| `true`            | `cogni/<env>/_shared/<KEY>` | **same** for all in-scope nodes          | `OPENROUTER_API_KEY`, `EVM_RPC_URL`, `GRAFANA_URL`    |

**The real security fix is custody, not just forgery.** Today every node shares one value. Shared `AUTH_SECRET` → cross-node session **forgery**. Worse: shared `PRIVY_SIGNING_KEY` → **one secret moves every node's money**. So payment/wallet owner-keys are `appliesTo: payments`, `shared: false`, **never** baseline. OpenBao isolates **read** (per-node path + per-node reader role); the per-wallet **owner-keys from #1411** isolate **signing**. This is why `task.5081` no longer needs deferring — with this substrate, per-node isolation is real.

### Atomic / idempotent / nondestructive — the delivery contract

- **Atomic per (node, env), all-or-nothing.** A node must never boot with a Split address but no signing key. The write to OpenBao for a node's set is transactional; ExternalSecret-per-(node,env) gives atomic **delivery** (k8s Secret materializes whole or not at all).
- **Fail-fast on incomplete required set** — provision aborts if a node's `required` capability secrets aren't all present, rather than booting a half-custodied node.
- **Idempotent + repeatable** — re-running seed converges (existing `reconcile-secrets` read-back). Gaining a capability is **additive**; losing one is **explicit**, never a silent drop.
- **Identical env-var-name contract monorepo ↔ standalone.** Pods see the same env var names regardless of where the node runs; the `node_id`→path resolution and `(service,name)` routing stay **internal** to the loader. `node-template`-as-its-own-repo is just `node = itself`.

### `.env` vs OpenBao boundary (reviewer ask)

| value class                                        | lives in `.env.<env>`? | written to OpenBao                                             | why                                                       |
| -------------------------------------------------- | ---------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| per-node distinct (`shared:false`, `source:agent`) | **no**                 | generated per node at seed, straight to `cogni/<env>/<node>/*` | a flat `.env` holds one value per name; can't represent N |
| shared (`shared:true`)                             | yes                    | seeded once to `cogni/<env>/_shared/*`                         | single value; `.env` is fine                              |
| human-provided                                     | yes (entry point)      | seeded to the in-scope path                                    | human types once; fan/seed distributes                    |
| Compose-infra (B-tier)                             | yes                    | never                                                          | postgres/temporal read `.env` directly                    |

### Naming

`node_id` (from node-spec) is the identity; the path component is its catalog slug. `cogni/<env>/<node>/<KEY>` + `<node>-env-secrets`. Resolved from node-spec, **not** the directory/catalog label — so the same code works in the monorepo and in a standalone node repo.

### Staged plan (refines task.5071; unblocks task.5081 multi-node OpenBao)

1. **This design v2** → co-review. ✅ approved by 2 reviewers.
2. **Schema + loader**: add `appliesTo` + `shared` to the catalog schema; loader expands `appliesTo` × in-scope `type:node` → routing; expose `nodeTargets`. Capability source = node-spec (until node-spec lands, derive `web|database|llm|openclaw` from node presence; `payments` is opt-in). + unit tests. Operator-domain.
3. **Catalog migration**: node-template's A1 → capability-gated entries in `infra/secrets-catalog.yaml`; **delete canary's dup catalog** (resolves the collision); per-node catalogs keep only A2. Operator-domain.
4. **`setup-secrets` / seed**: per-node distinct-value generation + **atomic** per-(node,env) OpenBao write; fail-fast on incomplete required set.
5. **ExternalSecrets**: one per (node, env), dual `dataFrom: extract` (`<node>/*` + `_shared/*`); overlay wiring.
6. **`reconcile-secrets.sh`**: fan out to all in-scope `type:node` (today only `node-template` + `scheduler-worker`, `:125`).
7. **Legacy-retire**: once substrate delivery is proven, retire the imperative `<node>-node-app-secrets` path (bug.5086's `deploy-infra.sh` loop) — explicit step, not drift.
8. **E2E proof on candidate-b**: every node's pod `envFrom <node>-env-secrets` from its own `cogni/<env>/<node>/*`; 0 restarts; **0 cross-node value reuse** (assert distinct `AUTH_SECRET` per node).

### OSS / platform conventions this follows

- **HashiCorp Vault identity-templated paths** (`{{identity.entity.name}}`) + per-entity policy — our `cogni/<env>/<node>/*` + per-node reader role is the canonical multi-tenant Vault pattern, not a bespoke invention.
- **External Secrets Operator** `dataFrom` multi-source extract = the dual `<node>/*` + `_shared/*` pull; `PushSecret` is the atomic-write primitive.
- **Backstage software catalog** — entities declare `spec.type` + capabilities; the catalog resolves what applies. The node registry IS this; `appliesTo: <capability>` ≈ catalog-resolved relations.
- **Kubernetes `nodeSelector` / label affinity** — workloads target nodes by label; `appliesTo` is a label-selector over node capabilities.
- **SaaS per-tenant secret isolation** — namespace per tenant, **never** share signing keys across tenants. The custody line above is the standard control.

### Coordination — converge with bug.5086, don't race it

`bug.5086` catalog-drives `deploy-infra.sh`'s legacy imperative `<node>-node-app-secrets` loop to `type:node` — the **same generalization on the Compose-legacy path** (different k8s Secret names → no race with the substrate's `<node>-env-secrets`). Both drive off the **same node-spec + capability catalog**; that shared source is the seam. Step 7 retires the legacy path once the substrate proves out.

## Related

- `task.5071` — this design's parent work item
- `task.5081` — OpenBao landing on the hub; this amendment unblocks its multi-node step
- `bug.5086` — legacy-path twin (deploy-infra `type:node` catalog-drive); must converge on the same baseline
- `task.5052` / `task.5053` — downstream ports that inherit this shape
- [`docs/spec/secrets-classification.md`](../spec/secrets-classification.md) — current tier definitions + naming conventions
- [`docs/spec/secrets-management.md`](../spec/secrets-management.md) — invariants this refactor preserves
- [`docs/spec/node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md) §Domains — the single-node-scope rule this refactor honors
- [`scripts/setup-secrets.ts`](../../scripts/setup-secrets.ts) — file being refactored
