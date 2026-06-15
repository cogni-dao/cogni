---
id: secret-rotation-runbook
type: guide
title: Secret Rotation Runbook
status: active
trust: reviewed
summary: Complete enumeration of GitHub Secrets, rotation procedures, and current status after the 2026-03-24 rotation.
read_when: Rotating secrets, onboarding a new node, or auditing credential hygiene.
owner: derekg1729
created: 2026-03-24
verified: 2026-03-24
tags: [security, ops, secrets]
---

# Secret Rotation Runbook

All production secrets are stored in **GitHub Actions Secrets** (`cogni-dao/cogni`) and injected into the deploy script at CI time. The deploy script SSHes them to the server — no secrets file is written to disk or uploaded as an artifact.

## Rotation Status (2026-03-24)

| Status  | Meaning                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------ |
| ROTATED | Fresh value set 2026-03-24                                                                       |
| STALE   | Old value, needs rotation from external dashboard                                                |
| MISSING | Referenced in workflows but not set — deploy will use empty string (optional) or fail (required) |
| N/A     | Auto-provided by GitHub or set at deploy time                                                    |

## Required Secrets (deploy fails without these)

These are validated by `scripts/ci/deploy.sh` — missing = hard failure.

| Secret                     | Required                 | Rotated By                                                                                                                                         | Status  | Action                                                    |
| -------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `AUTH_SECRET`              | Yes                      | Agent: `openssl rand -base64 32`                                                                                                                   | ROTATED | —                                                         |
| `LITELLM_MASTER_KEY`       | Yes                      | Agent: `openssl rand -hex 24` (prefixed `sk-cogni-`)                                                                                               | ROTATED | —                                                         |
| `OPENROUTER_API_KEY`       | Yes                      | Human: [OpenRouter Keys](https://openrouter.ai/keys)                                                                                               | MISSING | Create key, then `gh secret set OPENROUTER_API_KEY`       |
| `EVM_RPC_URL`              | Yes                      | Human: [Alchemy Dashboard](https://dashboard.alchemy.com/) → Apps → Create App (Base mainnet) → API Key                                            | MISSING | Copy full URL, then `gh secret set EVM_RPC_URL`           |
| `OPENCLAW_GATEWAY_TOKEN`   | Yes                      | Agent: `openssl rand -base64 32`                                                                                                                   | ROTATED | —                                                         |
| `OPENCLAW_GITHUB_RW_TOKEN` | Yes                      | Human: [GitHub PAT](https://github.com/settings/tokens?type=beta) → Fine-grained → Contents:Write + Pull requests:Write, scoped to cogni-dao repos | STALE   | Regenerate, then `gh secret set OPENCLAW_GITHUB_RW_TOKEN` |
| `POSTHOG_API_KEY`          | Yes                      | Human: [PostHog](https://us.posthog.com/settings/project#variables) → Project Settings → Project API Key                                           | MISSING | Copy key, then `gh secret set POSTHOG_API_KEY`            |
| `POSTHOG_HOST`             | Yes                      | Human: PostHog instance URL (e.g. `https://us.i.posthog.com`)                                                                                      | MISSING | `gh secret set POSTHOG_HOST`                              |
| `DATABASE_URL`             | Yes                      | Agent (on fresh deploy): auto-derived from DB credentials below                                                                                    | MISSING | Set after choosing DB passwords (see Database section)    |
| `DATABASE_SERVICE_URL`     | Yes                      | Agent (on fresh deploy): auto-derived from DB credentials below                                                                                    | MISSING | Set after choosing DB passwords (see Database section)    |
| `POSTGRES_ROOT_USER`       | Yes                      | Convention: `postgres`                                                                                                                             | MISSING | `echo postgres \| gh secret set POSTGRES_ROOT_USER`       |
| `POSTGRES_ROOT_PASSWORD`   | Yes                      | Agent: `openssl rand -base64 24`                                                                                                                   | MISSING | Deferred (user requested skip DB passwords)               |
| `APP_DB_USER`              | Yes                      | Convention: `app_user`                                                                                                                             | MISSING | `echo app_user \| gh secret set APP_DB_USER`              |
| `APP_DB_PASSWORD`          | Yes                      | Agent: `openssl rand -base64 24`                                                                                                                   | MISSING | Deferred                                                  |
| `APP_DB_SERVICE_USER`      | Yes                      | Convention: `app_service`                                                                                                                          | MISSING | `echo app_service \| gh secret set APP_DB_SERVICE_USER`   |
| `APP_DB_SERVICE_PASSWORD`  | Yes                      | Agent: `openssl rand -base64 24`                                                                                                                   | MISSING | Deferred                                                  |
| `APP_DB_NAME`              | Yes                      | Convention: `cogni_template`                                                                                                                       | MISSING | `echo cogni_template \| gh secret set APP_DB_NAME`        |
| `TEMPORAL_DB_USER`         | Yes                      | Convention: `temporal`                                                                                                                             | MISSING | Deferred                                                  |
| `TEMPORAL_DB_PASSWORD`     | Yes                      | Agent: `openssl rand -base64 24`                                                                                                                   | MISSING | Deferred                                                  |
| `DOMAIN`                   | Yes                      | Human: your server's domain                                                                                                                        | MISSING | `gh secret set DOMAIN`                                    |
| `VM_HOST`                  | Yes                      | Human: server IP or hostname                                                                                                                       | MISSING | `gh secret set VM_HOST`                                   |
| `SSH_DEPLOY_KEY`           | Yes                      | Agent: `ssh-keygen -t ed25519`                                                                                                                     | ROTATED | Add pubkey to server (see below)                          |
| `GHCR_DEPLOY_TOKEN`        | Yes (remote docker pull) | Human: [GitHub PAT](https://github.com/settings/tokens?type=beta) → Fine-grained → Packages:Read, scoped to cogni-dao                              | STALE   | Regenerate, then `gh secret set GHCR_DEPLOY_TOKEN`        |

### SSH Public Keys (add to servers)

Generated 2026-03-24. Add ALL THREE to `~/.ssh/authorized_keys` on each deploy target:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIU5z+tlIqbi+J9rLVmZW/hO9obJx/qHGKAfr0rWfunP cogni-deploy-20260324
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA2mSFobmuOilPaV9zuIWzqN0sMMowAvRhE4O0DswPwD cogni-deploy-preview-20260324
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOGrvjgWUxw5xVvECJJIFvEJcimrBxZfGwlDzM1jDWkX cogni-deploy-production-20260324
```

Secrets are set at three levels: **repo** (fallback), **preview** (staging deploys), and **production**. Each environment has its own SSH key and its own values for all rotatable secrets.

### Database Secrets

Database credentials are deferred. When ready to set them:

```bash
# Generate all DB passwords at once
ROOT_PW=$(openssl rand -base64 24)
APP_PW=$(openssl rand -base64 24)
SVC_PW=$(openssl rand -base64 24)
TEMP_PW=$(openssl rand -base64 24)

# Set credentials
echo postgres | gh secret set POSTGRES_ROOT_USER --repo cogni-dao/cogni
echo "$ROOT_PW" | gh secret set POSTGRES_ROOT_PASSWORD --repo cogni-dao/cogni
echo app_user | gh secret set APP_DB_USER --repo cogni-dao/cogni
echo "$APP_PW" | gh secret set APP_DB_PASSWORD --repo cogni-dao/cogni
echo app_service | gh secret set APP_DB_SERVICE_USER --repo cogni-dao/cogni
echo "$SVC_PW" | gh secret set APP_DB_SERVICE_PASSWORD --repo cogni-dao/cogni
echo cogni_template | gh secret set APP_DB_NAME --repo cogni-dao/cogni
echo temporal | gh secret set TEMPORAL_DB_USER --repo cogni-dao/cogni
echo "$TEMP_PW" | gh secret set TEMPORAL_DB_PASSWORD --repo cogni-dao/cogni

# Construct DSNs (adjust host:port for your server)
DB_HOST="postgres"  # Docker service name
echo "postgresql://app_user:${APP_PW}@${DB_HOST}:5432/cogni_template" | gh secret set DATABASE_URL --repo cogni-dao/cogni
echo "postgresql://app_service:${SVC_PW}@${DB_HOST}:5432/cogni_template" | gh secret set DATABASE_SERVICE_URL --repo cogni-dao/cogni
```

## Internal Service Tokens (required, agent-generated)

All rotated 2026-03-24. These authenticate service-to-service calls within the deploy.

| Secret                 | Purpose                                    | Status  |
| ---------------------- | ------------------------------------------ | ------- |
| `SCHEDULER_API_TOKEN`  | scheduler-worker → internal graph API      | ROTATED |
| `BILLING_INGEST_TOKEN` | LiteLLM callback → billing ingest endpoint | ROTATED |
| `INTERNAL_OPS_TOKEN`   | deploy trigger → governance schedule sync  | ROTATED |
| `METRICS_TOKEN`        | Prometheus scrape → /api/metrics           | ROTATED |
| `GH_WEBHOOK_SECRET`    | GitHub webhook HMAC verification           | ROTATED |

## CI / Automation Tokens

| Secret                       | Purpose                                   | Rotated By                                                                                                                    | Status                                        | Action                                                      |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `ACTIONS_AUTOMATION_BOT_PAT` | Cross-repo workflow dispatch, release PRs | Human: [GitHub PAT](https://github.com/settings/tokens?type=beta) → Fine-grained → Actions:Write + Contents:Write + PRs:Write | STALE                                         | Regenerate, then `gh secret set ACTIONS_AUTOMATION_BOT_PAT` |
| `GIT_READ_TOKEN`             | git-sync container clones repo            | Human: [GitHub PAT](https://github.com/settings/tokens?type=beta) → Fine-grained → Contents:Read                              | STALE                                         | Regenerate, then `gh secret set GIT_READ_TOKEN`             |
| `SONAR_TOKEN`                | SonarCloud static analysis in CI          | Human: [SonarCloud](https://sonarcloud.io/account/security) → Generate Token                                                  | MISSING (deleted accidentally, needs restore) | Create token, then `gh secret set SONAR_TOKEN`              |

## Optional Feature Secrets (deploy succeeds without these)

Deploy uses `${VAR:-}` fallback — empty = feature disabled.

### GitHub App (PR Review Bot)

| Secret                             | Rotated By                                                                  | Status  | Action                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `GH_REVIEW_APP_ID`                 | Human: [GitHub Apps](https://github.com/settings/apps) → your app → App ID  | MISSING | `gh secret set GH_REVIEW_APP_ID`                                          |
| `GH_REVIEW_APP_PRIVATE_KEY_BASE64` | Human: GitHub App → General → Generate private key → `base64 -w0 < key.pem` | MISSING | Generate, base64 encode, `gh secret set GH_REVIEW_APP_PRIVATE_KEY_BASE64` |

### OAuth Providers (login + account linking)

| Secret                        | Rotated By                                                                                              | Status  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| `GH_OAUTH_CLIENT_ID`          | Human: [GitHub OAuth Apps](https://github.com/settings/developers) → your app                           | MISSING |
| `GH_OAUTH_CLIENT_SECRET`      | Human: same page → Generate new client secret                                                           | MISSING |
| `DISCORD_OAUTH_CLIENT_ID`     | Human: [Discord Developer Portal](https://discord.com/developers/applications) → your app → OAuth2      | MISSING |
| `DISCORD_OAUTH_CLIENT_SECRET` | Human: same page                                                                                        | MISSING |
| `GOOGLE_OAUTH_CLIENT_ID`      | Human: [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth 2.0 Client IDs | MISSING |
| `GOOGLE_OAUTH_CLIENT_SECRET`  | Human: same page                                                                                        | MISSING |

### Discord Bot (OpenClaw gateway)

| Secret              | Rotated By                                                                                         | Status |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| `DISCORD_BOT_TOKEN` | Human: [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token | STALE  |

### Observability (Grafana Cloud)

| Secret                          | Rotated By                                                                                                                                       | Status  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `GRAFANA_URL`                   | Human: your Grafana instance URL                                                                                                                 | Set     |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | Human: Grafana → Administration → Service Accounts → `glsa_` token with datasource read/query and datasource create/write for setup provisioning | STALE   |
| `GRAFANA_CLOUD_LOKI_URL`        | Human: [Grafana Cloud](https://grafana.com/orgs) → Loki → Data source URL                                                                        | Set     |
| `GRAFANA_CLOUD_LOKI_USER`       | Human: Grafana Cloud → Loki → User (numeric)                                                                                                     | Set     |
| `GRAFANA_CLOUD_LOKI_API_KEY`    | Human: Grafana Cloud → Access Policies → logs:write token                                                                                        | STALE   |
| `PROMETHEUS_REMOTE_WRITE_URL`   | Human: Grafana Cloud → Prometheus → Remote Write URL                                                                                             | MISSING |
| `PROMETHEUS_USERNAME`           | Human: Grafana Cloud → Prometheus → User (numeric)                                                                                               | MISSING |
| `PROMETHEUS_PASSWORD`           | Human: Grafana Cloud → Access Policies → metrics:write token                                                                                     | MISSING |
| `PROMETHEUS_READ_USERNAME`      | Human: same user ID                                                                                                                              | MISSING |
| `PROMETHEUS_READ_PASSWORD`      | Human: Access Policies → metrics:read token                                                                                                      | MISSING |
| `PROMETHEUS_QUERY_URL`          | Derived from PROMETHEUS_REMOTE_WRITE_URL (strip /push)                                                                                           | MISSING |

### AI Observability (Langfuse)

| Secret                | Rotated By                                                           | Status  |
| --------------------- | -------------------------------------------------------------------- | ------- |
| `LANGFUSE_PUBLIC_KEY` | Human: [Langfuse](https://cloud.langfuse.com) → Settings → API Keys  | MISSING |
| `LANGFUSE_SECRET_KEY` | Human: same page                                                     | MISSING |
| `LANGFUSE_BASE_URL`   | Human: Langfuse instance URL (default: `https://cloud.langfuse.com`) | MISSING |

### Operator Wallet (Privy)

| Secret              | Rotated By                                                          | Status  |
| ------------------- | ------------------------------------------------------------------- | ------- |
| `PRIVY_APP_ID`      | Human: [Privy Dashboard](https://dashboard.privy.io) → App Settings | MISSING |
| `PRIVY_APP_SECRET`  | Human: same page                                                    | MISSING |
| `PRIVY_SIGNING_KEY` | Human: same page → Signing Key                                      | MISSING |

### WalletConnect

| Secret                                 | Rotated By                                                                 | Status |
| -------------------------------------- | -------------------------------------------------------------------------- | ------ |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Human: [WalletConnect Cloud](https://cloud.walletconnect.com) → Project ID | Set    |

## Auto-Provided (do not set manually)

| Secret         | Source                                           |
| -------------- | ------------------------------------------------ |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions per workflow run |

## Rotation Procedure

### Agent-rotatable secrets (random strings)

```bash
# One-liner to rotate all agent-owned secrets
for SECRET in AUTH_SECRET SCHEDULER_API_TOKEN BILLING_INGEST_TOKEN INTERNAL_OPS_TOKEN METRICS_TOKEN OPENCLAW_GATEWAY_TOKEN; do
  openssl rand -base64 32 | gh secret set "$SECRET" --repo cogni-dao/cogni
done
echo "sk-cogni-$(openssl rand -hex 24)" | gh secret set LITELLM_MASTER_KEY --repo cogni-dao/cogni
openssl rand -hex 32 | gh secret set GH_WEBHOOK_SECRET --repo cogni-dao/cogni
```

### SSH key rotation

```bash
ssh-keygen -t ed25519 -f /tmp/deploy_key -N "" -C "cogni-deploy-$(date +%Y%m%d)"
gh secret set SSH_DEPLOY_KEY --repo cogni-dao/cogni < /tmp/deploy_key
cat /tmp/deploy_key.pub  # Add to server ~/.ssh/authorized_keys
rm /tmp/deploy_key       # Private key only lives in GitHub Secrets
```

### Human-rotated secrets

1. Visit the linked dashboard URL in the table above
2. Regenerate or create a new credential
3. Run `gh secret set SECRET_NAME --repo cogni-dao/cogni` and paste the value
