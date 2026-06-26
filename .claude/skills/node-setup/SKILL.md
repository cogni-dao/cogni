---
name: node-setup
description: "Agentic node setup for Cogni forks. Orchestrates the full lifecycle: DAO formation, payment activation, repo identity, infrastructure provisioning, and deploy verification. Delegates to guide docs for step-by-step details."
---

# Node Setup — Agentic Fork Onboarding

You are an infrastructure setup agent. Your job: take a fresh Cogni fork from clone to **successful preview and production deployments**. Prompt the user only for credentials that require their browser.

## References (read these — they own the details)

- [Node Formation Guide](../../../docs/guides/node-formation-guide.md) — DAO deployment via wizard
- [Payment Activation Guide](../../../docs/guides/operator-wallet-setup.md) — Privy wallet + Split contract
- [SETUP_DESIGN.md](../../../scripts/setup/SETUP_DESIGN.md) — canonical secret list, personas, full setup flow
- [INFRASTRUCTURE_SETUP.md](../../../docs/runbooks/INFRASTRUCTURE_SETUP.md) — VM provisioning runbook
- [server-env.ts](../../../apps/web/src/shared/env/server-env.ts) — app runtime env schema (source of truth)
- [deploy.sh](../../../scripts/ci/deploy.sh) — deploy script required secrets

## Pre-flight

Verify: `gh auth status`, `tofu --version`, `pnpm --version`. Detect repo name from `git remote get-url origin`.

## Node Lifecycle State Machine

```
clone → formation → local env → activation → infra → deploy
         (pending)    (dev:infra)   (active)
```

Check `payments.status` in `.cogni/repo-spec.yaml` to determine current state.

### Phase 0: Formation (`payments.status` missing or no repo-spec)

**Goal:** DAO deployed on-chain, repo-spec generated.

1. Direct user to https://cognidao.org/setup/dao
2. User copies generated YAML into `.cogni/repo-spec.yaml`
3. Follow [Node Formation Guide](../../../docs/guides/node-formation-guide.md) for details
4. **Gate:** `.cogni/repo-spec.yaml` has valid `governance.chain_id` and `payments.status: pending_activation`

### Phase 1: Repo Identity

**Goal:** All template references point to this fork.

Derive `REPO_SLUG` (e.g., `my-cogni-node`) and `REPO_SNAKE` (e.g., `my_cogni_node`) from the repo name. Update:

- `package.json` → `name`
- `.cogni/repo-spec.yaml` → `intent.name`, `activity_sources.github.source_refs`
- `sonar-project.properties` → `sonar.projectKey`, `sonar.projectName`
- `.github/workflows/ci.yaml` → DB names (`REPO_SNAKE_test`)
- `.env.local.example`, `.env.test.example` → DB names

**Gate:** `pnpm check` passes.

### Phase 2: Local Environment

**Goal:** `.env.local` configured, dev stack running, database provisioned.

1. Copy `.env.local.example` → `.env.local`, update DB names and `COGNI_REPO_URL`
2. Prompt user for credentials they must create (see [SETUP_DESIGN.md](../../../scripts/setup/SETUP_DESIGN.md) for full list):

   | Secret                     | Where to create                                                                         |
   | -------------------------- | --------------------------------------------------------------------------------------- |
   | `CHERRY_AUTH_TOKEN`        | https://portal.cherryservers.com/settings/api-keys                                      |
   | `OPENROUTER_API_KEY`       | https://openrouter.ai/settings/keys                                                     |
   | `EVM_RPC_URL`              | https://dashboard.alchemy.com/apps (Base Mainnet)                                       |
   | `GHCR_DEPLOY_TOKEN`        | https://github.com/settings/tokens/new — **Classic PAT**, `read:packages` scope         |
   | `GIT_READ_TOKEN`           | https://github.com/settings/personal-access-tokens/new — Fine-grained, `Contents: Read` |
   | `OPENCLAW_GITHUB_RW_TOKEN` | https://github.com/settings/tokens/new — Classic PAT, `repo` scope                      |

3. Auto-generate: `LITELLM_MASTER_KEY`, `AUTH_SECRET`, `OPENCLAW_GATEWAY_TOKEN` via `openssl rand`
4. Start dev infrastructure: `pnpm dev:infra`
5. Provision database + run migrations: `pnpm dev:setup`
6. Start dev server: `pnpm dev`

**Gate:** `pnpm check` passes. App boots at http://localhost:3000 without DB errors.

### Phase 3: Payment Activation (`payments.status: pending_activation`)

**Goal:** Split contract deployed, payments active.

1. User adds `operator_wallet.address` to repo-spec (provision via Privy if needed — see [Payment Activation Guide](../../../docs/guides/operator-wallet-setup.md))
2. Restart dev server to pick up repo-spec changes
3. User navigates to http://localhost:3000/setup/dao/payments and deploys Split contract via browser wallet
4. User pastes the output `payments_in` + `payments.status: active` into repo-spec

**Gate:** `payments.status: active` in repo-spec, `payments_in.credits_topup.receiving_address` populated.

### Phase 4: Infrastructure (preview first, then production)

**Goal:** VMs provisioned, SSH keys generated and stored.

Follow [INFRASTRUCTURE_SETUP.md](../../../docs/runbooks/INFRASTRUCTURE_SETUP.md) for detailed steps. Key points:

1. Generate SSH keypairs, commit public keys
2. Discover Cherry project ID via API (never hardcode)
3. Create tfvars (plan: `B1-4-4gb-80s-shared` minimum)
4. `tofu init && tofu apply`
5. Wait for cloud-init (~3 min), verify Docker is running

**Gate:** SSH into VM succeeds, `docker version` works.

### Phase 5: GitHub Secrets

**Goal:** All secrets set for CI/CD deployment.

Follow the secret list in [SETUP_DESIGN.md](../../../scripts/setup/SETUP_DESIGN.md). Three categories:

1. **Auto-generated per env** — DB creds, service tokens, Temporal creds (use `openssl rand`)
2. **From .env.local** — shared credentials (OpenRouter, EVM RPC, PostHog, etc.)
3. **Repo-level** — CHERRY_AUTH_TOKEN, GHCR_DEPLOY_TOKEN, GIT_READ_TOKEN

Set `DOMAIN` as both variable and secret per environment. Ask user for domain names.

**Gate:** `gh secret list --env preview` shows all required secrets.

### Phase 6: DNS

**Goal:** Domain records point to VMs.

Ask user to create A records. Verify with `dig +short <domain>`.

### Phase 7: Deploy & Verify

**Goal:** Green CI run, app responding.

1. Merge to `main` to trigger canary promotion workflow
2. Monitor: `gh run view <id> --json status,conclusion,jobs`
3. On failure: check logs, fix, rerun
4. **Checkpoint:** Preview green → repeat Phases 4-7 for production

**Gate:** `curl -I https://<domain>/readyz` returns 200.

## Done

- [ ] Preview deployment green
- [ ] Production deployment green
- [ ] DNS resolves for both environments
- [ ] `/readyz` returns 200 on both domains

## Anti-patterns

1. **NEVER `source .env.local`** — use `grep` extraction for individual vars
2. **NEVER use fine-grained PATs for GHCR** — only Classic PATs work
3. **NEVER use 2GB VMs** — full stack requires 4GB minimum
4. **NEVER hardcode `cogni-template` names** — derive from repo name
5. **NEVER trust `/v1/regions` for auth verification** — it's public; use `/v1/teams`
