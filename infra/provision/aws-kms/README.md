<!--
SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
SPDX-FileCopyrightText: 2025 Cogni-DAO
-->

# OpenBao AWS KMS auto-unseal — per-env root-of-trust

Provisions the **off-node root-of-trust** that lets OpenBao auto-unseal on every
restart, eliminating the recurring Shamir-reseal outage (`bug.5011` / `bug.5051`)
and closing the `access-control-charter.md` CC6.1 🔴 row.

This is the **one human gate** for the whole change: it needs an AWS account.
Everything downstream (the `seal "awskms" {}` stanza, the pod env wiring) is
already in the substrate (`infra/k8s/argocd/openbao/values.yaml`) and reconciles
itself once the per-env `openbao-seal-aws` Secret exists.

## What it creates (per env, nothing more)

| Resource          | Purpose                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| 1 KMS key + alias | The unseal master-key wrapper. `enable_key_rotation = true`, 30-day delete window.    |
| 1 IAM user        | Least-privilege seal principal — `kms:Encrypt`/`Decrypt`/`DescribeKey` on THAT key.   |
| 1 IAM access key  | The credential the pod uses. Outputs `seal_access_key_id` + `seal_secret_access_key`. |

The IAM principal can do **nothing else** — no key list, no other resource, no
secret read. A stolen seal credential can only unwrap a master key it doesn't
have. That is the entire blast radius.

## Why KMS and not an OSS-native seal

See the PR body's provider-comparison table. Summary: the root-of-trust **must**
live off the k3s node or a node restart reseals it again (the exact bug).
`seal "transit"` only moves the manual-unseal SPOF to a second OpenBao (turtles)
and doubles Raft/PVC surface on an already-OOMing box; `seal "pkcs11"` + SoftHSM
is key-next-to-lock (rejected, SOC2 CC6.1). The seal **mechanism** stays 100%
OpenBao-native; only the root-of-trust is managed.

## Apply (one-time per env)

```bash
cd infra/provision/aws-kms
export AWS_REGION=us-east-1   # or your chosen region; also feeds the pod's AWS_REGION
tofu init
tofu apply -var environment=candidate-a   # repeat for preview, production

# Capture the outputs (sensitive ones never print without -raw)
KEY_ID=$(tofu output -raw kms_key_id)
REGION=$(tofu output -raw kms_region)
AKID=$(tofu output -raw seal_access_key_id)
SAK=$(tofu output -raw seal_secret_access_key)
```

Use a **separate state/workspace per env** (`tofu workspace` or a per-env
state dir) so the three keys are independently managed.

## Seed the pod Secret (provision-env-vm.sh Phase 5b)

The chart consumes a k8s Secret named `openbao-seal-aws` in the `openbao`
namespace with four keys. Create it once per env (in the cluster the env's VM
runs):

```bash
kubectl -n openbao create secret generic openbao-seal-aws \
  --from-literal=VAULT_AWSKMS_SEAL_KEY_ID="$KEY_ID" \
  --from-literal=AWS_ACCESS_KEY_ID="$AKID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$SAK" \
  --from-literal=AWS_REGION="$REGION"
```

This is the **seal-backend bootstrap credential** — the analogue of the Shamir
keys it replaces. It is the one secret that cannot live in OpenBao (it's what
unseals OpenBao), so it is held by the provisioner in `.local/` and seeded
directly. NEVER committed (Invariant 4). The integration point is
`provision-env-vm.sh` Phase 5b, immediately before the OpenBao init/unseal block
(5b.2) — the Secret must exist before `openbao-0` starts so the chart's
`extraSecretEnvironmentVars` resolve.

## Migration runbook — Shamir → auto-unseal (per env; DO NOT auto-run)

Existing vaults are Shamir-initialized. The native one-time migration is
`bao operator unseal -migrate`. Run per env, **production last**, after a Raft
snapshot. This is a deliberate operator action, not part of any deploy workflow.

1. **Snapshot first** (recovery point):
   `kubectl -n openbao exec openbao-0 -- bao operator raft snapshot save /tmp/pre-kms.snap`
   then copy it off the pod.
2. **Provision KMS + seed the Secret** (sections above) for the env.
3. **Roll the pod onto the new config.** The substrate already carries
   `seal "awskms" {}`. Because the chart uses `updateStrategy: OnDelete` and the
   substrate Argo app reads the **deploy branch** (`bug.5051`), make sure the
   `infra/k8s/argocd/openbao` change is present on `deploy/<env>` and the Secret
   exists, then `kubectl -n openbao delete pod openbao-0` to pick up the seal
   stanza. The pod restarts **sealed** (old Shamir seal, new awskms seal both
   present → migration mode).
4. **Run the migrate-unseal** with the existing Shamir key(s) (from
   `.local/<env>-openbao-init.json`). For 1-of-1:
   ```bash
   kubectl -n openbao exec openbao-0 -- \
     bao operator unseal -migrate '<unseal_keys_b64[0] from .local/<env>-openbao-init.json>'
   ```
   OpenBao reads the master key via the Shamir key, re-wraps it with KMS, and
   unseals. After this, restarts auto-unseal via KMS with no human input.
5. **Re-init recovery keys are now in play.** Post-migration, `bao operator init`
   on a fresh vault would emit `-recovery-shares`/`-recovery-threshold` keys (not
   unseal keys); for the migrated vault, keep the Shamir keys archived — they are
   no longer needed for routine unseal but document them as historical recovery
   material per your key-lifecycle policy.
6. **Bounce ESO** so the `ClusterSecretStore` clears its cached
   `InvalidProviderConfig`:
   `kubectl rollout restart deploy -l app.kubernetes.io/name=external-secrets`
7. **Verify:** `kubectl -n openbao exec openbao-0 -- bao status` shows
   `Sealed: false`, `Seal Type: awskms`, `Recovery Seal: true`. Delete the pod
   once more and confirm it comes back **unsealed with zero human action** —
   that is the whole point.

**Per-env order:** `candidate-a` → `preview` → `production`. Production only
after candidate-a and preview have each survived a delete-pod-comes-back-unsealed
test.

## Teardown / decommission

`tofu destroy -var environment=<env>` schedules the key for deletion (30-day
window) and removes the IAM principal. Do this only when the env's OpenBao is
gone — a destroyed key means a sealed vault can never auto-unseal (the recovery
keys from migration are the only fallback).
