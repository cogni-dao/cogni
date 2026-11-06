---
id: create-env-guide
type: guide
title: Create a New Environment (Deploy)
status: draft
trust: draft
summary: Stand up a whole deployment ENVIRONMENT (candidate-*, preview, production, or a fork) from zero via the provision-env.yml GitHub Actions workflow — VM, DNS, OpenBao/ESO substrate, and the node formation — plus the known perfectionist gaps in the e2e path.
read_when: Provisioning a new env slot (candidate-b/candidate-c/...), bringing up a fork, re-provisioning a dead env VM, or debugging why provision-env.yml fails before the VM is live.
owner: derekg1729
created: 2026-06-01
verified: null
tags: [deployment, infra, env, provision, gitops, openbao]
---

# Create a New Environment (Deploy)

## When to use this

You want a **whole environment** stood up from zero — a Cherry VM running k3s + Argo CD + the OpenBao/ESO secrets substrate + your node formation, reachable over HTTPS. Targets: `candidate-a`, `candidate-b`, `preview`, `production`, or a downstream **fork**.

This is the **env axis**. For the **node axis** — shipping a node across envs — see [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) (one call, `POST /api/v1/deploy/workloads`). The two compose: an env is a formation of nodes; a node is enabled across a set of envs.

> **Canonical path: the `provision-env.yml` workflow.** Never hand-provision (`pnpm bootstrap` / running `provision-env-vm.sh` on a laptop) for a real env — that puts substrate creds on a laptop (against the secrets charter). The GitHub Actions runner owns the `tofu` + `bao` + `kubectl` session; init artifacts come back passphrase-encrypted. The laptop path is debug-only.

## The flow

```
provision-env.yml  (workflow_dispatch: env, encryption_passphrase)
  └─ bootstrap.sh           Phase 1 validate · 2 gen secrets · 3 GH env+secrets · 4 →
       └─ provision-env-vm.sh   Cherry VM · DNS · OpenBao+ESO · seed paths · operator Argo apps · /readyz
  └─ encrypt + upload init artifacts (1-day GHA artifact, AES-256-CBC + passphrase)
```

`bootstrap.sh` derives the env's domain/VM-host from the catalog + `FORK_DOMAIN_ROOT`, generates the per-env app secrets, writes them to the GH environment, then delegates VM/DNS/substrate to `provision-env-vm.sh`. The full secret-by-secret walkthrough lives in [`docs/runbooks/fork-quickstart.md`](../runbooks/fork-quickstart.md) §6 — **this guide is the map; that runbook is the territory.**

## Preconditions (the per-env setup that the workflow does NOT create for you)

1. **GH environment + minting secrets.** Create the `<env>` GitHub environment and set the minting tokens. `CHERRY_AUTH_TOKEN` is repo-level (shared); the rest are per-env:
   - `CHERRY_PROJECT_ID`, `CLOUDFLARE_API_TOKEN` (scopes: **DNS:Edit + Zone Settings:Edit**), `CLOUDFLARE_ZONE_ID`, `GH_ADMIN_PAT` (a **literal** token — fine-grained or `gho_`; _not_ a `$(gh auth token)` expression), `GH_ADMIN_USERNAME`.
   - Full per-secret instructions: fork-quickstart §6.2. The _generated_ app secrets (DB passwords, `AUTH_SECRET`, tokens…) are auto-created by `bootstrap.sh` Phase 3 — don't set those by hand.
2. **`FORK_DOMAIN_ROOT`** repo variable (defaults `cognidao.org` for the hub).
3. **Cherry Servers account balance.** The VM costs money; provisioning fails mid-`tofu apply` with `Insufficient balance!` if the account is empty. Fund it first.
4. **The operator formation must exist in the repo** for the env (operator only): the operator's Argo app and overlay. Nodes need no formation here. A node app ships with `POST /api/v1/deploy/workloads` (see [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence)). A genuinely new slot name (e.g. `candidate-c`) also needs adding to the `env` choice list in `provision-env.yml`.
5. **An operator-owned passphrase** (the init-artifact encryption key — §6.3). Save it to a password manager **before** dispatch; without it the encrypted OpenBao unseal keys + kubeconfig are unrecoverable.

## Dispatch + verify

```bash
REPO=Cogni-DAO/cogni
PP=$(openssl rand -hex 24)          # save to password manager FIRST
gh workflow run provision-env.yml --repo "$REPO" -f env=candidate-b -f encryption_passphrase="$PP"
gh run watch --repo "$REPO" \
  "$(gh run list --repo "$REPO" --workflow provision-env.yml -L1 --json databaseId --jq '.[0].databaseId')" \
  --exit-status
```

Recover credentials, then verify the env is **fully operational**:

```bash
gh run download --repo "$REPO" --name candidate-b-init-artifacts --dir .local
# decrypt .local/*.enc with $PP (openssl enc -d -aes-256-cbc -pbkdf2) → kubeconfig + openbao-init.json
kubectl --kubeconfig .local/candidate-b-kubeconfig.yaml -n argocd get applications      # all Healthy
kubectl ... -n cogni-candidate-b get externalsecret                                     # all SecretSynced
kubectl ... -n cogni-candidate-b get pods                                               # Running/Ready, real image digests
curl https://canary-candidate-b.cognidao.org/readyz?deep=1                              # HTTP 200
curl https://node-template-candidate-b.cognidao.org/readyz?deep=1                       # HTTP 200
```

`/readyz?deep=1` returning 200 is the substrate bar — it transitively asserts the node consumes its OpenBao/ESO secrets (DB migrations run) **and** Temporal + scheduler-worker are reachable. (Plain `/readyz` — the k8s probe path — is intentionally non-fatal on Temporal/scheduler-worker so an async-substrate blip can't drain the fleet → 502; it alarms instead. Use `?deep=1` when you need to confirm the substrate is actually up.) Cross-check Loki (`env="candidate-b"`) for `app started` at the deployed SHA.

## Known perfectionist gaps in the e2e tooling

The `provision-env.yml` path (ported in #1426) was first exercised end-to-end on 2026-06-01 (candidate-b from zero). Doing so surfaced a stack of gaps — fixed in #1430 unless noted. They are catalogued here so the next env-bring-up is not a discovery exercise:

**Fixed (#1430):**

- `scripts/bootstrap/install/install-age.sh` was missing entirely (workflow called it → exit 127).
- `install-tofu.sh` only installed on macOS; its non-mac path warned-and-continued and checked the wrong binary name (`opentofu` vs `tofu`) → `missing prereq: tofu`. (Audit the other `install/*.sh` for the same laptop-only assumption.)
- `provision-env-vm.sh` blocked on an interactive `read` for the optional OpenRouter key → EOF aborted the non-TTY runner. Now skipped under `CI`/non-TTY. (Audit remaining interactive `read`s for the same.)
- **ESO webhook race** — Phase 5b.5 applied the ClusterSecretStore the instant the external-secrets Argo app reported Succeeded, before its admission webhook had ready endpoints → flaky `no endpoints available for service "external-secrets-webhook"`. Now waits for the webhook rollout + endpoints first (deterministic).

**Cloudflare scope is a hard precondition (matches node-template — the proven impl).** `bootstrap.sh` Phase 1 + `provision-env-vm.sh` Phase 4b both **hard-fail** if `CLOUDFLARE_API_TOKEN` lacks `Zone:Zone Settings:Edit` (needed to set zone SSL mode → `Full`). A DNS:Edit-only token (HTTP 403 on `/settings/ssl`) aborts before the VM is touched. Mint a token with **DNS:Edit + Zone Settings:Edit** on the zone and set it as the env's `CLOUDFLARE_API_TOKEN` secret (fork-quickstart §6.2).

**Open debt (not blocking, worth closing):**

- **Per-env minting secrets are manual.** Hub-wide creds (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `GH_ADMIN_*`, `CHERRY_PROJECT_ID`) are identical across `candidate-*` yet set per-env; only `CHERRY_AUTH_TOKEN` is repo-level. Promoting the constant ones to repo-level would eliminate the per-env re-entry step for future slots.
- **`GH_ADMIN_PAT` laptop placeholder.** The committed `.env.bootstrap` template uses `$(gh auth token)` — a local convenience that cannot be stored in a GH secret. Fork/env operators must supply a literal token; the trap is silent (it stores the literal string and breaks `.env.bootstrap` sourcing on the runner).
- **Ephemeral runner tofu state.** No remote backend (`infra/provision/cherry/base/main.tf` has the backend commented out) → each run starts with empty state; a failed `tofu apply` after the SSH-key resource is created leaves an **orphaned Cherry SSH key** per failed run. Wants a remote backend (or a pre-apply orphan sweep).
- **No Cherry balance pre-flight.** Balance is only discovered _during_ `tofu apply`, after side effects (SSH key created). A pre-flight balance probe (like the Cloudflare/Cherry-token probes) would fail fast at zero side-effect.
- **Manual passphrase.** v-next (per `proj.agentic-fork-bootstrap`): once a **parent OpenBao** exists, replace encrypt+upload-with-passphrase with `vault-action` pushes — no operator passphrase.
- **New slot ≠ one-line.** A brand-new env name still requires editing the `provision-env.yml` `env` choice. Nodes need no per-env formation: they ship with `POST /api/v1/deploy/workloads`. Formation-driven generation is tracked in `task.5097` (env-as-formation list generator) + `task.5098` (generate overlays/ExternalSecrets).

## See also

- [`docs/runbooks/fork-quickstart.md`](../runbooks/fork-quickstart.md) — the per-secret walkthrough (§6) + init-artifact custody (§6.3, §6.5).
- [`.claude/skills/cicd-secrets-expert/SKILL.md`](../../.claude/skills/cicd-secrets-expert/SKILL.md) — where each secret value lives (tier system + OpenBao paths).
- [`.claude/skills/devops-expert/SKILL.md`](../../.claude/skills/devops-expert/SKILL.md) — CI/CD architecture + provisioning arsenal.
- [`work/projects/proj.cicd-services-gitops.md`](../../work/projects/proj.cicd-services-gitops.md) — the GitOps provisioning project this guide serves.
