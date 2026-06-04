---
id: spec.secrets-management
type: spec
title: Secrets Management — OpenBao + ESO Contract
status: draft
trust: draft
summary: Canonical contract for how secrets enter, live in, and exit a Cogni node-template cluster. Defines the OpenBao path convention, the ExternalSecret consumption pattern (envFrom + dataFrom), RBAC + audit invariants, the standardized tooling that wraps the primitives, and the rotation lifecycle.
read_when: Adding a new secret, rotating a secret, designing a new service that consumes secrets, auditing access, or implementing the substrate (task.0284).
implements:
  - task.0284
owner: derekg1729
created: 2026-05-19
verified: 2026-06-04
tags:
  - secrets
  - security
  - soc2
  - openbao
  - external-secrets-operator
---

# Secrets Management Contract

## Context

Cogni node-template runs AI agents as primary committers. Every secret a human or agent touches is a potential exfiltration vector. The Tier-1 substrate (`task.0284`) is **External Secrets Operator + OpenBao**, both Apache 2.0 OSS, both Argo-idiomatic. This spec is the contract that the substrate satisfies and that every downstream consumer (services, guides, CLI tooling, GitHub workflows, operator MCP tools) MUST conform to.

The spec follows published guidance from:

- [External Secrets Operator documentation](https://external-secrets.io/) — the `dataFrom: extract` pattern is documented as the canonical "fetch all keys at a path" consumption shape
- [OpenBao documentation](https://openbao.org/docs/) — KV v2 path conventions + versioned secrets + audit log
- [HashiCorp Vault best practices](https://developer.hashicorp.com/vault/tutorials/policies/policy-templating) — RBAC via path-template policies (inherited by OpenBao)
- [Stakater Reloader](https://github.com/stakater/Reloader) — vendor-blessed zero-downtime restart on Secret/ConfigMap change
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [NIST SP 800-57 Part 1 Rev 5](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final) — key lifecycle (generate, distribute, store, use, rotate, retire, destroy)
- SOC 2 Trust Service Criteria CC6.1 / CC6.6 / CC7.2 / CC8.1

This spec deliberately does NOT invent new patterns where published guidance exists. Cite the source if you disagree with a rule here; do not re-invent.

## Goal

A human or AI agent can declare a new secret, rotate an existing secret, or revoke access **without touching pod specs, kustomize overlays, or any committed YAML** beyond the one-time-per-service `ExternalSecret` resource. The act of adding/rotating a secret is a control-plane operation against OpenBao, not a code change.

## Non-Goals

- Encrypted-secrets-in-git patterns (Sealed Secrets, SOPS+ksops). Rejected — see `proj.security-hardening` Design Notes.
- Multi-tenant SaaS KMS (Tier-2). See `task.5051` under `proj.operator-plane`.
- Compose-runtime secret migration **for non-DB service config** (LiteLLM, Temporal, Caddy). Compose services keep `.env` for these until they migrate to k3s. **Now in scope (the exception):** the pod-consumed **DB role passwords** — OpenBao-owned per Invariant 15 — whose Compose-side provisioner is being migrated to read from OpenBao instead of a GitHub-secret `.env` (see [DB-credential provisioning](#db-credential-provisioning--the-composek8s-boundary-bug5002-invariant-15)).

---

## Self-Serve Model (read this first)

The whole point: **any node developer adds a secret to their own running node — in one PR, with no
kubectl, no PAT, no laptop root token, and without waiting on the operator.** The platform spawns N
node forks; secret provisioning cannot be a bottleneck that routes through one person.

Adding a secret is **two atoms**, each self-serve:

```
┌── ① DECLARE (one PR, your node domain) ─────────────────────────────────────┐
│  Edit nodes/<node>/.cogni/secrets-catalog.yaml — one entry: name, tier,     │
│  appliesTo, shared, source.  The Zod loader validates it at load time.      │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │  the catalog is the ONE list the provisioner reads
                                   ▼
┌── ② WRITE THE VALUE (no laptop) ────────────────────────────────────────────┐
│  source: agent  → generated at seed, distinct per node. Nothing to do.      │
│  source: human  → secret-set workflow_dispatch (GH-OIDC → OpenBao; value    │
│                   staged as a sealed GH Environment Secret) OR, for         │
│                   candidate experimentation, `pnpm secrets:set`.            │
└─────────────────────────────────────────────────────────────────────────────┘
                                   ▼
   OpenBao  cogni/<env>/<service>/<KEY>   ← single source of truth
                                   ▼  ESO dataFrom: extract (one ExternalSecret per service-env)
   k8s Secret  <service>-env-secrets
                                   ▼  Stakater Reloader (envFrom is read once, at start)
   Pod rolling-restarts → process.env.<KEY> is live.   Zero pod-spec edits.
```

**Why this is the design (and what it replaces).** Atom ① only works if the provisioner derives its
fan-out **from the catalog**. Historically three hand-maintained lists decided which keys reached a
pod — `reconcile-secrets.sh::NODE_BASELINE_KEYS`, `provision-env.yml`'s per-secret `env:` block, and
the `bootstrap.sh` `.env` heredoc — and they drifted from the catalog. `DOLTHUB_*`/`DOLT_CREDS_*`
were declared catalog **A1** yet absent from all three lists, so the DoltHub mirror sat dormant: the
living proof that a catalog entry is inert until a human hand-propagates it. The
[`CATALOG_IS_THE_ONE_READER`](#core-invariants) invariant retires those lists — the catalog is the
only declaration surface, read by one loader (`scripts/lib/secrets-catalog-loader.ts`), so a node
dev's one-PR catalog edit actually fans out.

**Per-node _gating_ is already catalog-driven** (`_node_gets_key` resolves `appliesTo`/`service`); the
remaining work is making the key **universe** catalog-derived too, so declaration is genuinely
self-serve. The catalog model (capability-gated, distinct-vs-shared custody line) is specified in
[`docs/design/secrets-catalog-per-node.md`](../design/secrets-catalog-per-node.md).

---

## Core Invariants

1. **PATH_CONVENTION_PER_SERVICE_PER_ENV.** Every secret lives at `cogni/<env>/<service>` in OpenBao KV v2, with the secret name as a key at that path. `<env>` ∈ {`candidate-a`, `preview`, `production`}; `<service>` is the catalog name (`node-template`, `scheduler-worker`, …). One path per (service, env). Multiple keys per path.

2. **ONE_EXTERNAL_SECRET_PER_SERVICE_ENV.** Each service-env pair has exactly ONE `ExternalSecret` resource, created at first deploy, never edited when secrets are added. It uses `dataFrom: extract: key: cogni/<env>/<service>` to pull every key at the path into a single k8s `Secret` named `<service>-env-secrets`.

3. **POD_CONSUMES_VIA_ENVFROM.** Pod specs reference the synced k8s Secret via `envFrom: - secretRef: name: <service>-env-secrets`. ONE line per container, set ONCE at service creation. Adding/removing/rotating secrets does NOT edit pod specs. (Reference: [ESO `dataFrom` pattern](https://external-secrets.io/latest/api/externalsecret/#external-secrets.io/v1.ExternalSecretDataFromRemoteRef).)

4. **NO_VALUE_IN_GIT.** Secret values never enter git history, PR diffs, GitHub Actions logs, chat transcripts, or AI agent context. Only secret NAMES and PATHS appear in committed YAML. Violation = immediate rotation + audit.

5. **OPENBAO_IS_SINGLE_SOURCE_OF_TRUTH.** Every consumer (k8s pods via ESO, GitHub Actions via OIDC, CLI users via `bao` client, operator MCP tools) reads from OpenBao. No parallel store. GitHub env secrets contain ONLY the `OPENBAO_SEED_TOKEN` per env (plus a small allowlist of CI-pinned tokens documented per-secret).

6. **RBAC_VIA_PATH_POLICY.** OpenBao policies grant access on path prefixes. `cogni/<env>/<service>/*` access is granted to the `<service>-<env>-reader` (read) and `<service>-<env>-writer` (read+write) roles. Pods authenticate via Kubernetes auth method; humans via OIDC; agents via the operator's mediated token. (Reference: [Vault policy templating](https://developer.hashicorp.com/vault/tutorials/policies/policy-templating).)

7. **VERSIONED_KV_IS_AUDIT_SUBSTRATE.** OpenBao KV v2 retains prior versions per path. Rotation = `bao kv patch` (preserves other keys at the path; adds a new version). Never `bao kv destroy` a version pre-incident. Default retention: ≥10 versions per path; production-critical paths configured for ≥50.

8. **EVERY_ACCESS_AUDITED.** OpenBao audit device enabled; logs shipped to Loki via Alloy. Every read, write, rotate, delete is captured with actor identity (Kubernetes ServiceAccount, OIDC subject, or operator-MCP token), timestamp, path, and outcome. SOC 2 CC7.2 anomaly detection layers on top of this stream.

9. **TOOLING_IS_THE_INTERFACE.** Humans/agents NEVER call `bao kv put` directly in production paths. Three standardized entry points (all calling the same primitive):
   - **CLI:** `pnpm secrets:set <env> <service> <KEY>` (developer; interactive; never echoes values; requires caller-provided `BAO_ADDR` + short-lived `BAO_TOKEN` — see Invariant 13). For candidate experimentation.
   - **GitHub workflow:** `.github/workflows/secret-set.yml` — **per-operation** (never a generic `secrets-manage.yml` catch-all), `workflow_dispatch` with non-secret inputs `{env, service, key}`. Authenticates GH Actions OIDC → OpenBao `jwt` auth (`gha-<env>-writer` role, bound to `sub=repo:<owner>/<repo>:environment:<env>` → existing `<env>-writer` policy), then `bao kv patch`. **The value is NOT a dispatch input** (dispatch inputs are visible in run metadata → would violate Invariant 4); it is read from a sealed GH Environment Secret the dev stages via `gh secret set` (libsodium, write-only, masked in logs). `environment:<env>` makes production's GH-environment protection rule gate the token mint. This is the day-2 self-serve path; in the fork model each node owns its own OpenBao, so reachability is per-fork, not a shared-exposure decision.
   - **Operator API:** `POST /api/v1/secrets/declare` (AI agents via operator MCP; out of scope for node-template — operator monorepo construct)
     Substrate shipped: the `<env>-writer` policy + `gha-<env>-writer` JWT role are provisioned in `provision-env-vm.sh` Phase 5b. The killer rule — **no human ever types a secret VALUE into a plaintext form/UI** — is upheld: values arrive only via the sealed GH secret store, `gh secret set` stdin, or agent generation.

10. **SEED_TOKEN_IS_NEVER_TOUCHED_MANUALLY.** The `OPENBAO_SEED_TOKEN` (the one secret in GH env secrets per env) is written ONCE by `bootstrap.sh` and rotated only by automated mechanisms (operator-app rotation cron or Kubernetes auth method renewal). No human or agent ever runs `gh secret set OPENBAO_SEED_TOKEN` manually post-bootstrap.

11. **ROTATION_DOES_NOT_EDIT_GIT.** Routine rotation is a control-plane operation (`bao kv patch`). The k8s Secret is synced by ESO automatically; the pod is restarted by Stakater Reloader when it detects the Secret change. Zero PRs for rotation. Reloader is installed as the third substrate Argo app (`infra/k8s/argocd/reloader/`); the shared node-app Deployment carries `reloader.stakater.com/auto: "true"`. **This is load-bearing, not cosmetic:** `envFrom` is read once at container start, so without Reloader an ESO-synced value change never reaches a running pod — a day-2 write or rotation would be silently inert until the next unrelated rollout.

12. **TRANSITION_SAFE.** When ESO is wired but a specific path is empty (cold-start), the pod fails to start (loud, not silent). When a path exists but a specific key is missing, that env var is unset (Go/Node default semantics). Code that requires a secret MUST fail fast at startup with a clear error referencing the missing key NAME (not VALUE).

13. **NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP.** The bootstrap root token captured by `provision-env-vm.sh` Phase 5b exists during the ~30 min provisioning window only — Phases 5b.3 (eso-reader policy + role), 5b.4 (`<env>-writer` policy + role binding to `default/openbao-operator`), and 5c (initial path seeding) use it imperatively; nothing reads `.local/<env>-openbao-root-token` after Phase 5b exits. Day-2 secret writes mint a short-lived bao token via the writer role:

    ```
    export BAO_TOKEN=$(bao write -field=token auth/kubernetes/login \
      role=<env>-writer \
      jwt=$(kubectl create token openbao-operator -n default))
    ```

    (The `bao login -method=kubernetes` client helper is not in OpenBao CLI 2.5.x; the raw API path above is portable across CLI versions.)
    No script reads the bootstrap root token from disk post-bootstrap; no SSH-to-VM-then-kubectl-exec-as-root path exists. The bootstrap window itself is tolerated as the bounded "trust the operator's laptop" moment — v2 closes even this gap by moving provisioning to a GitHub workflow (operator triggers `gh workflow run provision-env.yml`; root token never touches a laptop). Tracked in the follow-up bug. Violation today = re-exporting the root token from `.local/` for day-2 writes, which would re-create the long-lived-superuser-credential-on-a-laptop pattern that `proj.security-hardening`'s motivating incident exists to eliminate.

14. **CATALOG_IS_THE_ONE_READER.** The set of keys that fan out to a pod is derived **only** from the secrets catalog (`infra/secrets-catalog.yaml` + `nodes/<node>/.cogni/secrets-catalog.yaml`), read through the single Zod loader (`scripts/lib/secrets-catalog-loader.ts`). No hand-maintained parallel list may decide pod fan-out — specifically `reconcile-secrets.sh::NODE_BASELINE_KEYS`, the per-secret `env:` map in `provision-env.yml`, and the `bootstrap.sh` `.env` heredoc are derived from the loader (e.g. a `--print-pod-keys <node>` emitter the bash side consumes), never independently authored. A catalog entry is the **declaration**; declaration must imply fan-out. Drift guard: `secrets-fanout.test.sh` fails closed if a catalog pod-key is not in the derived set. This is what makes Atom ① of the self-serve model real — a node dev's one-PR catalog edit reaches the pod without any operator-domain hand-edit. (Per-node _membership_ is already catalog-gated via `_node_gets_key`/`appliesTo`; this invariant extends the same SSOT to the key **universe**.)

15. **DB_ROLE_CREDS_ARE_OPENBAO_OWNED** (bug.5002 — the corollary of `OPENBAO_IS_SINGLE_SOURCE_OF_TRUTH` at the Compose↔k8s boundary). The DB role passwords a k8s pod authenticates with — Postgres `app_user`, `app_service`, the read-only role, and the Doltgres `knowledge_reader`/`knowledge_writer` roles — are **owned by OpenBao** and reach the pod inside the ESO-synced `DATABASE_URL` / `DOLTGRES_URL` at `cogni/<env>/<service>`. `deploy-infra.sh` / `db-provision` / `doltgres-provision` MUST NOT be a **second writer** of these passwords: they create each role **once** from the OpenBao-sourced value and **never `ALTER … PASSWORD` from a rendered `.env`** on a later run. A `.env` rendered from GitHub env secrets is a parallel store (Invariant 5 violation); ALTERing the DB to it diverges from the value ESO syncs to the pod → `28P01 password authentication failed` → `/readyz` "infrastructure unreachable" → 502 (the candidate-a 2026-06-04 cluster-wide outage). The Compose **superuser** (`POSTGRES_ROOT_PASSWORD`) is exempt — it is a Compose-runtime credential per the Non-Goal, consumed by no k8s pod — but it too is set-once at init, never "reconciled" to a divergent source. **The fix for a provisioning auth failure is to align the source (point `db-provision` at OpenBao), never to overwrite the DB from `.env`.**

---

## Design

### Path convention

```
cogni/<env>/<service>           ← KV v2 path
   ├─ OPENAI_API_KEY            ← key 1
   ├─ DATABASE_URL              ← key 2
   ├─ AUTH_SECRET               ← key 3
   └─ …
```

`<env>` ∈ `candidate-a` | `preview` | `production`. `<service>` matches `infra/catalog/<service>.yaml::name`. Multiple keys per path; one path per (service, env).

Cross-service secrets (e.g., a shared `OPENROUTER_API_KEY` consumed by both node-template and scheduler-worker) live at `cogni/<env>/_shared` and are referenced by services that explicitly opt in. Use sparingly — per-service paths are the default.

System-level secrets (Cherry token, Cloudflare token, GH PAT, ESO seed token) live at `cogni/<env>/_system`, written by `bootstrap.sh`, read by CI workflows via OIDC.

### Consumption pattern — ExternalSecret with `dataFrom: extract`

```yaml
# infra/k8s/secrets/external-secrets/<env>/<service>/external-secret.yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: <service>-env-secrets
spec:
  refreshInterval: 1h # See "Refresh intervals" below
  secretStoreRef:
    name: openbao-backend # ClusterSecretStore defined at install time
    kind: ClusterSecretStore
  target:
    name: <service>-env-secrets # The k8s Secret that ESO writes
    creationPolicy: Owner
    deletionPolicy: Retain # See "Why Retain" below
  dataFrom:
    - extract:
        key: cogni/<env>/<service> # Pulls ALL keys at this path
```

This is created ONCE per (service, env) at service-creation time. It is NOT edited when secrets are added — adding a key at `cogni/<env>/<service>` in OpenBao is automatically picked up on the next refresh.

**Why Retain deletion policy:** if the ExternalSecret is accidentally deleted (kustomize misconfiguration, branch churn), the k8s Secret persists and pods keep running. The next reconcile recreates the ExternalSecret and resumes sync. Failure-mode-safe.

**Refresh intervals (per-class defaults):**

| Class                    | refreshInterval | Rationale                                                                                            |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| Routine app secrets      | `1h`            | Balance between rotation latency and OpenBao read pressure                                           |
| External API keys        | `24h`           | Rotation is rare; reduce upstream rate-limit pressure                                                |
| DB credentials (dynamic) | `15m`           | OpenBao DB engine issues short-lived creds; refresh before TTL                                       |
| Critical (e.g., AEAD)    | `5m`            | Tight rotation window for financial-state material; pair with explicit force-sync hook for emergency |

Emergency force-sync: `kubectl annotate externalsecret <name> force-sync=$(date +%s) --overwrite`. Documented in `docs/guides/secrets-rotate.md`.

### Consumption pattern — pod spec

```yaml
# infra/k8s/base/<service>/deployment.yaml (excerpt; created ONCE)
spec:
  template:
    metadata:
      annotations:
        reloader.stakater.com/auto: "true" # Pod auto-restarts on Secret change
    spec:
      containers:
        - name: app
          envFrom:
            - secretRef:
                name: <service>-env-secrets # ONE reference; pulls all keys
```

This is set ONCE at service creation. **Adding a new env var that the code reads = NO POD SPEC EDIT. Just write the secret to OpenBao + push the code that consumes `process.env.NEW_KEY`.**

### DB-credential provisioning — the Compose↔k8s boundary (bug.5002, Invariant 15)

Postgres and Doltgres run as **Compose-on-VM** services, while the node-apps that consume them run as **k8s pods** (ESO-fed). The DB **role** passwords straddle that boundary, and that seam is where a split-brain festers:

- The **pod** reads its `DATABASE_URL` / `DOLTGRES_URL` (role name + password) from `cogni/<env>/<service>` in OpenBao via ESO. **OpenBao is the pod's SSOT.**
- **`deploy-infra.sh` / `db-provision` / `doltgres-provision`** create the matching DB roles **set-once** and never `ALTER … PASSWORD` on a later run (the #1500/#1502 fix).

**Current state (as-built) — the split-brain is dormant, not gone.** `db-provision` set each role's create-time password from `deploy-infra`'s rendered `.env`, and that `.env` is rendered from **GitHub env secrets** (`APP_DB_PASSWORD`, `APP_DB_SERVICE_PASSWORD`; the readonly + Doltgres roles are `derive_secret(POSTGRES_ROOT_PASSWORD)`). It equals the OpenBao value **only by construction** — both were seeded from the same GH secret at provision time. Nothing enforces lockstep: rotate the GH secret (or `bao kv patch` OpenBao) independently and the two diverge silently. Set-once removed the _landmine_ (the per-deploy `ALTER` that turned dormant drift into an active 502) but **the two sources still both exist.** The flow below is the **target**, not yet the as-built — today `db-provision` reads `.env`, not OpenBao.

**Target — one source by construction (not by coincidence):**

```
OpenBao  cogni/<env>/<service>   (app_user / app_service / readonly / doltgres role passwords)
   ├─ ESO ─────────────────────────▶ <service>-env-secrets ──▶ pod   (DATABASE_URL / DOLTGRES_URL)
   └─ deploy-infra READS the same value (reader JWT) ──▶ CREATE ROLE …   (set-once)
```

When `deploy-infra` reads each role password from the **same OpenBao value ESO syncs**, the DB role and the pod cannot disagree, no reconcile is ever needed, and the GH-secret DB passwords are retired (Invariant 5: GH env then holds only the seed token + CI-pinned allowlist).

#### Migration — phased, each phase independently shippable

| Phase | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | State    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **0** | **Set-once stabilization** — remove every `.env`→pod-role `ALTER` (#1500/#1502). The precondition: the _source_ of a one-time create can only be swapped cleanly once no per-deploy writer exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **DONE** |
| **1** | **OpenBao read path on the deploy host** — `deploy-infra.sh` runs on the VM, which runs k3s; OpenBao is a reachable **ClusterIP** there. Mint a short-lived **reader**-role JWT via the _same_ k8s-auth pattern Invariant 13 uses for the writer role (`bao write auth/kubernetes/login role=<env>-db-reader jwt=$(kubectl create token …)`), scoped read-only to the DB keys at `cogni/<env>/<service>`. `provision-env-vm.sh` Phase 5b adds the `<env>-db-reader` policy+role beside `eso-reader`/`<env>-writer`. **No Ingress, no public exposure** — OpenBao stays ClusterIP; reuses the sanctioned k8s-auth seam, not a new entry point (Invariant 9). | TODO     |
| **2** | **Swap the source + retire the GH-secret DB passwords** — `deploy-infra`'s `.env` render fetches `APP_DB_PASSWORD` / `APP_DB_SERVICE_PASSWORD` / readonly / `DOLTGRES_*` from OpenBao via the Phase-1 reader token instead of GH env secrets. `db-provision` stays set-once, but the create-time value now provably equals the OpenBao value. Drop `APP_DB_*_PASSWORD` from the deploy workflow's required GH secrets. The **Grafana datasource** (the readonly role's second consumer, bug.5031 drift class) reads the same OpenBao value → that drift class closes too.                                                                                   | TODO     |
| **3** | **Dynamic-creds endgame** — OpenBao DB secrets engine (per-session creds, `refreshInterval: 15m`); no static role password exists, so there is nothing to drift _or_ rotate. `proj.security-hardening` Crawl row 3; see [`secrets-rotate.md`](../guides/secrets-rotate.md) "Dynamic database credentials".                                                                                                                                                                                                                                                                                                                                                  | FUTURE   |

**Sequencing wrinkle (genesis vs steady-state).** OpenBao is itself a k3s/Argo app stood up _during_ a cold provision, so `db-provision` cannot read from it at genesis (chicken-and-egg). Resolution: **genesis still seeds OpenBao once from the GH secret** (the origin), and **every deploy thereafter reads FROM OpenBao** (the source). After genesis the GH DB-password secrets are deletable. The new coupling — a deploy now hard-depends on OpenBao being unsealed + reachable — is **not a new SPOF**: OpenBao-down already takes the pods down (ESO is their only DB-cred source), so the deploy path merely shares a dependency the runtime already carries. On an OpenBao read failure `deploy-infra` **fails loud and skips the role create** (db-provision surfaces the real error); it MUST NOT fall back to a divergent GH `.env` value — that is exactly the bug.5002 anti-fix.

**The bug.5002 anti-fix (do NOT do this):** "self-heal drift" by ALTERing a pod-consumed DB role password to deploy-infra's rendered `.env` on every deploy. That makes deploy-infra a **second writer**, guarantees divergence whenever `.env` ≠ OpenBao, and converts a silent inconsistency into an active 502 outage. When `db-provision` can't authenticate, fix the **source** (point it at OpenBao), never overwrite the DB from `.env`.

#### E2E validation contract (Phases 1–2, on candidate-a)

- [ ] **Phase 1 — read path:** `deploy-infra` mints the `<env>-db-reader` JWT and a `bao kv get cogni/candidate-a/<service>` succeeds from the deploy context (logged; value never echoed). Negative: the reader token cannot write (`bao kv patch` is denied).
- [ ] **Phase 2 — sole-source proof (falsifying):** rotate `APP_DB_PASSWORD` in **OpenBao only** (`bao kv patch`, no GH-secret edit), run a deploy. The Postgres role, the pod's `DATABASE_URL`, and the Grafana datasource all converge on the new value with **zero 28P01** and zero GH-secret change.
- [ ] **Phase 2 — dependency-removed proof (negative):** delete the `APP_DB_*_PASSWORD` GH env secrets; a subsequent deploy still succeeds. Proves no GH-secret DB-password dependency remains.
- [ ] **`deploy_verified`:** flight to candidate-a; the deploy's OpenBao reads appear in the audit device → Loki with the `<env>-db-reader` subject.

### Standardized tooling — three entry points, one primitive

All three call the same underlying primitive: `bao kv patch cogni/<env>/<service> <KEY>=<value>` (with appropriate auth method per caller).

#### Entry 1 — CLI (developer; interactive)

```bash
pnpm secrets:set candidate-a node-template OPENAI_API_KEY
# Prompts for value via secure stdin (never echoes)
# Authenticates via OIDC if bao token missing
# Calls: bao kv patch cogni/candidate-a/node-template OPENAI_API_KEY=<value>
```

Wrapper script at `scripts/secrets/set-secret.sh`. Validates path against catalog (`<service>` must exist in `infra/catalog/`); validates env; refuses to write to `cogni/_system/*` (system paths edited by bootstrap only).

#### Entry 2 — GitHub workflow (ops; audit-logged)

`.github/workflows/secrets-manage.yml` — workflow_dispatch with inputs:

```yaml
inputs:
  env:
    {
      required: true,
      type: choice,
      options: [candidate-a, preview, production],
    }
  service: { required: true, type: string }
  key: { required: true, type: string }
  value: { required: true, type: string, sensitive: true } # masked in logs
  operation: { required: true, type: choice, options: [set, rotate, delete] }
```

The workflow authenticates to OpenBao via GitHub Actions OIDC federation (the `OPENBAO_SEED_TOKEN` per env in GH secrets is NOT used by this workflow; OIDC issues a job-scoped token with `secrets-writer` policy). Audit log entry generated in OpenBao. Production-env writes require explicit re-approval (GitHub environments protection rule).

#### Entry 3 — Operator API (AI agents; MCP-mediated)

```
POST /api/v1/secrets/declare
Body: { env, service, key }
Response: 201 with a one-time-use submission URL the human visits to provide the value
```

AI agents CANNOT pass the value. They declare the SHAPE (env, service, key). The human (or operator-app UI) fills the value through a separate authenticated channel. The MCP tool `secret.declare` exposes this to agents; `secret.get_value` does NOT exist.

### Value classification — two orthogonal axes

A catalog entry answers two independent questions. Do not conflate them.

**1. `source:` — where the value ORIGINATES (who can produce it):**

| `source:` | Origin                                                                                                                                    | Provisioning behavior                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `agent`   | we generate it (`generate:` field required)                                                                                               | generate once, store (`bootstrap.sh::declare_or_gen`)  |
| `human`   | **un-generatable by us** — vendor-minted; a human supplies it once via the vendor's UI (e.g. a GitHub App **private key**, an OpenAI key) | carry the supplied value from GH env; never regenerate |

**2. `syncTo:` (optional) — does the value ALSO live in an external system we must keep in lockstep:**

A value's origin is independent of whether it must be mirrored outward. The GitHub App **webhook secret** is `source: agent` (we generate it) **and** `syncTo: github-app-webhook` (GitHub holds a copy that must byte-match). `syncTo` names the external mirror; provisioning runs the matching push after writing the pod Secret.

| `syncTo:`            | Mirror target                            | Push mechanism                                                                                                                      |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| _(unset)_            | none — value lives only in our substrate | —                                                                                                                                   |
| `github-app-webhook` | the GitHub App's webhook secret          | `scripts/secrets/sync-app-webhook-secret.sh` (App JWT → `PATCH /app/hook/config`), invoked by `deploy-infra` after the Secret write |

**Why the second axis is load-bearing — misclassifying a mirrored secret is a silent-failure bug.** A `source: agent` value with no `syncTo` is regenerated every provision; if it actually must equal an externally-held counterpart, the two never converge, so `deploy-infra` re-writing the pod Secret becomes the _breaking_ path (every webhook fails HMAC verification, logged only as a `level:40` warn). `syncTo` closes the loop: provisioning owns BOTH copies. No human, self-healing — every infra-lever deploy re-converges.

### Rotation lifecycle (per NIST SP 800-57 §8 Key States)

```
                Generate ──▶ Distribute ──▶ Active ──▶ Suspended ──▶ Compromised/Destroyed
                                              │            ▲
                                              └─Rotate────┘
```

Per-class cadence:

| Class                             | Cadence                                           | Mechanism                                                        |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Dynamic DB credentials            | per-session (≤1h TTL)                             | OpenBao DB engine issues per-session; old expires automatically  |
| Routine app tokens                | quarterly                                         | Scripted `pnpm secrets:rotate` or workflow_dispatch              |
| External API keys                 | annually                                          | Manual mint + `bao kv patch` (some issuers expose rotation APIs) |
| Bootstrap tokens (Cherry, CF, GH) | annually                                          | Manual rotation; documented in fork-quickstart                   |
| ESO seed token                    | per-pod-lifetime (Kubernetes auth method renewal) | Automated by k8s ServiceAccount token rotation                   |
| Emergency (compromised)           | immediate                                         | Force-sync ESO; alert chain via Loki; incident report            |

**Routine rotation = ZERO PR:**

1. `pnpm secrets:rotate candidate-a node-template AUTH_SECRET`
2. Tool generates new value (or accepts input for non-generatable keys)
3. `bao kv patch cogni/candidate-a/node-template AUTH_SECRET=<new>` (OpenBao retains prior version)
4. ESO refresh interval pulls new value into k8s Secret
5. Reloader detects Secret change → restarts pod (zero-downtime; controlled rolling update)
6. Audit log entry in OpenBao + Loki

**Rollback path:** `bao kv rollback -version=N cogni/<env>/<service>` restores the prior version. Useful for incident response (e.g., rotated key turned out to be invalid).

### RBAC policy templates

OpenBao policies are path-prefix-scoped. Templates (`policies/<role>.hcl`):

```hcl
# poly-production-reader.hcl
path "cogni/data/production/poly/*" { capabilities = ["read"] }
path "cogni/metadata/production/poly/*" { capabilities = ["read", "list"] }

# poly-production-writer.hcl
path "cogni/data/production/poly/*" { capabilities = ["read", "create", "update", "patch"] }
path "cogni/metadata/production/poly/*" { capabilities = ["read", "list"] }
# Deliberately no delete — destroy requires admin escalation per CC6.1
```

Bound via OpenBao role definitions to Kubernetes ServiceAccounts (per-service-per-env), OIDC subjects (developer roles), or operator-mediated agent tokens.

### SOC 2 mapping

| TSC Criterion                          | How this spec satisfies it                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CC6.1** Logical access controls      | OpenBao policies enforce least-priv per path; Kubernetes auth method per pod; OIDC for humans; operator-mediated tokens for agents                           |
| **CC6.6** Data confidentiality at rest | OpenBao encrypts at rest by default; k8s Secrets stored in etcd (encryption-at-rest enabled by k3s default); pod consumption via kubelet tmpfs (memory only) |
| **CC7.2** Anomaly detection            | OpenBao audit log → Alloy → Loki → alert rules (e.g., production writes from unexpected actors, off-hours rotation, repeated failed access)                  |
| **CC8.1** Change management            | Versioned KV provides immutable audit trail per path; rotation evidenced by audit log entries with actor + timestamp + outcome; rollback path documented     |

### Anti-patterns (reviewer will reject)

- Per-secret `ExternalSecret` resources (one YAML per key) — wrong shape; use `dataFrom: extract` per service-env
- `valueFrom: secretKeyRef` per env var in pod spec (forces pod spec edit per secret) — use `envFrom: secretRef`
- Secret values in committed YAML, even base64-encoded — base64 ≠ encryption
- Bypassing the standardized tooling for production-env writes
- `deploy-infra.sh` / `db-provision` / `doltgres-provision` ALTERing a **pod-consumed** DB role password from a rendered `.env` (a second writer to the OpenBao-owned credential — Invariant 15; caused the candidate-a bug.5002 cluster outage). Roles are created set-once from the OpenBao value, never reconciled to `.env`.
- `bao kv put` (replaces all keys at path) instead of `bao kv patch` (additive)
- `bao kv destroy` to clean up — use `bao kv delete` (soft delete; restorable); only destroy with explicit incident-response justification
- Sealed Secrets (cluster-bound keys; rejected per `proj.security-hardening` Design Notes)
- SOPS encrypted files in git (placeholder scaffold being retired; rejected per same)
- AWS Secrets Manager / 1Password Connect / Doppler as the default backend (vendor lock against OSS-first constraint; forks MAY swap backends via ESO's pluggable provider, but OpenBao is the baseline)

---

## File Pointers

| File                                                  | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `infra/k8s/argocd/openbao/`                           | Argo Application installing OpenBao (`task.0284`)                      |
| `infra/k8s/argocd/external-secrets/`                  | Argo Application installing ESO controller (`task.0284`)               |
| `infra/k8s/argocd/reloader/`                          | Argo Application installing Stakater Reloader (`task.5056`)            |
| `infra/k8s/secrets/external-secrets/<env>/<service>/` | Per-service-per-env ExternalSecret YAML                                |
| `scripts/secrets/set-secret.sh`                       | CLI implementation (`pnpm secrets:set`)                                |
| `scripts/secrets/rotate-secret.sh`                    | CLI implementation (`pnpm secrets:rotate`)                             |
| `.github/workflows/secret-set.yml`                    | Day-2 self-serve write (GH-OIDC → OpenBao; per-operation)              |
| `scripts/lib/secrets-catalog-loader.ts`               | The one catalog reader (Zod); emits the pod-key universe               |
| `nodes/<node>/.cogni/secrets-catalog.yaml`            | Per-node declaration surface (one-PR self-serve)                       |
| `docs/runbooks/fork-quickstart.md`                    | Bootstrap flow (substrate install + unseal + role bind, Steps 6 / 6.5) |
| `docs/guides/secrets-add-new.md`                      | Practical guide — adding a new secret                                  |
| `docs/guides/secrets-rotate.md`                       | Practical guide — rotation playbook + substrate-token rotation         |

## Related

- [`proj.security-hardening`](../../work/projects/proj.security-hardening.md) — parent project; Secrets Substrate section
- [`task.0284`](https://cognidao.org/work/items/task.0284) — Tier-1 implementation
- [`task.5052`](https://cognidao.org/work/items/task.5052) — Phase 2 cogni migration
- [`task.5053`](https://cognidao.org/work/items/task.5053) — Phase 3 cogni-poly migration
- [`task.5051`](https://cognidao.org/work/items/task.5051) — Tier-2 operator-managed KMS (deferred)
- [`task.5055`](https://cognidao.org/work/items/task.5055) — `secrets-add-new.md` guide
- [`task.5056`](https://cognidao.org/work/items/task.5056) — `secrets-rotate.md` guide + Reloader install
- [`task.5057`](https://cognidao.org/work/items/task.5057) — `fork-quickstart.md` update for ESO
- [`ci-cd.md`](./ci-cd.md) — Axiom 17 amendment lands with `task.0284`

## E2E Validation — the self-serve proof

The model is proven, end to end, by a node dev adding **one throwaway secret to the `node-template`
node** and watching it reach the running pod with zero operator-domain edits. Today `node-template`
has **no** per-node catalog (all its keys live `_shared` in `infra/secrets-catalog.yaml`), so the
probe also exercises the per-node declaration seam for the first time.

**Throwaway probe:** `NODE_TEMPLATE_SELFSERVE_PROBE` — declared in
`nodes/node-template/.cogni/secrets-catalog.yaml`, so `service:` auto-resolves to `node-template`
and it fans out to **only** the node-template pod (not every node). `tier: A2`, `shared: false`,
**`source: agent`** (`generate: { kind: hex, bytes: 16 }`). No app code consumes it; the proof is
that it materializes in the node-template pod's environment.

The probe ships as its **own node-template-scoped PR** (just the one catalog file) — which is itself
the cleanest proof of the model: adding a secret is a single-node-domain PR (`single-node-scope`
passes), with zero operator-domain edits. The substrate that makes it fan out (the emitter, the
`consumedBy` model, the `reconcile-secrets.sh` swap) is the separate operator-domain track.

> **Why `source: agent`, not `human`:** the candidate-a proof must validate Atom ① + the
> catalog→ESO→Reloader wire **without** depending on the Atom ② value-write path, which on
> candidate-a still hits the OpenBao-reachability question (plaintext, ClusterIP, no Ingress — the
> `secret-set.yml` runner can't reach it yet; that resolves per-fork, see Invariant 9). An
> agent-generated value is seeded by provisioning itself, so it exercises the full declare→pod loop
> standalone. The `secret-set.yml` value-write (Atom ② for `source: human`) is proven separately once
> per-fork OpenBao exposure lands — do not block Atom ① on it.

**The falsifying "before" (proves the gap is real):**

- [ ] On `main` (pre-`CATALOG_IS_THE_ONE_READER`), add the probe to a new
      `nodes/node-template/.cogni/secrets-catalog.yaml`. The loader sees it
      (`pnpm secrets:set --list` / `print-pod-keys node-template` includes it) but a fresh provision
      does **not** seed it — `bao kv get cogni/<env>/node-template` lacks the key. ⟹ catalog entry is
      inert. This is the bug.

**CI (unit, no infra) — must be green to merge:**

- [ ] `secrets-fanout.test.sh` rewritten: `NODE_BASELINE_KEYS` (and the provision-env / bootstrap key
      sets) **equal** the loader-derived pod-key set per node. RED if a catalog pod-key is dropped.
- [ ] `print-pod-keys` unit: a catalog with `appliesTo: all-nodes` key → present for every node; an
      `appliesTo: payments`/`service: poly` key → present only for poly.
- [ ] Loader/Zod unit: the probe entry parses; `service:` matches parent dir; name unique across catalogs.
- [ ] `shellcheck` on the three de-listed scripts; `pnpm check:docs` for the doc edits.

**Candidate-a (the wire — `deploy_verified`):**

- [ ] Flight this branch → candidate-a; confirm build SHA == head.
- [ ] **Declare** (Atom ①): land the node-template-scoped probe PR (`nodes/node-template/.cogni/secrets-catalog.yaml`).
      Provision (or Phase-5c reconcile) auto-seeds `cogni/candidate-a/node-template/NODE_TEMPLATE_SELFSERVE_PROBE`
      from the catalog (`source: agent`) — verify via `bao kv get` (port-forward) **with zero per-secret
      hand-edits and zero `pnpm secrets:set`**. This is the catalog-SSOT proof.
- [ ] ESO: the node-template `*-env-secrets` ExternalSecret reports `SecretSynced`; the synced k8s
      Secret contains the probe key.
- [ ] **Reloader closes the loop:** the pod rolling-restarts on the Secret change; `kubectl exec … printenv`
      shows `NODE_TEMPLATE_SELFSERVE_PROBE` in the running container — **no manual rollout**.
- [ ] **Self-serve assertion:** the entire flow touched only `nodes/node-template/.cogni/secrets-catalog.yaml`
      (+ a value via sealed channel) — zero edits to `reconcile-secrets.sh`, `provision-env.yml`,
      `bootstrap.sh`, pod specs, or ExternalSecret YAML.
- [ ] `secret-set.yml` audit: the OpenBao write appears in the audit device → Loki with the OIDC subject.

**Regression / negative:**

- [ ] Re-run provision (idempotency): no pod churn for unchanged values.
- [ ] A node that does NOT own a `service`-pinned A2 key still does not receive it (operator vs a poly key).
- [ ] `dolthub_push_ok`: with the same machinery, `DOLTHUB_*`/`DOLT_CREDS_*` now fan out — a knowledge
      contribution merge fires `dolthub_push_ok` in Loki (the original task.5104 goal, now reproducible).

> The actionable, checkable step list lives in the work item (`task.5104`); this section is the
> acceptance contract those steps must satisfy.

## Docs Consolidation (executed with the implementing PR)

The self-serve model makes several pre-OpenBao docs actively wrong (they assert GH-env as SSOT).
Pruned/refined atomically with the code so no doc outlives the model it describes:

| Doc                                                                                  | Action                                                                | Reason                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/commands/env-update.md`                                                     | **REWRITTEN** (this PR)                                               | Was a 15-surface manual-propagation checklist (the drift anti-pattern). Now the catalog-SSOT self-serve path.                                                                                                                             |
| `docs/runbooks/SECRET_ROTATION.md`                                                   | **DELETE** + retarget inbound links → `docs/guides/secrets-rotate.md` | Pre-`task.0284`; asserts "all secrets in GitHub Actions Secrets" — contradicts `OPENBAO_IS_SINGLE_SOURCE_OF_TRUTH`.                                                                                                                       |
| `docs/runbooks/INFRASTRUCTURE_SETUP.md`                                              | **OUT OF SCOPE** — flag, don't delete here                            | Stale (pre-OpenBao Terraform + GH-secret VM setup) but it's a _VM-provisioning_ doc with ~10 inbound links across deploy skills/specs. Its deletion is a separate docs-hygiene PR, not the secret self-serve model. Tracked, not bundled. |
| `docs/spec/secrets-management.md`                                                    | **REFINED** (this PR)                                                 | Self-serve model section + `CATALOG_IS_THE_ONE_READER` + corrected Entry 2 + Reloader + this validation.                                                                                                                                  |
| `docs/design/secrets-catalog-per-node.md`                                            | KEEP                                                                  | The catalog model; this spec references it, no duplication.                                                                                                                                                                               |
| `docs/guides/secrets-add-new.md` · `secrets-rotate.md` · `cicd-secrets-expert` SKILL | KEEP (light touch: `secret-set.yml` name + Entry-2 status)            | Canonical recipes; no stale-SSOT claims.                                                                                                                                                                                                  |

Killer-rule check: every deleted doc asserts the OLD (GH-env-SSOT) model; no deleted doc is the sole
copy of a still-valid recipe (the port-forward CLI recipe stays in `secrets-add-new.md`).

## Acceptance

- ✅ Every invariant cited in this spec has a corresponding enforcement point (test, CI check, OpenBao policy, or operator-app check) once `task.0284` ships
- ✅ Adding a new secret to an existing service-env path requires zero git changes
- ✅ Rotating a secret requires zero git changes
- ✅ Secret values never appear in any committed file, PR diff, GitHub Actions log line, chat transcript, or AI agent context window
- ✅ A node dev adds a secret to their node end-to-end (`NODE_TEMPLATE_SELFSERVE_PROBE` proof) touching only their per-node catalog + a sealed value channel — no operator-domain edit, no kubectl, no laptop root token
