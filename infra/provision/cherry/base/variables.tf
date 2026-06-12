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
  default     = "https://github.com/Cogni-DAO/cogni.git"
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
variable "system_reserved_memory" {
  description = "kubelet system-reserved memory: non-k8s RAM on the box (Compose + OS) subtracted from allocatable. Co-resident default; ~256Mi for an infra-split app VM."
  type        = string
  default     = "2900Mi"
}

variable "eviction_hard_memory" {
  description = "kubelet eviction-hard memory.available threshold: headroom before the kubelet evicts, a safety net above system-reserved."
  type        = string
  default     = "350Mi"
}

