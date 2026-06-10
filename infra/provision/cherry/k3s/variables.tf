# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Ensure you separately `export CHERRY_AUTH_TOKEN=<token>`

# Environment separation (required)
variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "vm_name_prefix" {
  description = "VM name prefix (combined with environment)"
  type        = string
  default     = "cogni-k3s"
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
}

variable "ssh_private_key" {
  description = "SSH private key content for bootstrap health check. Empty to skip."
  type        = string
  default     = ""
  sensitive   = true
}

# k3s-specific config
variable "ghcr_deploy_token" {
  description = "GitHub PAT with read:packages scope for pulling private GHCR images"
  type        = string
  sensitive   = true
}

variable "ghcr_deploy_username" {
  description = "GitHub username for GHCR authentication"
  type        = string
  default     = "cogni-deploy"
}

# HONEST_ALLOCATABLE (docs/research/2026-06-10-node-app-scaling-architecture.md,
# Step 1): on a co-resident VM, k3s reports the FULL VM RAM as allocatable but
# cannot see the ~2.8 GB Compose stack (postgres/doltgres/litellm/temporal/redis/
# caddy) sharing the box — so it over-commits and node-app pods OOM/crash-loop.
# Reserving the Compose footprint via kubelet system-reserved makes the scheduler
# subtract it: over-commit becomes an honest `Pending` instead of a silent OOM.
# Default sized for the co-resident topology; an infra-split env (Step 2, no
# Compose on the app box) overrides this to a small OS-only value.
variable "system_reserved_memory" {
  description = "kubelet --system-reserved memory: non-k8s RAM on the box (Compose stack + OS) subtracted from allocatable. Co-resident default; ~256Mi for an infra-split app VM."
  type        = string
  default     = "2900Mi"
}

variable "eviction_hard_memory" {
  description = "kubelet --eviction-hard memory.available threshold: headroom before the kubelet evicts, a safety net above system-reserved."
  type        = string
  default     = "350Mi"
}
