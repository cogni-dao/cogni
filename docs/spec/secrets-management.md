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
verified: 2026-05-19
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
- Compose-runtime secret migration. Separate follow-up; Compose services keep `.env` until they migrate to k3s.

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
   - **CLI:** `pnpm secrets:set <env> <service> <KEY>` (developer; interactive; never echoes values; requires caller-provided `BAO_ADDR` + short-lived `BAO_TOKEN` — see Invariant 13)
   - **GitHub workflow:** `.github/workflows/secrets-manage.yml` (ops; workflow_dispatch; uses `hashicorp/vault-action` for GH-OIDC→OpenBao token exchange — **deferred; canonical operator path for preview/production once it ships**)
   - **Operator API:** `POST /api/v1/secrets/declare` (AI agents via operator MCP; out of scope for node-template — operator monorepo construct)
     The CLI is the only currently-implemented path. Until the workflow_dispatch entry ships, preview/production writes use the CLI with short-lived `BAO_TOKEN`s (port-forward + `bao login`).

10. **SEED_TOKEN_IS_NEVER_TOUCHED_MANUALLY.** The `OPENBAO_SEED_TOKEN` (the one secret in GH env secrets per env) is written ONCE by `bootstrap.sh` and rotated only by automated mechanisms (operator-app rotation cron or Kubernetes auth method renewal). No human or agent ever runs `gh secret set OPENBAO_SEED_TOKEN` manually post-bootstrap.

11. **ROTATION_DOES_NOT_EDIT_GIT.** Routine rotation is a control-plane operation (`bao kv patch`). The k8s Secret is synced by ESO automatically; the pod is restarted by Stakater Reloader when it detects the Secret change. Zero PRs for rotation.

12. **TRANSITION_SAFE.** When ESO is wired but a specific path is empty (cold-start), the pod fails to start (loud, not silent). When a path exists but a specific key is missing, that env var is unset (Go/Node default semantics). Code that requires a secret MUST fail fast at startup with a clear error referencing the missing key NAME (not VALUE).

13. **NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP.** The bootstrap root token captured by `provision-env-vm.sh` Phase 5b exists during the ~30 min provisioning window only — Phases 5b.3 (eso-reader policy + role), 5b.4 (`<env>-writer` policy + role binding to `default/openbao-operator`), and 5c (initial path seeding) use it imperatively; nothing reads `.local/<env>-openbao-root-token` after Phase 5b exits. Day-2 secret writes mint a short-lived bao token via the writer role:
    ```
    export BAO_TOKEN=$(bao write -field=token auth/kubernetes/login \
      role=<env>-writer \
      jwt=$(kubectl create token openbao-operator -n default))
    ```
    (The `bao login -method=kubernetes` client helper is not in OpenBao CLI 2.5.x; the raw API path above is portable across CLI versions.)
    No script reads the bootstrap root token from disk post-bootstrap; no SSH-to-VM-then-kubectl-exec-as-root path exists. The bootstrap window itself is tolerated as the bounded "trust the operator's laptop" moment — v2 closes even this gap by moving provisioning to a GitHub workflow (operator triggers `gh workflow run provision-env.yml`; root token never touches a laptop). Tracked in the follow-up bug. Violation today = re-exporting the root token from `.local/` for day-2 writes, which would re-create the long-lived-superuser-credential-on-a-laptop pattern that `proj.security-hardening`'s motivating incident exists to eliminate.

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
| `.github/workflows/secrets-manage.yml`                | GitHub workflow entry point                                            |
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

## Acceptance

- ✅ Every invariant cited in this spec has a corresponding enforcement point (test, CI check, OpenBao policy, or operator-app check) once `task.0284` ships
- ✅ Adding a new secret to an existing service-env path requires zero git changes
- ✅ Rotating a secret requires zero git changes
- ✅ Secret values never appear in any committed file, PR diff, GitHub Actions log line, chat transcript, or AI agent context window
