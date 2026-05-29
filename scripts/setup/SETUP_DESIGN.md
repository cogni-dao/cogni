# Cogni Template Setup System

## Goal

**Get developers from fresh clone to working setup in 3 commands or less.**

Two distinct user journeys:

1. **Contributors:** Local development only (no CI/CD needed)
2. **Fork Owners:** Full deployment pipeline with GitHub Actions + Cherry VMs

## User Personas

### Persona 1: Contributor

- **Goal:** Contribute to cogni-template
- **Needs:** Local development environment only
- **Setup:** `pnpm setup local` and done

### Persona 2: Fork Owner

- **Goal:** Deploy their own instance with full CI/CD
- **Needs:** Local development + complete deployment pipeline
- **Setup:** Sequential commands handling all dependencies

## The Simple Workflows

### For Contributors: `pnpm setup local`

**Single command gets you developing:**

```bash
git clone https://github.com/Cogni-DAO/cogni
cd cogni-template
pnpm setup local
pnpm dev  # You're ready!
```

**What it does:**

1. Copy `.env.local.example` → `.env.local`
2. Generate secure random values:
   - `LITELLM_MASTER_KEY` (sk-xxx format)
   - `DATABASE_URL` (postgresql://postgres:postgres@localhost:5432/cogni_template_dev)
3. Prompt for `OPENROUTER_API_KEY`
4. Prompt for `EVM_RPC_URL` (Sepolia RPC from alchemy.com or infura.io — Base-chain operator wallet confirmation)
5. Prompt for `POLYGON_RPC_URL` (Polygon mainnet RPC from alchemy.com — poly-node reads USDC.e / POL + Polymarket on-chain state). Optional: if unset, poly-node falls back to public polygon-rpc.com and may rate-limit.
6. Prompt for `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (optional, from cloud.walletconnect.com)
7. Run `scripts/bootstrap/install/install-pnpm.sh`
8. `pnpm install` and setup git hooks

**No SSH keys, no Docker, no Cherry VMs, no GitHub secrets.**

### For Fork Owners: Sequential Setup

**Three-step flow handles all dependencies:**

```bash
# Step 1: Local development setup
pnpm setup local

# Step 2: Infrastructure (SSH keys + VMs)
pnpm setup infra --env preview
pnpm setup infra --env production

# Step 3: GitHub integration (secrets + CI/CD)
pnpm setup github --env preview
pnpm setup github --env production
```

## Detailed Fork Owner Flow

### Step 1: Local Setup (`pnpm setup local`)

- Same as contributor flow above
- Gets local development working first

### Step 2: Infrastructure (`pnpm setup infra --env <preview|production>`)

**Handles SSH key + VM provisioning:**

1. **Generate SSH keypair:**
   - `ssh-keygen -t ed25519 -f ~/.ssh/<repo-name>_<env>_deploy`
   - Copy public key → `infra/provision/cherry/base/keys/`
   - **Manual:** User commits public key to repo

2. **Update Terraform vars:**
   - Auto-detect repo name from git remote
   - Update `.tfvars`: `vm_name_prefix`, `public_key_path`
   - Cherry API: create/get `project_id` automatically

3. **Provision Cherry VM:**
   - Validate `CHERRY_AUTH_TOKEN`
   - `tofu init && tofu apply -var-file=env.<env>.tfvars`

4. **Save outputs:**
   - Extract `vm_host` → write to `.env.<env>` file

### Step 3: GitHub Integration (`pnpm setup github --env <preview|production>`)

**Uses SSH keys + VM outputs from Step 2:**

1. **Create GitHub environment** (`preview` or `production`)

2. **Set all required secrets:**
   - **Database secrets:** Two-role security model per environment
     - `POSTGRES_ROOT_USER` (postgres)
     - `POSTGRES_ROOT_PASSWORD` (generated hex password)
     - `APP_DB_NAME` (cogni_template_preview/cogni_template_production)
     - `APP_DB_USER` (cogni_app_preview/cogni_app_production)
     - `APP_DB_PASSWORD` (generated hex password)
     - `APP_DB_SERVICE_USER` (cogni_app_preview_service/cogni_app_production_service)
     - `APP_DB_SERVICE_PASSWORD` (generated hex password, must differ from APP_DB_PASSWORD)
     - `DATABASE_URL` (postgresql://APP_DB_USER:APP_DB_PASSWORD@postgres:5432/APP_DB_NAME)
     - `DATABASE_SERVICE_URL` (postgresql://APP_DB_SERVICE_USER:APP_DB_SERVICE_PASSWORD@postgres:5432/APP_DB_NAME)
   - **Temporal DB secrets:** Dedicated Postgres for Temporal (self-hosted)
     - `TEMPORAL_DB_USER` (default: temporal)
     - `TEMPORAL_DB_PASSWORD` (generated hex password)
   - **Service secrets:** Fresh generation per environment
     - `LITELLM_MASTER_KEY` (new random sk-xxx key)
     - `AUTH_SECRET` (generated random string)
     - `OPENROUTER_API_KEY` (prompt if not in local env)
     - `EVM_RPC_URL` (prompt if not in local env — Base-chain RPC from alchemy.com or infura.io)
     - `POLYGON_RPC_URL` (optional, Polygon mainnet RPC from alchemy.com — required for poly-node `/api/v1/poly/wallet/balance` to return live data; falls back to public polygon-rpc.com when absent)
     - `TAVILY_API_KEY` (optional — Tavily web-search API key from app.tavily.com; without it `WebSearchCapability` is disabled and any AI tool calling `core__web_search` will fail)
     - `OPENCLAW_GATEWAY_TOKEN` (generated random, ≥32 chars — gateway WS auth)
     - `OPENCLAW_GITHUB_RW_TOKEN` (GitHub PAT with Contents:Write + Pull requests:Write — host-side git relay)
     - `DISCORD_BOT_TOKEN` (Discord bot token — from discord.com/developers/applications → Bot → Reset Token)
     - **OAuth providers (optional — provider silently skipped if missing):**
       - `GH_OAUTH_CLIENT_ID` + `GH_OAUTH_CLIENT_SECRET` (from github.com/settings/developers → OAuth Apps)
       - `DISCORD_OAUTH_CLIENT_ID` + `DISCORD_OAUTH_CLIENT_SECRET` (from discord.com/developers/applications → OAuth2)
       - `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` (from console.cloud.google.com/apis/credentials)
       - **DoltHub mirror (v0 push job — task.5069):** see [`docs/runbooks/dolthub-remote-bootstrap.md`](../../docs/runbooks/dolthub-remote-bootstrap.md) for the one-time setup. Three secrets needed for push:
         - `DOLTHUB_REMOTE_URL` — gates the push job (e.g. `https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator`)
         - `DOLT_CREDS_JWK` — full contents of the `.jwk` file produced by `dolt creds new`
         - `DOLT_CREDS_KEYID` — the keyid from `dolt creds new`
       - `DOLTHUB_API_TOKEN` (from dolthub.com → Settings → API Tokens, scope `api_read_write`; **REST/SQL HTTP API only** — does not authenticate the Dolt push protocol. Used by future librarian / x402 reads. Per task.5069 spike findings.)
       - `DOLTHUB_OAUTH_CLIENT_ID` + `DOLTHUB_OAUTH_CLIENT_SECRET` (from dolthub.com → Settings → OAuth Apps; **reserved for v1 per-user identity** — librarian / x402 flow, not used by v0 push job. Redirect URIs: `https://cognidao.org/api/v1/dolt/oauth/callback`, `https://test.cognidao.org/api/v1/dolt/oauth/callback`, `http://localhost:3000/api/v1/dolt/oauth/callback`. Scope: `api_read_write`. **Node-fork bootstrap requirement** — flag for `docs/runbooks/fork-quickstart.md` when it lands (node-template PR #46))
       - See [OAuth App Setup Guide](../../docs/guides/oauth-app-setup.md) for step-by-step
     - `SCHEDULER_API_TOKEN` (generated random, ≥32 chars — scheduler-worker → app API bearer auth)
     - `BILLING_INGEST_TOKEN` (generated random, ≥32 chars — LiteLLM callback → billing ingest bearer auth)
     - `INTERNAL_OPS_TOKEN` (generated random, ≥32 chars — deploy-time bearer auth for `/api/internal/ops/governance/schedules/sync`)
     - **GitHub App for attribution ingestion (optional — skipped if missing):**
       - `GH_REVIEW_APP_ID` + `GH_REVIEW_APP_PRIVATE_KEY_BASE64` (from github.com/organizations → Developer settings → GitHub Apps)
       - `GH_WEBHOOK_SECRET` (from the GitHub App's webhook settings page — the secret used for HMAC-SHA256 payload verification)
       - **Webhook URL must be set in the GitHub App** to `https://<domain>/api/internal/webhooks/github` (e.g. `https://preview.cognidao.org/api/internal/webhooks/github`)
       - See [VCS Integration Spec](../../docs/spec/vcs-integration.md) for app permissions and setup
     - **GitHub repos for ingestion:**
       - `GH_REPOS` (comma-separated, e.g. `Cogni-DAO/cogni` — set as GitHub Actions **variable**, not secret)
     - **Grafana (optional):**
       - `GRAFANA_URL` (Grafana instance URL)
       - `GRAFANA_SERVICE_ACCOUNT_TOKEN` (Grafana stack service-account token, usually `glsa_`, with `datasources:read`, `datasources:query`, `datasources:create`, and `datasources:write` when setup/deploy provisions datasources; do not use a Grafana Cloud access-policy token prefixed `glc_`; use Grafana Cloud PDC or another private path for database datasources, never public inbound Postgres)
       - `GRAFANA_PDC_SIGNING_TOKEN` (the only generated PDC secret; from Connections → Private data source connections → Configuration Details → Generate token)
       - `GRAFANA_PDC_HOSTED_GRAFANA_ID`, `GRAFANA_PDC_CLUSTER` (copy from the same Docker snippet that produced the signing token; stable per Grafana org)
       - `GRAFANA_PDC_NETWORK_UUID` (internal Grafana UUID for the PDC network; read once via `curl $GRAFANA_URL/api/datasources/uid/<any-bound-datasource> | jq -r .jsonData.secureSocksProxyUsername`)
     - **Privy — Operator Wallet (optional — skipped if missing):**
       - `PRIVY_APP_ID` (from privy.io → App Settings)
       - `PRIVY_APP_SECRET` (from privy.io → App Settings)
       - `PRIVY_SIGNING_KEY` (`wallet-auth:...` authorization key — from privy.io → Settings → Authorization)
     - **Privy — Poly per-tenant trading wallets (optional for now; required to exercise task.0318 Phase B on candidate/preview/prod):**
       - `PRIVY_USER_WALLETS_APP_ID` (dedicated Privy app for user trading wallets)
       - `PRIVY_USER_WALLETS_APP_SECRET` (from the user-wallets Privy app)
       - `PRIVY_USER_WALLETS_SIGNING_KEY` (`wallet-auth:...` authorization key — from the user-wallets app)
       - `POLY_WALLET_AEAD_KEY_HEX` (64 hex chars / 32 bytes — generate with `openssl rand -hex 32`)
       - `POLY_WALLET_AEAD_KEY_ID` (key-ring label, e.g. `v1`)
       - `POLY_CLOB_GEO_BLOCK_TOKEN` (optional; Polymarket-provided `geo_block_token` for CLOB API-key provisioning from deployed runtimes)
     - **BYO-AI — Connection Encryption (optional — BYO-AI disabled when unset):**
       - `CONNECTIONS_ENCRYPTION_KEY` (64 hex chars / 32 bytes — generate with `openssl rand -hex 32`)
   - **Deployment secrets:** From previous steps
     - `SSH_DEPLOY_KEY` (from `~/.ssh/cogni_template_<env>_deploy`)
     - `VM_HOST` (from `.env.<env>` file)
     - `DOMAIN` (prompt user for their domain)
   - **Repository secrets:** (shared across environments)
     - `GHCR_DEPLOY_TOKEN` (prompt user to create GitHub PAT with `read:packages` scope)
     - `GIT_READ_TOKEN` (fine-grained PAT with `Contents:Read` scope — used by git-sync to HTTPS-clone the repo in CI stack tests, preview, and production. Must be a **repository-level** secret, not environment-scoped, so the CI stack-test job can access it.)
     - `CHERRY_AUTH_TOKEN` (prompt user for Cherry Servers API token)
     - `SONAR_TOKEN` (prompt user to create SonarCloud token)
     - `ACTIONS_AUTOMATION_BOT_PAT` (bot automation PAT, needs Contents:Write, Pull requests:Write, Actions:Read, Metadata:Read)
     - `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (optional from cloud.walletconnect.com; if missing, only injected wallets like MetaMask work)
     - **Grafana Cloud (optional):** For log aggregation in preview/production
       - `GRAFANA_CLOUD_LOKI_URL` (Loki push endpoint, e.g., https://logs-prod-020.grafana.net/loki/api/v1/push)
       - `GRAFANA_CLOUD_LOKI_USER` (numeric user ID from Grafana Cloud)
       - `GRAFANA_CLOUD_LOKI_API_KEY` (API key with logs:write permission)
       - Get from: https://grafana.com/products/cloud/ → Connections → Data Sources → Loki
     - **Prometheus Metrics (optional):** For metrics with Grafana Cloud
       - `METRICS_TOKEN` (≥32 chars, bearer auth for /api/metrics scraping)
       - **Write path (Alloy remote_write):**
         - `PROMETHEUS_REMOTE_WRITE_URL` (Mimir push endpoint, must end with /api/prom/push)
         - `PROMETHEUS_USERNAME` (Grafana Cloud username)
         - `PROMETHEUS_PASSWORD` (API key with metrics:write only)
       - **Read path (app queries):**
         - `PROMETHEUS_QUERY_URL` (optional, derived from write URL if not set)
         - `PROMETHEUS_READ_USERNAME` (Grafana Cloud username, can be same as write)
         - `PROMETHEUS_READ_PASSWORD` (Grafana Access Policy token with metrics:read scope)
           Create at: https://grafana.com/orgs/<org>/access-policies → Add policy → metrics:read → Add token

For current manual process, see [DEPLOY.md](../../docs/runbooks/DEPLOY.md).

### Step 4: Payment Activation (`pnpm node:activate-payments`)

**Activates the USDC payment → AI provider top-up pipeline.**

Prerequisites:

- Privy account (App ID + Secret + Signing Key in `.env.local`)
- A funded EOA on Base (~$0.02 ETH for Split deployment gas)
- DAO treasury address from `.cogni/repo-spec.yaml` (from formation)

What it does:

1. Verifies Privy credentials are configured
2. Provisions operator wallet via Privy API (or finds existing)
3. Deploys Push Split V2o2 on Base (operator + DAO treasury recipients)
4. Validates the Split on-chain
5. Writes `operator_wallet`, `payments_in`, `payments.status: active` to repo-spec

See [Payment Activation Guide](../../docs/guides/operator-wallet-setup.md) for details.

3. **Apply branch protection rules:**
   - `main`: 2 required reviews, required checks, enforce for admins
   - `staging`: 1 required review, required checks
   - **Note:** SonarCloud creates two separate checks: `sonar` (GitHub Action job) and `SonarCloud Code Analysis` (Quality Gate). Both should be added to required checks.

4. **Print GitHub Apps checklist:**
   - **SonarCloud setup:**
     1. Create SonarCloud project for your repo and organization
     2. Update `sonar-project.properties` with your organization and project key
     3. Disable "Automatic Analysis" in Project Settings → Analysis Method
     4. Generate token at https://sonarcloud.io/account/security → Add as SONAR_TOKEN repo secret

## Key Dependencies Resolved

**SSH Keys:** Generated in Step 2 → Used in Step 3  
**VM_HOST:** Generated in Step 2 → Used in Step 3  
**Secrets:** Fresh generation for each environment (no sharing local ↔ GitHub)

## Implementation Notes

**TypeScript-first:**

- `scripts/setup/bootstrap.ts` with subcommands: `local`, `infra`, `github`
- Hard-coded secret lists and branch rules (no YAML specs for v0)
- Uses `gh` CLI for GitHub API, assumes user Auth
- Disable Vercel telemetry: pnpm exec next telemetry disable

**Error handling:**

- Fail fast with clear next steps
- Check prerequisites before starting (gh auth, tofu install, etc.)
- Idempotent operations (safe to re-run)

## Success Criteria

✅ **Contributor:** `pnpm setup local` → `pnpm dev` works in under 2 minutes  
✅ **Fork Owner:** 3 commands → full CI/CD pipeline with auto-deploy on PRs  
✅ **No manual secret copying** between environments  
✅ **Clear dependency handling** (SSH keys → infra → GitHub)  
✅ **Eliminates 60+ step DEPLOY.md** with automated flow

## Future Evolution

When patterns stabilize, extract to:

- **Declarative specs:** `.cogni/setup.yaml` configuration
- **Multi-repo tool:** `cogni-admin` CLI package
- **DAO integration:** Automated multisig + plugin deployment
- **GitLab support:** Host-abstracted adapters

**v0 Focus:** Script-based, this-repo-only, maximum simplicity.
