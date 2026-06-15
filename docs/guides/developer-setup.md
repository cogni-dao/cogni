---
id: developer-setup-guide
type: guide
title: Developer Setup
status: draft
trust: draft
summary: First-time setup, daily development workflow, and testing commands for the Cogni-Template repo.
read_when: Onboarding to the repo or need a quick reference for dev/test commands.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [dev, onboarding]
---

# Developer Setup

## When to Use This

You are setting up the Cogni-Template repo for the first time, or need a reference for daily development and testing commands.

## Preconditions

- [ ] Node.js 22+ installed
- [ ] pnpm installed (`corepack enable`)
- [ ] Repository cloned
- [ ] Docker running (for infrastructure services)

## Steps

### First Time Setup

1. **Install dependencies:**

   ```bash
   pnpm install
   ```

2. **Environment files:**

   ```bash
   cp .env.local.example .env.local
   cp .env.test.example .env.test
   cp .env.docker.example .env.docker   # docker:dev:stack container-internal overrides
   ```

3. **Setup development database:**

   ```bash
   pnpm db:setup
   ```

4. **PostHog analytics (required):**
   The app requires `POSTHOG_API_KEY` and `POSTHOG_HOST`. Copy the example values from `.env.local.example`, or see [PostHog Setup](./posthog-setup.md) for production keys.

5. **Discord bot (optional):**
   If you want the OpenClaw gateway to connect a Discord bot, add `DISCORD_BOT_TOKEN` to `.env.local`. See [Discord Bot Setup](./discord-bot-setup.md) for full instructions.

## Daily Development

```bash
pnpm dev:stack          # Start app + infrastructure (main workflow)
```

## Testing

**Host Stack Tests:**

```bash
pnpm dev:stack:test:setup   # Create test database + migrations
pnpm test:stack:dev         # Run stack tests against host app
pnpm dev:stack:test:reset   # Nuclear reset when test DB is corrupted
```

**Docker Stack Tests:**

```bash
pnpm docker:test:stack          # Start containerized test stack
pnpm docker:test:stack:setup    # Create test database + migrations (requires stack running)
pnpm test:stack:docker          # Run tests against containerized app
pnpm docker:test:stack:reset    # Nuclear reset for containerized test database
```

## GitHub Webhook Testing (optional)

Test real GitHub event ingestion end-to-end. Requires a GitHub App configured for webhooks — see [GitHub App + Webhook Setup](./github-app-webhook-setup.md) for first-time setup.

```bash
# 1. Start infrastructure (postgres, temporal, scheduler-worker, etc.)
pnpm dev:infra

# 2. Provision + migrate + seed the database (creates open epoch for current week)
pnpm db:setup

# 3. Start the Next.js app (Terminal 1)
pnpm dev

# 4. Start the smee webhook proxy (Terminal 2)
pnpm dev:smee

# 5. Trigger real GitHub events — creates a merged PR + closed issue (Terminal 3)
pnpm dev:trigger-github

# 6. (Optional) Top up billing credits so paid OpenRouter models are usable
pnpm dev:seed:money
```

Receipts appear in `/gov/epoch` within seconds. The seeded open epoch covers the current week, so new webhook receipts show up immediately.

`dev:seed:money` gives all billing accounts $100 in credits. Idempotent — safe to re-run. Requires a billing account (log in first, then run it).

## PR Review Bot (optional)

Runs automated AI-powered code review on PRs. Requires the GitHub App from above with `Checks:write` + `Pull requests:write` permissions. See [GitHub App + Webhook Setup](./github-app-webhook-setup.md) for credentials.

**Environment variables** (`.env.local`):

```bash
GH_REVIEW_APP_ID=<your app id>
GH_REVIEW_APP_PRIVATE_KEY_BASE64=<base64-encoded private key>
GH_REPOS=<owner/repo>
GH_WEBHOOK_SECRET=<webhook secret>
GH_WEBHOOK_PROXY_URL=<smee channel url>
```

**Run it:**

```bash
# Terminal 1: dev stack
pnpm dev:stack

# Terminal 2: smee proxy for GitHub webhooks
npx smee -u $GH_WEBHOOK_PROXY_URL --path /api/internal/webhooks/github --port 3000
```

Push a branch and open a PR on the configured repo. The review bot creates a Check Run, runs LLM-powered gate evaluations, posts a PR comment with results. Click "View Details" on the Check Run to see the full review summary.

**Automated external tests** (requires credentials + running stack + smee):

```bash
pnpm test:external
```

## On-Chain Governance (optional)

Execute DAO-governed actions (merge PRs, manage collaborators) triggered by on-chain signals. Requires an Alchemy webhook monitoring a CogniSignal contract. See [Alchemy Webhook Setup](./alchemy-webhook-setup.md) for configuration.

**Prerequisites:**

1. A deployed CogniSignal contract — use the node formation UI at `/nodes` to create one
2. Alchemy webhook monitoring the signal contract address

**Environment variables** (`.env.local`):

```bash
ALCHEMY_WEBHOOK_SECRET=<alchemy signing key>
EVM_RPC_URL=<alchemy rpc url for same chain as your DAO>
```

**Local repo-spec setup:**

After forming a DAO via `/nodes`, create `.cogni/repo-spec.dev.yaml` (gitignored) by copying the committed spec and replacing the `cogni_dao` block with your test DAO:

```bash
cp .cogni/repo-spec.yaml .cogni/repo-spec.dev.yaml
```

Edit the `cogni_dao` section with your formation output and add `base_url`:

```yaml
cogni_dao:
  dao_contract: "<from formation>"
  plugin_contract: "<from formation>"
  signal_contract: "<from formation>"
  chain_id: "<from formation>"
  base_url: "https://proposal.cognidao.org"
```

The app automatically prefers `repo-spec.dev.yaml` over `repo-spec.yaml` when present.

**Run it:**

```bash
# Terminal 1: dev stack
pnpm dev:stack

# Terminal 2: smee proxy for Alchemy webhooks
npx smee -u <alchemy-smee-url> --path /api/internal/webhooks/alchemy --port 3000
```

When a PR review fails, the Check Run "View Details" page shows a "Propose DAO Vote to Merge" link. Submitting that proposal on-chain triggers an Alchemy webhook, which the app verifies and executes (e.g., merging the PR).

## Available Modes

- `pnpm dev:stack` - Host app + containerized postgres/litellm
- `pnpm docker:test:stack` - All services containerized for testing (production-like)
- `pnpm docker:stack` - Full production simulation with local environment

**Fast variants:** Add `:fast` to skip rebuilds (e.g., `pnpm docker:test:stack:fast`)

See [Environments](../spec/environments.md) for deployment modes and [Databases](../spec/databases.md) for migration details.

## Verification

```bash
pnpm check          # lint + type + format validation
pnpm test           # run unit tests (no infra required)
```

## Claude Code Remote Sessions

If you use [Claude Code on the web](https://claude.ai/code) (remote sessions), you **must** configure git authorship in your environment. Without this, the SessionStart hook will fail and block the session — this is intentional to prevent commits attributed to "Claude".

1. Go to [claude.ai/code](https://claude.ai/code) → click your environment → edit (or create one)
2. Add these environment variables:
   ```
   GIT_AUTHOR_NAME=<your git username>
   GIT_AUTHOR_EMAIL=<your git email>
   ```
3. Set **Network access** to "Full" if you need `gh` CLI access for PR operations

The repo's `.claude/settings.json` SessionStart hook reads these vars and configures `git config` automatically.

## Troubleshooting

### Problem: `pnpm db:setup` fails with connection error

**Solution:** Ensure Docker is running and postgres container is healthy: `docker ps | grep postgres`.

### Problem: Port conflicts on `pnpm dev:stack`

**Solution:** Check for existing processes on ports 3000/5432: `lsof -i :3000` and kill if needed.

## Related

- [Environments Spec](../spec/environments.md) — deployment modes and stack configurations
- [Databases Spec](../spec/databases.md) — migration architecture and database setup
- [Testing Guide](./testing.md) — testing strategy and adapter patterns
- [PostHog Setup](./posthog-setup.md) — PostHog Cloud and local dev analytics setup
- [Discord Bot Setup](./discord-bot-setup.md) — connect a Discord bot to the OpenClaw gateway
- [GitHub App + Webhook Setup](./github-app-webhook-setup.md) — GitHub App creation and webhook credentials
- [Alchemy Webhook Setup](./alchemy-webhook-setup.md) — on-chain signal webhook configuration
