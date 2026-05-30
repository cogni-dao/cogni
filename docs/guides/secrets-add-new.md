---
id: secrets-add-new-guide
type: guide
title: Add a New Secret to a Service
status: draft
trust: draft
summary: How to add a new secret to a Cogni service-env path. Spoiler — it's one CLI command. No pod spec edit, no kustomize edit, no YAML PR.
read_when: A developer or agent needs to add a new secret (e.g., a new API key for a service to consume).
owner: derekg1729
created: 2026-05-19
verified: 2026-05-19
tags:
  - secrets
  - guides
---

# Add a New Secret to a Service

> Adding a secret is a control-plane operation, not a YAML rewrite. If you find yourself editing a pod spec or an ExternalSecret YAML, you're doing it wrong — come back here.

## Prereq — get a short-lived OpenBao token

The CLI talks to OpenBao via `BAO_ADDR` + `BAO_TOKEN`. Three copy-paste lines (substitute `<env>`):

```bash
# 1. Open a tunnel to the OpenBao service.
kubectl port-forward -n openbao svc/openbao 8200:8200 &
export BAO_ADDR=http://127.0.0.1:8200

# 2. Authenticate as the openbao-operator SA. provision-env-vm.sh Phase 5b.4
#    bound a `<env>-writer` role to this SA; the JWT below is exchanged for a
#    1h bao token scoped to cogni/<env>/* writes only.
#    NOTE: `bao login -method=kubernetes` is NOT in OpenBao CLI 2.5.x. The raw
#    API path below works across all CLI versions.
export BAO_TOKEN=$(bao write -field=token auth/kubernetes/login \
  role=<env>-writer \
  jwt=$(kubectl create token openbao-operator -n default))
```

**Never `cat .local/<env>-openbao-root-token`** into `BAO_TOKEN`. The bootstrap root token is captured during the ~30 min provisioning window only — Phase 5b.4 binds the writer role specifically so day-2 writes never need that token. Reading it from disk would re-create the long-lived-superuser-credential-on-a-laptop pattern that [`proj.security-hardening`](../../work/projects/proj.security-hardening.md) exists to eliminate. Spec: [Invariant 13 NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP](../spec/secrets-management.md).

## The write

```bash
pnpm secrets:set candidate-a node-template OPENAI_API_KEY
# Prompts for value via secure stdin (never echoes, never enters shell history)
```

Done. The CLI writes to OpenBao at `cogni/candidate-a/node-template`, key `OPENAI_API_KEY`. ESO pulls on the next refresh (default 1h; can be forced — see below). Stakater Reloader detects the k8s Secret change and triggers a rolling pod restart. The new env var `OPENAI_API_KEY` is available to the pod after restart.

**If your CODE needs to read the new value:** that's still a normal PR — your code change (`process.env.OPENAI_API_KEY`, or your typed-config schema) goes through CI like any other code. But the SECRET itself does not require a PR.

## What you didn't have to do

- Edit `infra/k8s/secrets/external-secrets/candidate-a/node-template/external-secret.yaml` (the ExternalSecret already pulls every key at the path)
- Edit `infra/k8s/base/node-app/deployment.yaml` (the pod's `envFrom: secretRef` already pulls every key from the synced k8s Secret)
- Run `kubectl` anything (Argo reconciles + ESO syncs + Reloader restarts)
- Touch the `OPENBAO_SEED_TOKEN` in GitHub env secrets (that's an automated path; you never touch it)

This is the contract from [`docs/spec/secrets-management.md`](../spec/secrets-management.md), enforced by ESO's `dataFrom: extract` pattern (one ExternalSecret per service-env, pulls all keys; published canonical pattern: [ESO docs](https://external-secrets.io/latest/api/externalsecret/#external-secrets.io/v1.ExternalSecretDataFromRemoteRef)).

## Entry points

| Context                          | Entry                                                                                                                                                                                         | Status                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer / operator at terminal | `pnpm secrets:set <env> <service> <KEY>` (this guide)                                                                                                                                         | **Shipped.** Requires caller-provided `BAO_ADDR` + short-lived `BAO_TOKEN` (see Prereq).                                                                              |
| Operator / on-call ops           | `.github/workflows/secrets-manage.yml` → workflow_dispatch (GH OIDC → OpenBao via [`hashicorp/vault-action`](https://github.com/hashicorp/vault-action); env-protection-gated for production) | **Deferred** — canonical operator path once it ships. Tracked in the follow-up bug under [`proj.security-hardening`](../../work/projects/proj.security-hardening.md). |
| AI agent (via operator MCP)      | `secret.declare` tool → human fills value via one-time URL                                                                                                                                    | Out of scope for node-template (operator monorepo construct).                                                                                                         |

All paths call the same OpenBao primitive (`bao kv put`/`patch`). You don't choose which OpenBao call happens; you choose which interface fits your context. **Today there is one shipped path: the CLI with a caller-provided short-lived token.**

## Per-env behavior

| Env           | Approval gate                                                                                                                                                             | Notes                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `candidate-a` | None (forker self-approves; experiment slot)                                                                                                                              | Use the CLI with a token bound to a `candidate-a-writer` role |
| `preview`     | OpenBao policy rejects writes from any role except `preview-writer`                                                                                                       | Same CLI; the token's policy is the gate                      |
| `production`  | OpenBao policy rejects writes from any role except `production-writer`; once `secrets-manage.yml` ships, GitHub environment-protection adds a per-write reviewer approval | Same CLI today; switch to workflow_dispatch when it lands     |

The candidate-a slack is intentional — it's the experiment slot. The preview/production lockdown is the SOC 2 CC6.1 / CC8.1 boundary.

## Operator role binding

The Kubernetes auth role `<env>-writer` is bound by `provision-env-vm.sh` Phase 5b.4 during bootstrap, alongside the read-only `eso-reader` role (Phase 5b.3). Both bindings:

| Role           | Bound SA                                               | Policy paths                                                                                     | TTL |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --- |
| `eso-reader`   | `external-secrets/external-secrets` (ESO controller)   | `cogni/data/*`, `cogni/metadata/*` — read across all envs                                        | 1h  |
| `<env>-writer` | `default/openbao-operator` (operator's ServiceAccount) | `cogni/data/<env>/*`, `cogni/metadata/<env>/*` — read + create + update + patch on THIS env only | 1h  |

No `delete` capability on writer; destroy requires admin escalation per spec Invariant 6 / CC6.1.

If the role binding is missing (re-provision skipped a phase, or you're on a pre-task.0284 cluster), the cluster admin re-runs the Phase 5b.4 stanza manually using the captured init artifact (`.local/<env>-openbao-init.json`). After Phase 5b completes, the root token is never needed again.

## Cross-service or system secrets

If a secret needs to be shared across services (e.g., `OPENROUTER_API_KEY` consumed by multiple services), put it at `cogni/<env>/_shared`. Each consuming service explicitly references the shared path in its ExternalSecret via a SECOND `dataFrom: extract` entry — this is the one case where the per-service ExternalSecret has more than one extract line. Document the shared-key dependency in the service's `AGENTS.md`.

System-level bootstrap secrets (Cherry token, Cloudflare token, GH PAT, OpenBao root + unseal keys) live in GitHub Environment secrets + `.local/<env>-openbao-init.json` — written ONCE during `pnpm bootstrap` (see [`docs/runbooks/fork-quickstart.md`](../runbooks/fork-quickstart.md) Step 6 + 6.5). **Never set them via this guide.** Substrate-token rotation is documented in [`secrets-rotate.md`](./secrets-rotate.md#substrate-token-rotation-root-token--unseal-keys).

## Forcing immediate sync (for impatient developers)

```bash
kubectl annotate externalsecret <service>-env-secrets \
  force-sync=$(date +%s) --overwrite -n <namespace>
# ESO syncs on next reconcile (seconds, not the configured 1h)
# Reloader picks up the Secret change and restarts the pod
```

Don't make this a habit. The 1h refresh interval is a feature — it bounds OpenBao read pressure. Use force-sync for the immediate post-`set` validation, then leave the interval alone.

## What if the secret is `OPENAI_API_KEY` and the code is `const apiKey = process.env.OPENAI_API_KEY`?

Both halves happen, in either order:

1. **Code PR**: add `process.env.OPENAI_API_KEY` to your typed config / Zod schema; consume it where needed. Goes through CI like any feature.
2. **Secret write**: `pnpm secrets:set candidate-a node-template OPENAI_API_KEY` (interactive).

Order doesn't matter:

- Write secret first → pod restart picks up env var → your code starts consuming on next deploy
- Deploy code first → env var is `undefined` until secret is written → write secret → next pod restart has it

The code MUST fail fast at startup if a required secret is missing (don't return `undefined` from `process.env.X` and silently malfunction). Reference: `docs/spec/secrets-management.md § TRANSITION_SAFE`.

## Anti-patterns this guide assumes you won't do

- Hardcode the value in a Kubernetes Secret YAML and commit it
- Add a `valueFrom: secretKeyRef` line to the pod spec per new secret (forces a pod spec edit per secret; wrong shape — see `spec.secrets-management § POD_CONSUMES_VIA_ENVFROM`)
- Create a per-secret ExternalSecret YAML (forces a YAML edit per secret; wrong shape — see `spec.secrets-management § ONE_EXTERNAL_SECRET_PER_SERVICE_ENV`)
- Use `bao kv put` (replaces ALL keys at the path; use `bao kv patch` instead — but the CLI handles this for you)
- Paste the secret value into a chat / commit message / PR description
- Skip the tooling for production-env writes "just this once"

## What the CLI does under the hood

`scripts/secrets/set-secret.sh`:

1. Validates `<env>` ∈ {candidate-a, preview, production}.
2. Validates `<service>` matches a `infra/catalog/<service>.yaml` entry (or `_shared`; refuses `_system`).
3. Validates `<KEY>` matches `^[A-Z][A-Z0-9_]*$`.
4. Reads value from stdin (interactive `read -s` if a TTY; pipe otherwise). Never echoes.
5. Requires `BAO_ADDR` + `BAO_TOKEN` from the environment. Dies with a port-forward + `bao login` recipe if either is missing.
6. Checks if the path already exists via `bao kv metadata get`. If not → `bao kv put` (creates the path). If yes → `bao kv patch` (preserves sibling keys, adds a new version).
7. Passes the value via `KEY=-` stdin so it never enters argv (`ps` is clean).

No `--immediate` flag yet — force-sync is a separate `kubectl annotate` step (see below).

Tests at [`scripts/ci/tests/set-secret.test.sh`](../../scripts/ci/tests/set-secret.test.sh) (12 fixture cases via the `$SET_SECRET_BAO` test shim).

## Related

- [`docs/spec/secrets-management.md`](../spec/secrets-management.md) — the canonical contract
- [`docs/guides/secrets-rotate.md`](./secrets-rotate.md) — rotation playbook
- [`docs/runbooks/fork-quickstart.md`](../runbooks/fork-quickstart.md) — bootstrap flow (substrate install + unseal + role bind happen here)
- [External Secrets Operator `dataFrom` docs](https://external-secrets.io/latest/api/externalsecret/#external-secrets.io/v1.ExternalSecretDataFromRemoteRef)
- [OpenBao KV v2 docs](https://openbao.org/docs/secrets/kv/kv-v2/)
- [Stakater Reloader](https://github.com/stakater/Reloader)
