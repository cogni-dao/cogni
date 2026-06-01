# setup · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Setup automation for contributor, fork, and deployment bootstrap paths.

## Pointers

- [SETUP_DESIGN.md](./SETUP_DESIGN.md): Future architecture and implementation plan
- [README.md](../../README.md): Current manual setup instructions

## Boundaries

```json
{
  "layer": "scripts",
  "may_import": ["scripts"],
  "must_not_import": [
    "app",
    "features",
    "core",
    "adapters/server",
    "adapters/worker",
    "adapters/cli"
  ]
}
```

## Public Surface

- **Exports:** none
- **CLI (if any):** `pnpm bootstrap`, `bash scripts/setup/provision-env-vm.sh <preview|production|candidate-*> [--yes]`
- **Env/Config keys:** `DEPLOY_ENV`, `FORK_DOMAIN_ROOT`, `CHERRY_AUTH_TOKEN`, `CHERRY_PROJECT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `GITHUB_ADMIN_PAT`, `GITHUB_ADMIN_USERNAME`
- **Files considered API:** `bootstrap.sh`, `provision-env-vm.sh`, `lib/fork-identity.sh`, `lib/cogni-deployment-identity.sh`, `lib/reconcile-secrets.sh`

## Responsibilities

- This directory **does**: Automate bootstrap/provisioning, derive deployment identity, reconcile bootstrap secrets
- This directory **does not**: Contain runtime app code or business logic

## Usage

**Current:**

```bash
pnpm bootstrap
bash scripts/setup/provision-env-vm.sh candidate-b --yes
```

**Planned:**

```bash
pnpm setup local     # Local development setup
pnpm setup infra     # Infrastructure provisioning
pnpm setup github    # GitHub environments + secrets
pnpm setup dao       # DAO contract deployment
```

## Standards

- Follow existing script conventions in `scripts/bootstrap/install/*`
- Use bash for provisioning wrappers that need direct CLI orchestration
- All operations must be idempotent (safe to re-run)
- Clear error messages with actionable next steps

## Dependencies

- **Internal:** `infra/provision/cherry/base/`, `infra/k8s/`, `scripts/ci/lib/image-tags.sh`
- **External:** GitHub CLI, OpenTofu, Cloudflare API, Cherry Servers API, OpenBao/ESO CLIs through cluster bootstrap

## Change Protocol

- Update this file when actual implementation begins
- Keep workflow wrappers and local bootstrap paths behaviorally aligned
- Bump **Last reviewed** date when implementation changes

## Notes

- `bootstrap.sh` is the human/runner entry point; `provision-env-vm.sh` owns VM, DNS, OpenBao/ESO, Argo, and readyz proof.
