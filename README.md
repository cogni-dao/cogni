# Cogni Template

A production-ready Next.js template for AI-powered autonomous organizations.

## Payments Configuration (read this first)

- `.cogni/repo-spec.yaml` is the single source of truth for the DAO receiving wallet, chain_id, and widget provider. There is **no env override**.
- The credits page reads repo-spec server-side and passes the config to the client widget as props.
- Changing the wallet or chain requires a repo-spec edit + redeploy; build-time validation fails if repo-spec.chain_id drifts from the app CHAIN_ID.

## There are 2 ways you could be using this repository! Which are you?

### 1. 👨‍💻 Contributor: Improve the Template

**Goal:** Develop improvements and merge back into CogniDAO repo
_We love you! ❤️_

```bash
git clone https://github.com/cogni-dao/cogni
cd cogni-template
scripts/bootstrap/setup.sh   # Install tools + dependencies, prompts to start dev stack
cp .env.local.example .env.local  # Configure environment (add OpenRouter API key)
pnpm dev:stack       # Start developing with full stack (DB + LiteLLM + Next.js)
pnpm db:setup        # Migrate and Seed database, once dev stack is running
pnpm docker:stack    # Full production simulation (https://localhost - browser cert warning expected)
```

**You'll need:** [OpenRouter API key](https://openrouter.ai/keys) for AI features

### 2. 🚀 Fork Owner: Launch Your Own DAO

**Goal:** Create your own autonomous organization with your unique direction
_We love you too, go for it! 🎯_

```bash
git clone https://github.com/YOUR-ORG/your-fork
cd your-fork
scripts/bootstrap/setup.sh --all   # Install all tools (includes OpenTofu, REUSE)
cp .env.local.example .env.local    # Configure environment
pnpm dev:stack                      # Start dev stack
```

---

## Setup Status: What's Scripted vs Manual

_We're working to automate more of this! Want to help? Contribute setup automation._

### ✅ Current Script Support

- **`scripts/bootstrap/setup.sh`** - One-command dev environment setup (Volta, Node 22, pnpm, Docker Desktop)
- **`scripts/bootstrap/setup.sh --all`** - Full setup including OpenTofu and REUSE
- **`tofu apply`** - VM provisioning (when manually configured)

### ⚠️ Current Manual Setup Required

**For Contributors:**

- Get [OpenRouter API key](https://openrouter.ai/keys) for AI features
- Copy `.env.local.example` → `.env.local` and fill in values
- **Observability:** Local Loki + Grafana on localhost:3001 (auto-configured). For MCP log queries, optionally set `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` for Grafana Cloud access.

**For Fork Owners (everything above, plus):**

**Infra Setup** _(see [deploy.md](docs/runbooks/DEPLOY.md) for details)_

- Generate SSH keys for deployment, move to folder, commit
- Get [Cherry Servers auth token](https://portal.cherryservers.com/settings/api-keys)
- Update `.tfvars` files with your settings
- Run `tofu apply`

**GitHub Environment Setup**

- Create [GitHub PAT](https://github.com/settings/personal-access-tokens/new) for bot account automation (needs Contents:Write, Pull requests:Write, Actions:Read, Metadata:Read), add it as a repo environment secret named `ACTIONS_AUTOMATION_BOT_PAT`
- Enable your git repo to contribute packages to your git org
- Set up GitHub environments and secrets manually
- Configure branch protection rules (see docs/spec/ci-cd.md)
- **SonarCloud setup:** Generate token at [SonarCloud Security](https://sonarcloud.io/account/security) → Add as `SONAR_TOKEN` repository secret
- **Grafana Cloud setup (optional):** Get Loki credentials from [Grafana Cloud](https://grafana.com/products/cloud/) → Add `GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USER`, `GRAFANA_CLOUD_LOKI_API_KEY` as **repository secrets** (shared across environments)

**DAO Setup**

- Run `make dao-setup` from [cogni-signal-evm-contracts](https://github.com/cogni-dao/cogni-signal-evm-contracts)

---

**Coming Soon:** `pnpm setup local|infra|github|dao` commands to automate these steps!
