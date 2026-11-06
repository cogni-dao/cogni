# cherry · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Cherry Servers cloud provider configurations split between immutable VM provisioning and mutable app deployments.

## Pointers

- [base/](base/): VM provisioning and static bootstrap (Docker + Compose)
- [k3s/](k3s/): VM provisioning with k3s + age for GitOps deployment

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none
- **Env/Config keys:** `CHERRY_AUTH_TOKEN`
- **Files considered API:** `base/variables.tf`, `app/variables.tf`, `k3s/variables.tf`

## Responsibilities

- This directory **does**: Define Cherry Servers infrastructure and deployment configurations
- This directory **does not**: Contain application logic or business rules

## Usage

Minimal local commands:

```bash
cd base && tofu init && tofu plan
cd app && tofu apply
cd k3s && tofu init && tofu validate
```

## Standards

- Split between base/ (immutable VM + Docker), k3s/ (immutable VM + k3s), and app/ (mutable deployment)
- Use SSH for app deployments, not cloud-init
- Health gates required for all deployments
- k3s module uses `templatefile()` for cloud-init; no GHCR credential (images are public, bug.5563)

## Dependencies

- **Internal:** `../../files/scripts/`, Caddyfile templates
- **External:** Cherry Servers API, OpenTofu

## Change Protocol

- Update this file when **variable schemas** change
- Bump **Last reviewed** date
- Update terraform.tfvars.example when new variables added

## Notes

- Base creates VM with static OS bootstrap only (Docker + Compose)
- k3s creates VM with k3s, age, and registry mirrors only, no GHCR auth (Argo CD install deferred to task.0149)
- App handles container deployment over SSH with health validation
