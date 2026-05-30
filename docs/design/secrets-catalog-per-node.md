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

## Related

- `task.5071` — this design's parent work item
- `task.5052` / `task.5053` — downstream ports that inherit this shape
- [`docs/spec/secrets-classification.md`](../spec/secrets-classification.md) — current tier definitions + naming conventions
- [`docs/spec/secrets-management.md`](../spec/secrets-management.md) — invariants this refactor preserves
- [`docs/spec/node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md) §Domains — the single-node-scope rule this refactor honors
- [`scripts/setup-secrets.ts`](../../scripts/setup-secrets.ts) — file being refactored
