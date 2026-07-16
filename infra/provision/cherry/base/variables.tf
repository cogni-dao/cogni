# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Ensure you separately `export CHERRY_AUTH_TOKEN=<token>`

# Environment separation (required)
variable "environment" {
  description = "Environment name (preview, prod)"
  type        = string
}

variable "vm_name_prefix" {
  description = "VM name prefix (combined with environment)"
  type        = string
}

# Cherry Servers config (required)
variable "project_id" {
  description = "Cherry Servers project ID"
  type        = string
}

variable "plan" {
  description = "Server plan slug"
  type        = string
}

variable "region" {
  description = "Deployment region"
  type        = string
}

variable "public_key_path" {
  description = "Path to SSH public key"
  type        = string
  # No default - specified in env.*.tfvars
}

variable "ssh_private_key" {
  description = "SSH private key content for bootstrap health check. Empty to skip."
  type        = string
  default     = ""
  sensitive   = true
}

# GHCR registry auth for k3s to pull private images
variable "ghcr_deploy_username" {
  description = "GitHub username for GHCR registry auth (k3s)"
  type        = string
  default     = "Cogni-1729"
}

variable "ghcr_deploy_token" {
  description = "GitHub PAT for GHCR registry auth (k3s)"
  type        = string
  sensitive   = true
}

# Repo reference for Argo CD bootstrap (clone manifests during cloud-init)
variable "cogni_repo_url" {
  description = "Git repo URL for Argo CD manifest clone"
  type        = string
  default     = "https://github.com/cogni-dao/cogni.git"
}

variable "cogni_repo_ref" {
  description = "Git branch/ref to clone for Argo CD manifests"
  type        = string
  default     = "main"
}

# SOPS/age private key for Argo CD secret decryption.
# Generated once: age-keygen -o age-key.txt
# Public key → .sops.yaml in repo. Private key → this variable.
variable "sops_age_private_key" {
  description = "Age private key for SOPS decryption (starts with AGE-SECRET-KEY-)"
  type        = string
  sensitive   = true
}

# HONEST_ALLOCATABLE (docs/research/2026-06-10-node-app-scaling-architecture.md,
# Step 1): co-resident VMs run k3s + the ~2.8GB Compose stack on one box; k3s
# can't see Compose's RAM, so it over-commits node-app pods → OOM. system-reserved
# subtracts the Compose+OS footprint from allocatable so the scheduler stops
# over-committing. Co-resident default; an infra-split app VM overrides it low.
# Sizing (measured 2026-07-16 on prod + candidate-a, 6GB shared VM):
# the co-resident Compose stack actually uses ~600MiB (temporal/doltgres/litellm/
# postgres/alloy/...), NOT the ~2.8GB the old 2900Mi default assumed. The minimal
# fleet (operator + poly/beacon/node-template + scheduler-worker×2 + argocd/openbao/
# ESO/coredns) requests ~2732Mi. The old 2900Mi reservation drove allocatable to
# 2671Mi < 2732Mi → the operator went Pending and cognidao.org 502'd. Reserve 1800Mi
# (3× measured Compose + OS + growth headroom) → allocatable ~3921Mi > fleet 2732Mi
# with ~1.2GB surge headroom, and still honest so the box can't over-commit into the
# Compose working set (the 2026-07-16 fleet-502 mode).
variable "system_reserved_memory" {
  description = "kubelet system-reserved memory: non-k8s RAM on the box (Compose + OS) subtracted from allocatable. Co-resident default sized to measured Compose+OS; ~256Mi for an infra-split app VM."
  type        = string
  default     = "1800Mi"
}

variable "eviction_hard_memory" {
  description = "kubelet eviction-hard memory.available threshold: headroom before the kubelet evicts, a safety net above system-reserved."
  type        = string
  default     = "200Mi"
}

