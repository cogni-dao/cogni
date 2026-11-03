# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0

# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Secrets Management — SOPS + age

Secrets are encrypted at rest in git using [SOPS](https://github.com/getsops/sops) with [age](https://github.com/FiloSottile/age) encryption. Decrypted at apply time by ksops (Argo CD sidecar CMP).

## Setup (one-time per environment)

### 1. Generate age keypair

```bash
# Install age
brew install age  # macOS
# or: apt install age  # Ubuntu

# Generate keypair (one per environment)
age-keygen -o staging-age-key.txt
age-keygen -o production-age-key.txt
```

### 2. Update .sops.yaml

Copy the public key (starts with `age1...`) from each key file into `.sops.yaml` under the matching `path_regex` rule.

### 3. Store private key in cluster

```bash
# Create K8s secret with the age private key (ksops reads this)
kubectl -n argocd create secret generic sops-age-key \
  --from-file=keys.txt=staging-age-key.txt

# Delete local private key file after storing in cluster
rm staging-age-key.txt
```

### 4. Configure ksops sidecar

ksops runs as a sidecar container on the Argo CD repo-server. It reads the age private key from the `sops-age-key` K8s Secret and decrypts `.enc.yaml` files before Argo CD applies them.

See the [ksops documentation](https://github.com/viaduct-ai/kustomize-sops) for the sidecar CMP configuration (added to Argo CD install during task.0149).

## Encrypting secrets

```bash
# Create a plain K8s Secret YAML, then encrypt it
sops --encrypt --in-place secrets/staging/scheduler-worker.enc.yaml
```

## Rotating secrets

1. Edit the encrypted file: `sops secrets/staging/scheduler-worker.enc.yaml`
2. Change the secret values (SOPS decrypts in-place for editing)
3. Save — SOPS re-encrypts automatically
4. Commit and push — Argo CD syncs the new encrypted file
5. ksops decrypts at apply time — pods get updated secrets

## GHCR registry auth

None. Cogni images on GHCR are public, so the k3s `registries.yaml` holds mirrors only and no credential (bug.5563). A stale credential gets 403 even on a public image.
