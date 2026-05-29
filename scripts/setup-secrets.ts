#!/usr/bin/env npx tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/setup-secrets`
 * Purpose: Interactive secret provisioning for Cogni node formation.
 * Scope: Walks through all GitHub Actions secrets (preview + production), auto-generates agent-rotatable values, prompts for human-provided ones with dashboard URLs; does not modify code or deploy.
 * Invariants: Secrets set per-env only. Agent secrets use openssl rand.
 * Side-effects: IO (sets GitHub Actions secrets via gh secret set)
 * Links: docs/runbooks/SECRET_ROTATION.md
 *
 * Usage:
 *   pnpm setup:secrets                        # walk through missing secrets (all envs)
 *   pnpm setup:secrets --env candidate-a      # only candidate-a environment
 *   pnpm setup:secrets --env candidate-a --all # candidate-a, including already-set
 *   pnpm setup:secrets --env candidate-a --auto # auto-generate missing agent secrets, only prompt for human ones
 *   pnpm setup:secrets --poly                 # only poly-related secrets (all envs)
 *   pnpm setup:secrets --poly --env candidate-a # only poly secrets for candidate-a
 *   pnpm setup:secrets:poly --env candidate-a # same poly-only flow via package.json alias
 *   pnpm setup:secrets --required             # only required secrets
 *   pnpm setup:secrets --all                  # walk through everything (including already-set)
 *   pnpm setup:secrets --only DISCORD         # just secrets matching "DISCORD"
 *   pnpm setup:secrets --only DISCORD,SONAR   # multiple patterns (comma-separated)
 */

import { execSync } from "node:child_process";
import * as readline from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────────

interface Secret {
  name: string;
  required: boolean;
  category: string;
  description: string;
  /** "agent" = we generate it, "human" = paste from dashboard */
  source: "agent" | "human";
  /** URL to visit (human secrets) */
  url?: string;
  /** Step-by-step instructions (rendered as vertical list) */
  steps: string[];
  /** Generator function for agent secrets */
  generate?: () => string;
  /** true if preview and production typically have DIFFERENT values */
  perEnv?: boolean;
  /** true if this is a repo-level secret (CI), not per-environment (deploy) */
  repoLevel?: boolean;
  /** Optional value transform before setting (e.g. append URL path) */
  transform?: (value: string) => string;
}

// ── Generators ───────────────────────────────────────────────────────────────

function rand64(bytes = 32): string {
  return execSync(`openssl rand -base64 ${bytes}`).toString().trim();
}

function randHex(bytes = 32): string {
  return execSync(`openssl rand -hex ${bytes}`).toString().trim();
}

function generateSSHKey(env: string): string {
  const path = `/tmp/cogni-deploy-key-${env}-${Date.now()}`;
  execSync(
    `ssh-keygen -t ed25519 -f ${path} -N "" -C "cogni-deploy-${env}-$(date +%Y%m%d)" -q`
  );
  const privKey = execSync(`cat ${path}`).toString();
  const pubKey = execSync(`cat ${path}.pub`).toString().trim();
  execSync(`rm -f ${path} ${path}.pub`);
  console.log("");
  console.log(`     Public key for ${env}:`);
  console.log(`     ${pubKey}`);
  console.log("");
  console.log(
    `     Save this to: infra/provision/cherry/base/keys/cogni_template_${env}_deploy.pub`
  );
  console.log(`     Then run: tofu apply -var-file=terraform.${env}.tfvars`);
  console.log("");
  return privKey;
}

// ── Secret Catalog ───────────────────────────────────────────────────────────

const SECRETS: Secret[] = [
  // ── Required: Agent-generated ──────────────────────────────────────────
  {
    name: "AUTH_SECRET",
    required: true,
    category: "Core App",
    source: "agent",
    description: "NextAuth session encryption key",
    steps: ["Auto-generated random string"],
    generate: () => rand64(32),
  },
  {
    name: "LITELLM_MASTER_KEY",
    required: true,
    category: "Core App",
    source: "agent",
    description: "LiteLLM proxy master API key",
    steps: ["Auto-generated sk-cogni-* key"],
    generate: () => `sk-cogni-${randHex(24)}`,
  },
  {
    name: "OPENCLAW_GATEWAY_TOKEN",
    required: true,
    category: "Core App",
    source: "agent",
    description: "OpenClaw gateway WS auth token",
    steps: ["Auto-generated random string"],
    generate: () => rand64(32),
  },
  {
    name: "SCHEDULER_API_TOKEN",
    required: true,
    category: "Internal Service",
    source: "agent",
    description: "scheduler-worker -> internal graph API auth",
    steps: ["Auto-generated random string"],
    generate: () => rand64(32),
  },
  {
    name: "BILLING_INGEST_TOKEN",
    required: true,
    category: "Internal Service",
    source: "agent",
    description: "LiteLLM callback -> billing ingest endpoint auth",
    steps: ["Auto-generated random string"],
    generate: () => rand64(32),
  },
  {
    name: "INTERNAL_OPS_TOKEN",
    required: true,
    category: "Internal Service",
    source: "agent",
    description: "Deploy trigger -> governance schedule sync auth",
    steps: ["Auto-generated random string"],
    generate: () => rand64(32),
  },
  {
    name: "METRICS_TOKEN",
    required: true,
    category: "Internal Service",
    source: "agent",
    description: "Prometheus scrape -> /api/metrics auth",
    steps: ["Auto-generated random string"],
    generate: () => rand64(32),
  },
  {
    name: "GH_WEBHOOK_SECRET",
    required: true,
    category: "Internal Service",
    source: "agent",
    description: "GitHub webhook HMAC verification secret",
    steps: ["Auto-generated hex string"],
    generate: () => randHex(32),
  },
  {
    name: "SSH_DEPLOY_KEY",
    required: true,
    category: "Infrastructure",
    source: "agent",
    description: "SSH private key for deploy to server",
    perEnv: true,
    steps: [
      "Auto-generated ed25519 keypair (one per environment)",
      "1. Pubkey pushed to server via existing SSH access",
      "2. Private key set in GitHub environment secret",
      "3. Pubkey saved to infra/provision/cherry/base/keys/",
      "4. Run: tofu apply -var-file=terraform.<env>.tfvars",
    ],
    // generate handled specially in main loop
  },

  // ── Infrastructure: repo-level ──────────────────────────────────────────
  {
    name: "CHERRY_AUTH_TOKEN",
    required: true,
    category: "Infrastructure",
    source: "human",
    repoLevel: true,
    description: "Cherry Servers API token for VM provisioning (tofu apply)",
    url: "https://portal.cherryservers.com/settings/api-keys",
    steps: [
      "API Keys page",
      "Create or copy existing API key",
      "Also export locally: export CHERRY_AUTH_TOKEN=<value>",
    ],
  },

  // ── Required: Human-provided ───────────────────────────────────────────
  {
    name: "OPENROUTER_API_KEY",
    required: true,
    category: "Core App",
    source: "human",
    description: "OpenRouter LLM API key",
    url: "https://openrouter.ai/keys",
    steps: ["Create a new API key", "Copy the full key (starts with sk-)"],
  },
  {
    name: "EVM_RPC_URL",
    required: true,
    category: "Core App",
    source: "human",
    description: "Base mainnet RPC endpoint for on-chain verification",
    url: "https://dashboard.alchemy.com/",
    steps: [
      "Create a new app (chain: Base mainnet)",
      "Copy the full HTTPS URL including API key",
    ],
  },
  {
    name: "POLYGON_RPC_URL",
    required: true,
    category: "Polymarket / RPC",
    source: "human",
    description: "Polygon mainnet RPC endpoint for poly runtime reads",
    url: "https://dashboard.alchemy.com/",
    steps: [
      "Create a new app (chain: Polygon mainnet)",
      "Copy the full HTTPS URL including API key",
      "Used by poly-node for Polygon balances / allowance reads",
    ],
  },
  {
    name: "OPENCLAW_GITHUB_RW_TOKEN",
    required: true,
    category: "Core App",
    source: "human",
    description: "GitHub PAT for OpenClaw git relay (push + PR)",
    url: "https://github.com/settings/tokens?type=beta",
    steps: [
      "Create fine-grained personal access token",
      "Resource owner: Cogni-DAO",
      "Repository access: All repositories (or select repos)",
      "Permissions:",
      "  - Contents: Read and write",
      "  - Pull requests: Read and write",
    ],
  },
  {
    name: "TAVILY_API_KEY",
    required: false,
    category: "Core App",
    source: "human",
    description: "Tavily API key for AI web-search tool (WebSearchCapability)",
    url: "https://app.tavily.com/home",
    steps: [
      "Sign in to Tavily and open the API Keys page",
      "Create or copy an existing API key (starts with tvly-)",
    ],
  },
  {
    name: "POSTHOG_API_KEY",
    required: true,
    category: "Core App",
    source: "human",
    description: "PostHog project API key",
    url: "https://us.posthog.com/settings/project#variables",
    steps: ["Copy the Project API Key from project settings"],
  },
  {
    name: "POSTHOG_HOST",
    required: true,
    category: "Core App",
    source: "human",
    description: "PostHog instance URL",
    url: "https://us.posthog.com/settings/project#variables",
    steps: ['e.g. "https://us.i.posthog.com" for US Cloud'],
  },
  {
    name: "GHCR_DEPLOY_TOKEN",
    required: true,
    category: "Infrastructure",
    source: "human",
    repoLevel: true,
    description: "GitHub PAT for docker pull from GHCR on deploy server",
    url: "https://github.com/settings/tokens?type=beta",
    steps: [
      "Create fine-grained personal access token",
      "Resource owner: Cogni-DAO",
      "Permissions:",
      "  - Packages: Read",
    ],
  },
  {
    name: "DOMAIN",
    required: true,
    category: "Infrastructure",
    source: "human",
    description: "Server domain name",
    perEnv: true,
    steps: ['e.g. "preview.cogni.dev" / "app.cogni.dev"'],
  },
  {
    name: "VM_HOST",
    required: true,
    category: "Infrastructure",
    source: "human",
    description: "Deploy target IP or hostname",
    perEnv: true,
    steps: ["The IP address of your Cherry Server VM"],
  },

  // ── Required: Database (grouped) ───────────────────────────────────────
  {
    name: "POSTGRES_ROOT_USER",
    required: true,
    category: "Database",
    source: "agent",
    description: "Postgres superuser name",
    steps: ['Convention: "postgres"'],
    generate: () => "postgres",
  },
  {
    name: "POSTGRES_ROOT_PASSWORD",
    required: true,
    category: "Database",
    source: "agent",
    description: "Postgres superuser password",
    steps: ["Auto-generated hex string (URL-safe for DSN construction)"],
    generate: () => randHex(24),
  },
  {
    name: "APP_DB_NAME",
    required: true,
    category: "Database",
    source: "agent",
    description: "Application database name",
    steps: ['Convention: "cogni_template"'],
    generate: () => "cogni_template",
  },
  {
    name: "APP_DB_USER",
    required: true,
    category: "Database",
    source: "agent",
    description: "App user (RLS enforced)",
    steps: ['Convention: "app_user"'],
    generate: () => "app_user",
  },
  {
    name: "APP_DB_PASSWORD",
    required: true,
    category: "Database",
    source: "agent",
    description: "App user password",
    steps: ["Auto-generated hex string (URL-safe for DSN construction)"],
    generate: () => randHex(24),
  },
  {
    name: "APP_DB_SERVICE_USER",
    required: true,
    category: "Database",
    source: "agent",
    description: "Service user (BYPASSRLS)",
    steps: ['Convention: "app_service"'],
    generate: () => "app_service",
  },
  {
    name: "APP_DB_SERVICE_PASSWORD",
    required: true,
    category: "Database",
    source: "agent",
    description: "Service user password",
    steps: ["Auto-generated hex string (URL-safe for DSN construction)"],
    generate: () => randHex(24),
  },
  {
    name: "APP_DB_READONLY_USER",
    required: false,
    category: "Database",
    source: "agent",
    description: "Read-only Postgres user for Grafana/agent support queries",
    steps: ['Convention: "app_readonly"'],
    generate: () => "app_readonly",
  },
  {
    name: "APP_DB_READONLY_PASSWORD",
    required: false,
    category: "Database",
    source: "agent",
    description:
      "Read-only Postgres password; deploy-infra derives one from POSTGRES_ROOT_PASSWORD when unset",
    steps: ["Optional override for the derived read-only credential"],
    generate: () => randHex(24),
  },
  {
    name: "TEMPORAL_DB_USER",
    required: true,
    category: "Database",
    source: "agent",
    description: "Temporal database user",
    steps: ['Convention: "temporal"'],
    generate: () => "temporal",
  },
  {
    name: "TEMPORAL_DB_PASSWORD",
    required: true,
    category: "Database",
    source: "agent",
    description: "Temporal database password",
    steps: ["Auto-generated hex string (URL-safe for DSN construction)"],
    generate: () => randHex(24),
  },

  // ── CI / Automation ────────────────────────────────────────────────────
  {
    name: "ACTIONS_AUTOMATION_BOT_PAT",
    required: false,
    category: "CI / Automation",
    source: "human",
    repoLevel: true,
    description: "GitHub PAT for cross-repo workflow dispatch and release PRs",
    url: "https://github.com/settings/tokens?type=beta",
    steps: [
      "Create fine-grained personal access token",
      "Permissions:",
      "  - Actions: Read and write",
      "  - Contents: Read and write",
      "  - Pull requests: Read and write",
    ],
  },
  {
    name: "GIT_READ_TOKEN",
    required: false,
    category: "CI / Automation",
    source: "human",
    repoLevel: true,
    description: "GitHub PAT for git-sync container (repo clone)",
    url: "https://github.com/settings/tokens?type=beta",
    steps: [
      "Create fine-grained personal access token",
      "Permissions:",
      "  - Contents: Read-only",
      "(Public repos work without token)",
    ],
  },
  {
    name: "SONAR_TOKEN",
    required: false,
    category: "CI / Automation",
    source: "human",
    repoLevel: true,
    description: "SonarCloud analysis token",
    url: "https://sonarcloud.io/account/security",
    steps: ["Generate a new token", "Copy the full value"],
  },

  // ── Optional: GitHub App (PR Review Bot) ───────────────────────────────
  {
    name: "GH_REVIEW_APP_ID",
    required: false,
    category: "GitHub App (PR Review)",
    source: "human",
    description: "GitHub App numeric ID",
    url: "https://github.com/settings/apps",
    steps: ["Your GitHub App", "General tab", "Copy App ID"],
  },
  {
    name: "GH_REVIEW_APP_PRIVATE_KEY_BASE64",
    required: false,
    category: "GitHub App (PR Review)",
    source: "human",
    description: "GitHub App private key (base64-encoded PEM)",
    url: "https://github.com/settings/apps",
    steps: [
      "Your GitHub App",
      "General tab -> Generate a private key",
      "Then run: base64 -w0 < downloaded-key.pem",
      "Paste the base64 output",
    ],
  },

  // ── Optional: OAuth Providers ──────────────────────────────────────────
  {
    name: "GH_OAUTH_CLIENT_ID",
    required: false,
    category: "OAuth (GitHub)",
    source: "human",
    description: "GitHub OAuth App client ID",
    url: "https://github.com/settings/developers",
    steps: ["OAuth Apps", "Your app", "Copy Client ID"],
  },
  {
    name: "GH_OAUTH_CLIENT_SECRET",
    required: false,
    category: "OAuth (GitHub)",
    source: "human",
    description: "GitHub OAuth App client secret",
    url: "https://github.com/settings/developers",
    steps: ["OAuth Apps", "Your app", "Generate a new client secret"],
  },
  {
    name: "DISCORD_OAUTH_CLIENT_ID",
    required: false,
    category: "OAuth (Discord)",
    source: "human",
    description: "Discord OAuth2 client ID",
    url: "https://discord.com/developers/applications",
    steps: ["Your app", "OAuth2 tab", "Copy Client ID"],
  },
  {
    name: "DISCORD_OAUTH_CLIENT_SECRET",
    required: false,
    category: "OAuth (Discord)",
    source: "human",
    description: "Discord OAuth2 client secret",
    url: "https://discord.com/developers/applications",
    steps: ["Your app", "OAuth2 tab", "Reset Secret"],
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_ID",
    required: false,
    category: "OAuth (Google)",
    source: "human",
    description: "Google OAuth client ID",
    url: "https://console.cloud.google.com/apis/credentials",
    steps: ["OAuth 2.0 Client IDs", "Your client", "Copy Client ID"],
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_SECRET",
    required: false,
    category: "OAuth (Google)",
    source: "human",
    description: "Google OAuth client secret",
    url: "https://console.cloud.google.com/apis/credentials",
    steps: ["OAuth 2.0 Client IDs", "Your client", "Copy Client secret"],
  },

  // ── Optional: DoltHub mirror (push job) ────────────────────────────────
  // v0 mirror writes the canonical knowledge DB main branch to DoltHub after
  // every successful contribution merge. Auth uses Dolt creds (keypair) —
  // the PAT cannot sign the push protocol. See
  // docs/runbooks/dolthub-remote-bootstrap.md for the one-time bootstrap.
  {
    name: "DOLTHUB_REMOTE_URL",
    required: false,
    category: "DoltHub Mirror",
    source: "human",
    description:
      "DoltHub remote URL — gates the push job; unset disables mirror",
    steps: [
      'Convention: "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator"',
      "Repo must exist on DoltHub first (create empty at https://www.dolthub.com/repositories/new)",
      "Leave unset on dev/test if you don't want pushes",
    ],
  },
  {
    name: "DOLT_CREDS_JWK",
    required: false,
    category: "DoltHub Mirror",
    source: "human",
    description: "Dolt cred private key (JWK file contents) for push auth",
    steps: [
      "On a bootstrap host with the `dolt` CLI: `dolt creds new`",
      "Outputs a keyid + creates ~/.dolt/creds/<keyid>.jwk",
      "Paste full file contents (a single-line JSON) as the secret value",
      "Pubkey must be registered at https://www.dolthub.com/settings/credentials",
      "Same JWK is shared across envs for v0 (one service identity)",
      "See docs/runbooks/dolthub-remote-bootstrap.md for the full ceremony",
    ],
  },
  {
    name: "DOLT_CREDS_KEYID",
    required: false,
    category: "DoltHub Mirror",
    source: "human",
    description:
      "Dolt cred keyid — matches the .jwk filename DOLT_CREDS_JWK was sourced from",
    steps: [
      "Same `dolt creds new` output — the keyid printed above the file path",
      "Used as the filename when the doltgres entrypoint writes the JWK",
    ],
  },

  // ── Optional: OAuth (DoltHub) ──────────────────────────────────────────
  // Used by the prod-side knowledge push job (one-way: prod -> DoltHub remote).
  // For app-level push jobs prefer DOLTHUB_API_TOKEN (PAT) below; the OAuth
  // pair is reserved for per-user identity flows (librarian / x402, v1).
  {
    name: "DOLTHUB_OAUTH_CLIENT_ID",
    required: false,
    category: "OAuth (DoltHub)",
    source: "human",
    description: "DoltHub OAuth App client ID (per-user identity, v1)",
    url: "https://www.dolthub.com/settings/oauth",
    steps: [
      "Sign in to DoltHub",
      "Settings -> OAuth Applications -> New",
      "Copy Client ID",
      "Note: production use requires DoltHub-side approval; dev works immediately",
    ],
  },
  {
    name: "DOLTHUB_OAUTH_CLIENT_SECRET",
    required: false,
    category: "OAuth (DoltHub)",
    source: "human",
    description: "DoltHub OAuth App client secret (per-user identity, v1)",
    url: "https://www.dolthub.com/settings/oauth",
    steps: ["Same OAuth App", "Generate or copy Client Secret"],
  },
  {
    name: "DOLTHUB_API_TOKEN",
    required: false,
    category: "OAuth (DoltHub)",
    source: "human",
    description:
      "DoltHub Personal Access Token for app-level knowledge push job",
    url: "https://www.dolthub.com/settings/tokens",
    steps: [
      "Sign in to DoltHub",
      "Settings -> API Tokens -> Create",
      "Scope: write to knowledge-<node> repos owned by the org",
      "Used by the prod push job (one-way mirror); no user OAuth required",
    ],
  },

  // ── Optional: Discord Bot ──────────────────────────────────────────────
  {
    name: "DISCORD_BOT_TOKEN",
    required: false,
    category: "Discord Bot",
    source: "human",
    description: "Discord bot token for OpenClaw gateway",
    url: "https://discord.com/developers/applications",
    steps: ["Your app", "Bot tab", "Reset Token", "Copy the new token"],
  },

  // ── Optional: Observability (Grafana Cloud) ────────────────────────────
  {
    name: "GRAFANA_URL",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana instance URL",
    url: "https://grafana.com/orgs",
    steps: ['e.g. "https://your-org.grafana.net"'],
  },
  {
    name: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description:
      "Grafana service account token for observability reads and reproducible datasource provisioning",
    steps: [
      "Grafana instance",
      "Administration -> Service Accounts",
      "Add service account with datasource read/query plus datasource create/write for setup runs",
      "Required permissions: datasources:read, datasources:query, datasources:create, datasources:write",
      "Use a stack service-account token, usually prefixed glsa_; Grafana Cloud access-policy tokens prefixed glc_ do not authorize the Grafana instance HTTP API",
      "Use Grafana Cloud Private Data Source Connect (PDC) for private databases; do not expose Postgres publicly",
      "Add token, copy it",
    ],
  },
  {
    name: "GRAFANA_PDC_SIGNING_TOKEN",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description:
      "Per-environment Grafana PDC signing token; authenticates the runtime pdc-agent SSH client",
    steps: [
      "Grafana instance",
      "Connections -> Private data source connections",
      "Open the org's PDC network (one network can serve multiple environments via separate tokens)",
      "Configuration Details -> Use a PDC signing token -> Create a new token",
      "Token name: <env>-postgres-YYYYMMDD (the name is just a label; Grafana does not route by token name)",
      "Copy the value labeled GCLOUD_PDC_SIGNING_TOKEN (begins with glc_); Grafana shows it once",
      "Cluster + hosted-grafana-id are also printed in the same Docker command snippet — capture them in the next two prompts",
    ],
  },
  {
    name: "GRAFANA_PDC_HOSTED_GRAFANA_ID",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description:
      "Hosted Grafana ID — stable per Grafana org/instance; copy from the PDC Docker snippet, do not decode the token payload",
    steps: [
      "Same Configuration Details -> Docker panel that produced the signing token",
      "Copy the integer value after -gcloud-hosted-grafana-id",
      "This number is stable per Grafana org and is reused across every environment's pdc-agent",
    ],
  },
  {
    name: "GRAFANA_PDC_CLUSTER",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description:
      "Grafana PDC cluster — stable per Grafana org region; copy from the PDC Docker snippet",
    steps: [
      "Same Configuration Details -> Docker panel that produced the signing token",
      "Copy the value after -cluster (e.g. prod-ap-southeast-1)",
      "This value is stable per Grafana org region and is reused across every environment's pdc-agent",
    ],
  },
  {
    name: "GRAFANA_PDC_NETWORK_UUID",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description:
      "Internal Grafana UUID for the PDC network — what Grafana Cloud routes by; stable per network",
    steps: [
      "First-time bootstrap: bind ONE Postgres datasource to the PDC network through the Grafana UI (datasource page -> Connection -> Private data source connect dropdown -> Save & test).",
      "Then read the UUID from that datasource's stored config:",
      'curl -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" "$GRAFANA_URL/api/datasources/uid/<uid>" | jq -r .jsonData.secureSocksProxyUsername',
      "Paste the UUID (looks like 5ff531a0-3ed3-4460-8281-be08184816c3) — it's the same value for every environment that shares this PDC network.",
      "After this is stored, future `provision-grafana-postgres-datasources.sh` runs bind datasources to PDC purely via API; no UI clicks needed.",
    ],
  },
  {
    name: "GRAFANA_CLOUD_LOKI_URL",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud Loki write URL",
    url: "https://grafana.com/orgs",
    steps: [
      "Your stack -> Loki",
      "Paste the base URL (e.g. https://logs-prod-020.grafana.net)",
      "/loki/api/v1/push will be appended automatically",
    ],
    /** Transform: append push path if missing */
    transform: (v: string) => {
      const base = v.replace(/\/+$/, "");
      return base.includes("/loki/api/v1/push")
        ? base
        : `${base}/loki/api/v1/push`;
    },
  },
  {
    name: "GRAFANA_CLOUD_LOKI_USER",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud Loki numeric user ID",
    url: "https://grafana.com/orgs",
    steps: ["Your stack -> Loki", "Copy User (numeric)"],
  },
  {
    name: "GRAFANA_CLOUD_LOKI_API_KEY",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud API key (logs:write scope)",
    url: "https://grafana.com/orgs",
    steps: [
      "Access Policies -> Create policy",
      "Scope: logs:write",
      "Create token, copy it",
    ],
  },
  {
    name: "PROMETHEUS_REMOTE_WRITE_URL",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud Prometheus remote write URL",
    url: "https://grafana.com/orgs",
    steps: ["Your stack -> Prometheus", "Copy Remote Write URL"],
  },
  {
    name: "PROMETHEUS_USERNAME",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud Prometheus user (numeric)",
    url: "https://grafana.com/orgs",
    steps: ["Your stack -> Prometheus", "Copy User (numeric)"],
  },
  {
    name: "PROMETHEUS_PASSWORD",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud API key (metrics:write scope)",
    url: "https://grafana.com/orgs",
    steps: [
      "Access Policies -> Create policy",
      "Scope: metrics:write",
      "Create token, copy it",
    ],
  },
  {
    name: "PROMETHEUS_READ_USERNAME",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Prometheus read user (same numeric ID is fine)",
    steps: ["Same user ID as PROMETHEUS_USERNAME"],
  },
  {
    name: "PROMETHEUS_READ_PASSWORD",
    required: false,
    category: "Observability (Grafana Cloud)",
    source: "human",
    description: "Grafana Cloud API key (metrics:read scope)",
    url: "https://grafana.com/orgs",
    steps: [
      "Access Policies -> Create policy",
      "Scope: metrics:read",
      "Create token, copy it",
    ],
  },

  // ── Optional: Langfuse ─────────────────────────────────────────────────
  {
    name: "LANGFUSE_PUBLIC_KEY",
    required: false,
    category: "AI Observability (Langfuse)",
    source: "human",
    description: "Langfuse public key",
    url: "https://cloud.langfuse.com",
    steps: ["Settings -> API Keys", "Copy Public Key"],
  },
  {
    name: "LANGFUSE_SECRET_KEY",
    required: false,
    category: "AI Observability (Langfuse)",
    source: "human",
    description: "Langfuse secret key",
    url: "https://cloud.langfuse.com",
    steps: ["Settings -> API Keys", "Copy Secret Key"],
  },
  {
    name: "LANGFUSE_BASE_URL",
    required: false,
    category: "AI Observability (Langfuse)",
    source: "human",
    description: "Langfuse instance URL",
    steps: [
      'Default: "https://cloud.langfuse.com"',
      "Set only for self-hosted",
    ],
  },

  // ── Optional: Privy (Operator Wallet) ──────────────────────────────────
  {
    name: "PRIVY_APP_ID",
    required: false,
    category: "Operator Wallet (Privy)",
    source: "human",
    description: "Privy application ID",
    url: "https://dashboard.privy.io",
    steps: ["App Settings", "Copy App ID"],
  },
  {
    name: "PRIVY_APP_SECRET",
    required: false,
    category: "Operator Wallet (Privy)",
    source: "human",
    description: "Privy application secret",
    url: "https://dashboard.privy.io",
    steps: ["App Settings", "Copy App Secret"],
  },
  {
    name: "PRIVY_SIGNING_KEY",
    required: false,
    category: "Operator Wallet (Privy)",
    source: "human",
    description: "Privy wallet auth signing key (wallet-auth:...)",
    url: "https://dashboard.privy.io",
    steps: [
      "Settings -> Authorization",
      "Generate or copy signing key",
      "Paste the full wallet-auth:... value",
    ],
  },

  // ── Optional: Poly Wallets (Privy, per-tenant) ─────────────────────────
  {
    name: "PRIVY_USER_WALLETS_APP_ID",
    required: false,
    category: "Poly Wallets (Privy)",
    source: "human",
    description: "Privy app ID for per-tenant Poly trading wallets",
    url: "https://dashboard.privy.io",
    steps: [
      "Open the dedicated user-wallets Privy app",
      "Settings -> Basics",
      "Copy App ID",
    ],
  },
  {
    name: "PRIVY_USER_WALLETS_APP_SECRET",
    required: false,
    category: "Poly Wallets (Privy)",
    source: "human",
    description: "Privy app secret for per-tenant Poly trading wallets",
    url: "https://dashboard.privy.io",
    steps: [
      "Open the dedicated user-wallets Privy app",
      "Settings -> Basics",
      "Create or copy App Secret",
    ],
  },
  {
    name: "PRIVY_USER_WALLETS_SIGNING_KEY",
    required: false,
    category: "Poly Wallets (Privy)",
    source: "human",
    description: "Privy wallet auth key for per-tenant Poly trading wallets",
    url: "https://dashboard.privy.io",
    steps: [
      "Open the dedicated user-wallets Privy app",
      "Settings -> Authorization",
      "Generate or copy signing key",
      "Paste the full wallet-auth:... value",
    ],
  },
  {
    name: "POLY_WALLET_AEAD_KEY_HEX",
    required: false,
    category: "Poly Wallets (Privy)",
    source: "agent",
    description: "AES-256-GCM key for encrypting tenant Poly wallet CLOB creds",
    steps: [
      "Auto-generated 32-byte hex key",
      "Stored as the at-rest encryption key for poly_wallet_connections ciphertext",
    ],
    generate: () => randHex(32),
  },
  {
    name: "POLY_WALLET_AEAD_KEY_ID",
    required: false,
    category: "Poly Wallets (Privy)",
    source: "agent",
    description: "Key-ring label for POLY_WALLET_AEAD_KEY_HEX",
    steps: [
      'Convention: "v1"',
      "Bump only when rotating POLY_WALLET_AEAD_KEY_HEX",
    ],
    generate: () => "v1",
  },

  // task.0318 Phase B Stage 4: the single-operator POLY_CLOB_API_KEY /
  // _SECRET / _PASSPHRASE + POLY_PROTO_* + POLY_PROTO_WALLET_ADDRESS secrets
  // have been PURGED. Per-tenant CLOB L2 creds are now derived server-side
  // at wallet-provision time from the user's per-user Privy wallet and
  // stored AEAD-encrypted in `poly_wallet_connections.clob_api_key_ciphertext`.
  // See docs/spec/poly-trader-wallet-port.md.

  // ── Optional: WalletConnect ────────────────────────────────────────────
  {
    name: "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
    required: false,
    category: "WalletConnect",
    source: "human",
    description: "WalletConnect Cloud project ID",
    url: "https://cloud.walletconnect.com",
    steps: ["Your project", "Copy Project ID"],
  },

  // ── Derived from repo: auto-generated from nodes/*/.cogni/repo-spec.yaml ──
  {
    name: "COGNI_NODE_DBS",
    required: true,
    category: "Infrastructure (derived)",
    source: "agent",
    description:
      "Comma-separated per-node database names (derived from infra/catalog/*.yaml)",
    steps: [
      "Auto-derived from infra/catalog/*.yaml — nodes with type=node and a per-env deploy branch are included. Hyphenated node names map to underscored DB names (cogni_${node//-/_}) so they're valid Postgres identifiers.",
    ],
    generate: () => {
      const { readdirSync, readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const root = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
      }).trim();
      const catalogDir = join(root, "infra", "catalog");
      return readdirSync(catalogDir)
        .filter((f: string) => f.endsWith(".yaml") && !f.startsWith("_"))
        .map((f: string) => {
          const raw = readFileSync(join(catalogDir, f), "utf-8");
          const nameMatch = raw.match(/^name:\s*(\S+)/m);
          const typeMatch = raw.match(/^type:\s*(\S+)/m);
          const hasDeployBranch = /^candidate_a_branch:/m.test(raw);
          return nameMatch && typeMatch?.[1] === "node" && hasDeployBranch
            ? `cogni_${nameMatch[1].replace(/-/g, "_")}`
            : null;
        })
        .filter((x: string | null): x is string => x !== null)
        .join(",");
    },
  },
  {
    name: "COGNI_NODE_ENDPOINTS",
    required: true,
    category: "Infrastructure (derived)",
    source: "agent",
    description:
      "Per-node billing callback endpoints (derived from repo-spec node_ids + NodePort map)",
    steps: ["Auto-derived from nodes/*/.cogni/repo-spec.yaml"],
    generate: () => {
      const { readdirSync, readFileSync, existsSync } = require("node:fs");
      const { join } = require("node:path");
      const root = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
      }).trim();
      const portMap: Record<string, number> = {
        operator: 30000,
        poly: 30100,
        resy: 30300,
      };
      return readdirSync(join(root, "nodes"))
        .filter(
          (d: string) =>
            d !== "node-template" &&
            existsSync(join(root, "nodes", d, ".cogni", "repo-spec.yaml"))
        )
        .map((d: string) => {
          const spec = readFileSync(
            join(root, "nodes", d, ".cogni", "repo-spec.yaml"),
            "utf-8"
          );
          const nodeId = spec.match(/^node_id:\s*"([^"]+)"/m)?.[1] ?? d;
          const port = portMap[d] ?? 30000;
          return `${nodeId}=http://host.docker.internal:${port}/api/internal/billing/ingest`;
        })
        .join(",");
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const REPO = "Cogni-DAO/cogni";
/** Deploy environments. Secrets are set per-env, not repo-level. */
const ENVIRONMENTS = ["candidate-a", "preview", "production"] as const;
const LEGACY_ENV_ALIASES: Record<string, (typeof ENVIRONMENTS)[number]> = {
  canary: "candidate-a",
};

/** Track secret values per environment for .env file generation */
const envSecretValues: Record<
  string,
  Record<string, string>
> = Object.fromEntries(ENVIRONMENTS.map((env) => [env, {}]));

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function envStatus(has: boolean): string {
  return has ? `${GREEN}set${RESET}` : `${RED}missing${RESET}`;
}

function getSetSecrets(env: string): Set<string> {
  try {
    const out = execSync(
      `gh secret list --repo ${REPO} --env ${env} 2>/dev/null`,
      {
        encoding: "utf-8",
      }
    );
    return new Set(
      out
        .split("\n")
        .map((l) => l.split("\t")[0])
        .filter(Boolean)
    );
  } catch {
    console.error(
      `Failed to list secrets for ${env}. Is \`gh\` authenticated?`
    );
    process.exit(1);
  }
}

function setSecret(name: string, value: string, env: string): boolean {
  try {
    execSync(`gh secret set ${name} --repo ${REPO} --env ${env}`, {
      input: value,
      encoding: "utf-8",
    });
    // Track for .env file generation
    const envSecrets = envSecretValues[env];
    if (envSecrets) {
      envSecrets[name] = value;
    }
    return true;
  } catch (e) {
    console.error(`  Failed to set ${name} (${env}): ${e}`);
    return false;
  }
}

function setSecretBoth(
  name: string,
  value: string,
  envs: readonly string[] = ENVIRONMENTS
): boolean {
  let ok = true;
  for (const env of envs) {
    if (!setSecret(name, value, env)) ok = false;
  }
  return ok;
}

function setSecretRepo(name: string, value: string): boolean {
  try {
    execSync(`gh secret set ${name} --repo ${REPO}`, {
      input: value,
      encoding: "utf-8",
    });
    return true;
  } catch (e) {
    console.error(`  Failed to set ${name} (repo): ${e}`);
    return false;
  }
}

function getRepoSecrets(): Set<string> {
  try {
    const out = execSync(`gh secret list --repo ${REPO} 2>/dev/null`, {
      encoding: "utf-8",
    });
    return new Set(
      out
        .split("\n")
        .map((l) => l.split("\t")[0])
        .filter(Boolean)
    );
  } catch {
    console.error("Failed to list repo secrets. Is `gh` authenticated?");
    process.exit(1);
  }
}

async function prompt(
  rl: readline.Interface,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Apply secret.transform if defined, otherwise return as-is */
function applyTransform(secret: Secret, value: string): string {
  const v = value.trim();
  return secret.transform ? secret.transform(v) : v;
}

function isPolySecret(secret: Secret): boolean {
  return (
    secret.name === "POLYGON_RPC_URL" ||
    secret.name.startsWith("POLY_") ||
    secret.name.startsWith("PRIVY_USER_WALLETS_")
  );
}

// ── Database DSN helpers ─────────────────────────────────────────────────────

const dbPasswords: Record<string, string> = {};

function buildDSNs(envs: readonly string[]): void {
  const appUser = dbPasswords.APP_DB_USER || "app_user";
  const appPw = dbPasswords.APP_DB_PASSWORD;
  const svcUser = dbPasswords.APP_DB_SERVICE_USER || "app_service";
  const svcPw = dbPasswords.APP_DB_SERVICE_PASSWORD;
  const dbName = dbPasswords.APP_DB_NAME || "cogni_template";
  const host = "postgres"; // Docker service name

  if (appPw) {
    const url = `postgresql://${appUser}:${appPw}@${host}:5432/${dbName}`;
    setSecretBoth("DATABASE_URL", url, envs);
    console.log(`  ${GREEN}DATABASE_URL${RESET} set (${envs.join(", ")})`);
  }
  if (svcPw) {
    const url = `postgresql://${svcUser}:${svcPw}@${host}:5432/${dbName}`;
    setSecretBoth("DATABASE_SERVICE_URL", url, envs);
    console.log(
      `  ${GREEN}DATABASE_SERVICE_URL${RESET} set (preview + production)`
    );
  }
}

// ── Display ──────────────────────────────────────────────────────────────────
// (printInventory removed — inventory now rendered inline in main() using targetEnvs)

function printSecretHeader(
  secret: Secret,
  envSets: Record<string, Set<string>>,
  repoSecrets: Set<string>,
  envNames: readonly string[]
): void {
  const reqTag = secret.required
    ? `${BOLD}[REQUIRED]${RESET}`
    : `${DIM}[optional]${RESET}`;

  console.log("");
  const statusLine = secret.repoLevel
    ? `[repo: ${envStatus(repoSecrets.has(secret.name))}]`
    : `[${envNames.map((e) => `${e}: ${envStatus(envSets[e]?.has(secret.name) ?? false)}`).join(", ")}]`;
  console.log(`  ${reqTag} ${BOLD}${secret.name}${RESET}  ${statusLine}`);
  console.log(`  ${secret.description}`);

  if (secret.url) {
    console.log("");
    console.log(`     ${CYAN}${secret.url}${RESET}`);
    console.log("");
  }

  for (const step of secret.steps) {
    console.log(`     ${step}`);
  }
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes("--all");
  const polyOnly = args.includes("--poly");
  const filterRequired = args.includes("--required");
  const autoGenerate = args.includes("--auto");
  // --only DISCORD,SONAR  or  --only DISCORD_OAUTH_CLIENT_ID
  const onlyArg =
    args.find((a) => a.startsWith("--only="))?.slice(7) ||
    (args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined);
  const onlyPatterns = onlyArg
    ?.split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  // --env canary  or  --env=canary  (target a single environment)
  const rawEnvArg =
    args.find((a) => a.startsWith("--env="))?.slice(6) ||
    (args.includes("--env") ? args[args.indexOf("--env") + 1] : undefined);
  const envArg = rawEnvArg
    ? (LEGACY_ENV_ALIASES[rawEnvArg] ?? rawEnvArg)
    : undefined;
  const targetEnvs: (typeof ENVIRONMENTS)[number][] = envArg
    ? [envArg as (typeof ENVIRONMENTS)[number]]
    : [...ENVIRONMENTS];

  if (
    envArg &&
    !ENVIRONMENTS.includes(envArg as (typeof ENVIRONMENTS)[number])
  ) {
    console.error(
      `Unknown environment: ${envArg}. Must be one of: ${ENVIRONMENTS.join(", ")}`
    );
    process.exit(1);
  }

  if (rawEnvArg === "canary") {
    console.log(
      `  ${YELLOW}Legacy alias detected:${RESET} canary -> candidate-a\n`
    );
  }

  if (envArg) {
    console.log(`  ${CYAN}Targeting environment: ${envArg}${RESET}\n`);
  }
  if (polyOnly) {
    console.log(`  ${CYAN}Poly mode:${RESET} only poly-related secrets\n`);
  }

  // Fetch current secret status for target environments
  const envSecretSets: Record<string, Set<string>> = {};
  for (const env of targetEnvs) {
    envSecretSets[env] = getSetSecrets(env);
  }
  const repoSecrets = getRepoSecrets();
  const inventorySecrets = polyOnly ? SECRETS.filter(isPolySecret) : SECRETS;

  // Print inventory for target environments only
  console.log(
    `\n${BOLD}  Secret Inventory${polyOnly ? " (poly)" : ""} — ${REPO} (${targetEnvs.join(", ")})${RESET}\n`
  );
  console.log(
    `  ${"SECRET".padEnd(42)} ${"LEVEL".padEnd(8)} ${"STATUS".padEnd(22)} ${"SOURCE"}`
  );
  console.log(
    `  ${"─".repeat(42)} ${"─".repeat(8)} ${"─".repeat(22)} ${"─".repeat(8)}`
  );
  let lastCat = "";
  for (const s of inventorySecrets) {
    if (s.category !== lastCat) {
      console.log(`\n  ${DIM}${s.category}${RESET}`);
      lastCat = s.category;
    }
    const req = s.required ? "" : `${DIM}(opt)${RESET} `;
    const src =
      s.source === "agent" ? `${DIM}auto${RESET}` : `${YELLOW}human${RESET}`;
    if (s.repoLevel) {
      const rStatus = envStatus(repoSecrets.has(s.name));
      console.log(
        `  ${req}${s.name.padEnd(s.required ? 42 : 37)} ${DIM}repo${RESET}     ${rStatus.padEnd(31)} ${src}`
      );
    } else {
      const statuses = targetEnvs
        .map((e) => `${e}:${envStatus(envSecretSets[e]?.has(s.name) ?? false)}`)
        .join(" ");
      console.log(
        `  ${req}${s.name.padEnd(s.required ? 42 : 37)} ${DIM}env${RESET}      ${statuses}  ${src}`
      );
    }
  }
  console.log("");

  let filtered = inventorySecrets;
  if (onlyPatterns) {
    filtered = filtered.filter((s) =>
      onlyPatterns.some((p) => s.name.includes(p))
    );
  } else {
    if (filterRequired) {
      filtered = filtered.filter((s) => s.required);
    }
    if (!showAll) {
      filtered = filtered.filter((s) => {
        if (s.repoLevel) return !repoSecrets.has(s.name);
        // Show if missing in ANY target environment
        return targetEnvs.some((e) => !envSecretSets[e]?.has(s.name));
      });
    }
  }

  if (filtered.length === 0) {
    console.log(
      `  ${GREEN}All secrets are set for ${targetEnvs.join(", ")}.${RESET}`
    );
    console.log(`  Run with --all to walk through everything.\n`);
    return;
  }

  console.log(
    `  ${filtered.length} secret(s) to configure. Press Enter to skip any.\n`
  );
  console.log(`  ${"─".repeat(70)}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let set = 0;
  let skipped = 0;
  let lastCategory = "";

  for (const secret of filtered) {
    if (secret.category !== lastCategory) {
      console.log(
        `\n${"═".repeat(2)} ${BOLD}${secret.category}${RESET} ${"═".repeat(60 - secret.category.length)}`
      );
      lastCategory = secret.category;
    }

    printSecretHeader(secret, envSecretSets, repoSecrets, targetEnvs);

    // SSH_DEPLOY_KEY is special — one key per environment
    if (secret.name === "SSH_DEPLOY_KEY") {
      const missingEnvs = targetEnvs.filter(
        (e) => !envSecretSets[e]?.has(secret.name)
      );
      if (missingEnvs.length === 0) {
        console.log(`  ${DIM}SSH_DEPLOY_KEY — already set, skipping${RESET}`);
        skipped++;
        continue;
      }
      if (!autoGenerate) {
        const action = await prompt(
          rl,
          `  Generate SSH keys for ${missingEnvs.join(", ")}? [Y/n] `
        );
        if (action.toLowerCase() === "n") {
          skipped++;
          continue;
        }
      }
      for (const env of missingEnvs) {
        // Reuse existing key from .local/{env}-vm-key if available (matches what's on that env's VM)
        const repoRoot = execSync("git rev-parse --show-toplevel", {
          encoding: "utf-8",
        }).trim();
        const localKeyPath = `${repoRoot}/.local/${env}-vm-key`;
        const { existsSync, readFileSync } = require("node:fs");
        let privKey: string;
        if (existsSync(localKeyPath)) {
          privKey = readFileSync(localKeyPath, "utf-8");
          console.log(
            `  ${DIM}Using existing key from .local/${env}-vm-key${RESET}`
          );
        } else {
          privKey = generateSSHKey(env);
        }
        setSecret(secret.name, privKey, env);
        console.log(`  ${GREEN}SSH_DEPLOY_KEY${RESET} set for ${env}`);
      }
      set++;
      continue;
    }

    // Repo-level secrets (CI, not deploy)
    if (secret.repoLevel) {
      const value = await prompt(
        rl,
        `  Paste value for ${BOLD}repo${RESET} (Enter to skip): `
      );
      if (!value.trim()) {
        skipped++;
        continue;
      }
      const final = applyTransform(secret, value);
      if (setSecretRepo(secret.name, final)) {
        if (final !== value.trim())
          console.log(`  ${DIM}(transformed: ${final})${RESET}`);
        console.log(`  ${GREEN}${secret.name}${RESET} set (repo-level)`);
        set++;
      }
      continue;
    }

    if (secret.source === "agent") {
      // --auto: skip prompt, auto-generate missing agent secrets
      if (autoGenerate) {
        // Only set if missing in at least one target env
        const missing = targetEnvs.some(
          (e) => !envSecretSets[e]?.has(secret.name)
        );
        if (!missing) {
          console.log(`  ${DIM}${secret.name} — already set, skipping${RESET}`);
          skipped++;
          continue;
        }
        const value = secret.generate?.();
        // Only set for envs where it's missing
        const envsToSet = targetEnvs.filter(
          (e) => !envSecretSets[e]?.has(secret.name)
        );
        if (setSecretBoth(secret.name, value, envsToSet)) {
          console.log(
            `  ${GREEN}${secret.name}${RESET} generated + set (${envsToSet.join(", ")})`
          );
          set++;
          if (secret.category === "Database") {
            dbPasswords[secret.name] = value;
          }
        }
      } else {
        const action = await prompt(
          rl,
          `  Generate and set for ${targetEnvs.join(", ")}? [Y/n] `
        );
        if (action.toLowerCase() === "n") {
          skipped++;
          continue;
        }
        const value = secret.generate?.();
        if (setSecretBoth(secret.name, value, targetEnvs)) {
          console.log(
            `  ${GREEN}${secret.name}${RESET} set (${targetEnvs.join(", ")})`
          );
          set++;
          if (secret.category === "Database") {
            dbPasswords[secret.name] = value;
          }
        }
      }
    } else if (secret.perEnv) {
      // Per-env human secrets (DOMAIN, VM_HOST) — ask for each env separately
      for (const env of targetEnvs) {
        const already = envSecretSets[env]?.has(secret.name) ?? false;
        if (already && !showAll) continue;
        const value = await prompt(
          rl,
          `  Value for ${BOLD}${env}${RESET} (Enter to skip): `
        );
        if (!value.trim()) continue;
        const final = applyTransform(secret, value);
        if (final !== value.trim())
          console.log(`  ${DIM}(transformed: ${final})${RESET}`);
        if (setSecret(secret.name, final, env)) {
          console.log(`  ${GREEN}${secret.name}${RESET} set for ${env}`);
          set++;
        }
      }
    } else {
      // Human secrets — ask per-environment
      // Determine which target envs are missing this secret
      const missingEnvs = targetEnvs.filter(
        (e) => !envSecretSets[e]?.has(secret.name)
      );

      if (missingEnvs.length === 0 && !showAll) {
        skipped++;
        continue;
      }

      const envsToSet = missingEnvs.length > 0 ? missingEnvs : targetEnvs;
      if (missingEnvs.length > 0 && missingEnvs.length < targetEnvs.length) {
        console.log(`  ${DIM}(missing in ${missingEnvs.join(", ")})${RESET}`);
      }

      // Prompt for each environment
      let didSet = false;
      for (const env of envsToSet) {
        const value = await prompt(
          rl,
          `  Paste value for ${BOLD}${env}${RESET} (Enter to skip): `
        );
        if (!value.trim()) continue;
        const final = applyTransform(secret, value);
        if (final !== value.trim())
          console.log(`  ${DIM}(transformed: ${final})${RESET}`);
        if (setSecret(secret.name, final, env)) {
          console.log(`  ${GREEN}${secret.name}${RESET} set for ${env}`);
          didSet = true;
        }
      }
      if (didSet) set++;
      else skipped++;
    }
  }

  // Build DATABASE_URL and DATABASE_SERVICE_URL from collected passwords
  if (dbPasswords.APP_DB_PASSWORD || dbPasswords.APP_DB_SERVICE_PASSWORD) {
    console.log(
      `\n${"═".repeat(2)} ${BOLD}Derived Database URLs${RESET} ${"═".repeat(41)}`
    );
    buildDSNs(targetEnvs);
  }

  // Write .env.{env} files for each environment that had secrets set
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();

  for (const env of targetEnvs) {
    const secrets = envSecretValues[env];
    if (!secrets || Object.keys(secrets).length === 0) continue;

    const envFile = `${repoRoot}/.env.${env}`;
    const { readFileSync, writeFileSync, chmodSync, existsSync } = await import(
      "node:fs"
    );

    // Merge with existing .env file — never lose previously set values
    const existing: Record<string, string> = {};
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        const eqIdx = line.indexOf("=");
        const key = line.slice(0, eqIdx);
        let val = line.slice(eqIdx + 1);
        if (val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1).replace(/'\\'''/g, "'");
        }
        if (/^[A-Z_][A-Z0-9_]*$/.test(key)) {
          existing[key] = val;
        }
      }
    }

    const merged = { ...existing, ...secrets };
    const lines = [
      `# setup-secrets.ts — ${new Date().toISOString()}`,
      `# Source of truth for ${env} environment secrets.`,
      `# Read by: provision-test-vm.sh, deploy-infra.sh (via GitHub env)`,
      `# DO NOT commit this file (gitignored).`,
      "",
      ...Object.entries(merged).map(
        ([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`
      ),
      "",
    ];
    writeFileSync(envFile, lines.join("\n"));
    chmodSync(envFile, 0o600);
    console.log(
      `  ${GREEN}Saved${RESET} .env.${env} (${Object.keys(merged).length} total, ${Object.keys(secrets).length} new/updated)`
    );
  }

  console.log(
    `\n  Done. ${GREEN}${set} set${RESET}, ${DIM}${skipped} skipped${RESET}.\n`
  );
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
