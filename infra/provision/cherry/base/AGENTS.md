# base · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Immutable VM provisioning with SSH deploy key management, Docker/Docker Compose installation, and swap configuration for Cherry Servers infrastructure.

## Pointers

- [INFRASTRUCTURE_SETUP.md](../../../../docs/runbooks/INFRASTRUCTURE_SETUP.md): Setup guide

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
- **Env/Config keys:** `CHERRY_AUTH_TOKEN`, SSH key paths, optional `control_ssh_public_key` (public, same-fleet custodian; nonproduction only)
- **Files considered API:** `variables.tf`, `terraform.tfvars.example`

## Responsibilities

- This directory **does**: VM provisioning, SSH deploy key installation, Docker/Docker Compose bootstrap, swap provisioning via cloud-init, VM host output to GitHub secrets
- This directory **does not**: Application deployment (handled by SSH + Docker Compose from GitHub Actions)

## Usage

Minimal local commands:

```bash
tofu init
tofu plan
tofu apply
```

## Standards

- No application logic in cloud-init
- Use lifecycle ignore_changes for user_data stability
- Require SSH key configuration

## Dependencies

- **Internal:** none
- **External:** Cherry Servers API, SSH public keys

## Change Protocol

- Update this file when **VM configuration variables** change
- Bump **Last reviewed** date
- VM changes affect SSH deployment workflows

## Notes

- OpenTofu-only layer (no application concerns)
- Outputs VM host IP to GitHub Environment Secrets for SSH deployment
- See runbooks/ for setup and architecture details
