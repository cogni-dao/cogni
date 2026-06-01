#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/setup/bootstrap.sh — agentic fork bootstrap entry point.
#
# Spec:  docs/spec/agentic-fork-bootstrap.md
# Usage: pnpm bootstrap
#
# Two-phase, idempotent:
#   • .env.bootstrap missing → copy template, print instructions, exit 0
#   • .env.bootstrap present → validate + provision end-to-end

set -euo pipefail

# Bash 4+ preflight — uses associative arrays (declare -A) and `mapfile`,
# both Bash 4+ features. macOS /bin/bash is 3.2; without this guard the
# script fails opaquely 30 lines in on `declare -A INSTALLER=(...)`.
# Canonical fix is the installer wrapper; print the one-line command.
if (( BASH_VERSINFO[0] < 4 )); then
  printf 'bootstrap.sh requires Bash 4+ (current: %s).\n' "$BASH_VERSION" >&2
  printf 'Install via the canonical wrapper:\n' >&2
  printf '  bash scripts/bootstrap/install/install-bash.sh\n' >&2
  printf 'Then re-run pnpm bootstrap from a shell where `bash --version` reports 4+.\n' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOOT_FILE="$REPO_ROOT/.env.bootstrap"
BOOT_TEMPLATE="$REPO_ROOT/.env.bootstrap.example"

# shellcheck source=./scripts/setup/lib/fork-identity.sh
source "$SCRIPT_DIR/lib/fork-identity.sh"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; NC=$'\033[0m'
log()   { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
err()   { echo -e "${RED}[bootstrap]${NC} $*" >&2; }
step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }

# ── Phase 0: template-or-execute gate ────────────────────────────────────────
# First run: create .env.bootstrap, open it in $EDITOR, then exit so the human
# can paste in 5 values and re-run. One command, two passes — no checklists.
if [[ ! -f "$BOOT_FILE" ]]; then
  cp "$BOOT_TEMPLATE" "$BOOT_FILE"
  chmod 600 "$BOOT_FILE"
  cat <<EOF

${GREEN}${BOLD}Created .env.bootstrap.${NC}

Fill in the 4 credential sections plus DEPLOY_ENV, save & close the editor,
then run ${BOLD}pnpm bootstrap${NC} again.

EOF
  # P1 — Skip editor open under non-TTY (agent / CI / sandbox shell). nano
  # in particular "opens" then immediately exits in non-TTY mode, the file
  # stays empty, and the human only discovers it on the re-run. Just tell
  # the caller to open the file themselves; the next `pnpm bootstrap` will
  # pick up edits whenever they're saved.
  if [[ ! -t 0 ]]; then
    warn "Non-TTY shell detected (likely agent/CI) — not opening an editor."
    log  "Edit ${BOLD}${BOOT_FILE}${NC} in your real editor, save, then run ${BOLD}pnpm bootstrap${NC} again."
    exit 0
  fi
  # Open in the human's editor of choice. Falls back through common defaults.
  EDITOR_CMD="${VISUAL:-${EDITOR:-}}"
  if [[ -z "$EDITOR_CMD" ]]; then
    for c in code cursor nano vim vi open; do
      command -v "$c" >/dev/null 2>&1 && EDITOR_CMD="$c" && break
    done
  fi
  if [[ -n "$EDITOR_CMD" ]]; then
    log "Opening with: ${EDITOR_CMD}"
    # `code`/`cursor` need --wait to block until the file is saved-and-closed.
    case "$EDITOR_CMD" in
      code|cursor) "$EDITOR_CMD" --wait "$BOOT_FILE" || true ;;
      open)        "$EDITOR_CMD" -e "$BOOT_FILE" || true ;;
      *)           "$EDITOR_CMD" "$BOOT_FILE" || true ;;
    esac
  else
    warn "No editor found. Open .env.bootstrap manually in your editor."
  fi
  echo ""
  log "When ready, run: ${BOLD}pnpm bootstrap${NC}"
  exit 0
fi

# ── Ingest .env.bootstrap ────────────────────────────────────────────────────
chmod 600 "$BOOT_FILE" 2>/dev/null || true
if ! git -C "$REPO_ROOT" check-ignore "$BOOT_FILE" >/dev/null 2>&1; then
  err ".env.bootstrap is NOT gitignored. Refusing to read."
  err "Add .env.bootstrap to .gitignore (or confirm .env* covers it) and re-run."
  exit 2
fi

# shellcheck disable=SC1090
set -a; source "$BOOT_FILE"; set +a

DEPLOY_ENV="${DEPLOY_ENV:-candidate-a}"
log "Target environment: ${BOLD}${DEPLOY_ENV}${NC}"

# ── Phase 1: validate required inputs + prerequisites ────────────────────────
step "Phase 1 · Validate inputs + tooling"

REQUIRED=(
  CHERRY_AUTH_TOKEN CHERRY_PROJECT_ID
  CLOUDFLARE_API_TOKEN CLOUDFLARE_ZONE_ID
  GITHUB_ADMIN_PAT GITHUB_ADMIN_USERNAME
)
# task.0284 — OPENROUTER_API_KEY moved out of bootstrap; it's an app secret
# entered via `pnpm secrets:set <env> node-template OPENROUTER_API_KEY` after
# the substrate (OpenBao + ESO) is up. See docs/guides/secrets-add-new.md.
MISSING=()
for v in "${REQUIRED[@]}"; do
  [[ -z "${!v:-}" ]] && MISSING+=("$v")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  err "Missing required values in .env.bootstrap:"
  printf '  - %s\n' "${MISSING[@]}" >&2
  exit 2
fi

# Fork domain: SSOT is FORK_DOMAIN_ROOT (GH repo variable in the GHA
# path; exported shell var in the laptop fallback). The operator's
# .env.bootstrap::CLOUDFLARE_ZONE_ID resolves to a zone name we cross-
# check FORK_DOMAIN_ROOT against. Mismatch = clear abort.
ZONE_RESP=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}")
ZONE_OK=$(printf '%s' "$ZONE_RESP" | jq -r '.success // false')
if [[ "$ZONE_OK" != "true" ]]; then
  err "Cloudflare zone ${CLOUDFLARE_ZONE_ID} unreachable with the provided token."
  err "Response: $(printf '%s' "$ZONE_RESP" | jq -c '.errors // .' 2>/dev/null || printf '%s' "$ZONE_RESP")"
  exit 2
fi
CLOUDFLARE_ZONE_NAME=$(printf '%s' "$ZONE_RESP" | jq -r '.result.name')
[[ -n "$CLOUDFLARE_ZONE_NAME" && "$CLOUDFLARE_ZONE_NAME" != "null" ]] || {
  err "Cloudflare API returned no zone name for ID ${CLOUDFLARE_ZONE_ID}."
  exit 2
}
log "Cloudflare zone reachable: ${BOLD}${CLOUDFLARE_ZONE_NAME}${NC} (id ${CLOUDFLARE_ZONE_ID})"

# Probe Zone:Zone Settings:Edit scope. provision-env-vm.sh Phase 4b PATCHes
# zone settings/ssl → 'full' to enable the cloudflare-proxy + tls-internal
# architecture. If the token only has DNS:Edit, Phase 4b fails AFTER the
# Cherry VM has been provisioned and billed. Fail-fast here, before any
# side effects, with a literal template the operator can copy/paste.
SSL_PROBE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl")
if [[ "$SSL_PROBE_CODE" != "200" ]]; then
  cat <<EOF >&2

🛑 CLOUDFLARE_API_TOKEN is missing the Zone:Zone Settings:Edit scope.
   (HTTP ${SSL_PROBE_CODE} from GET /zones/${CLOUDFLARE_ZONE_ID}/settings/ssl)

Bootstrap PATCHes zone SSL mode to 'Full' at Phase 4b — that's the
cloudflare-proxy + tls-internal architecture (see Step 6.2 of
docs/runbooks/fork-quickstart.md).

Fix (one-time):
  1. Open https://dash.cloudflare.com/profile/api-tokens
  2. Either edit the existing token, or create a new one ('Create Token'
     → 'Get started' under 'Custom token').
  3. Set permissions to BOTH:
       • Zone — DNS — Edit
       • Zone — Zone Settings — Edit
  4. Zone Resources: Include — Specific zone — ${CLOUDFLARE_ZONE_NAME}
  5. Save and copy the token.
  6. Update the fork's GH env secret:
       gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo> --env ${DEPLOY_ENV:-candidate-a}
  7. Re-trigger provision-env.yml.

EOF
  err "Cloudflare token scope check failed. Aborting before VM provisioning."
  exit 2
fi
log "Cloudflare token scope: DNS:Edit + Zone Settings:Edit ✓"

FORK_ROOT="${FORK_DOMAIN_ROOT:-}"
if [[ -z "$FORK_ROOT" ]]; then
  cat <<EOF >&2

🛑 FORK_DOMAIN_ROOT is not set.

This is the non-secret Cloudflare zone name your fork owns
(e.g. example.com). Used to derive every public URL.

Set it as a GitHub repo variable:
  gh variable set FORK_DOMAIN_ROOT --repo <owner>/<repo> --body ${CLOUDFLARE_ZONE_NAME}

For the laptop-fallback path, export it before running:
  export FORK_DOMAIN_ROOT=${CLOUDFLARE_ZONE_NAME}

(Or add FORK_DOMAIN_ROOT=${CLOUDFLARE_ZONE_NAME} to .env.bootstrap;
bootstrap.sh sources it under \`set -a\`.)

EOF
  err "FORK_DOMAIN_ROOT unset. Aborting before VM provisioning."
  exit 2
elif [[ "$FORK_ROOT" != "$CLOUDFLARE_ZONE_NAME" ]]; then
  err "Mismatch: FORK_DOMAIN_ROOT='${FORK_ROOT}' but Cloudflare zone ID ${CLOUDFLARE_ZONE_ID} resolves to '${CLOUDFLARE_ZONE_NAME}'."
  err "Reconcile FORK_DOMAIN_ROOT or .env.bootstrap::CLOUDFLARE_ZONE_ID and re-run."
  exit 2
else
  log "Fork domain root: ${BOLD}${FORK_ROOT}${NC} (FORK_DOMAIN_ROOT + Cloudflare API agree)"
fi

FORK_SLUG=$(fork_identity_slug "$REPO_ROOT")
if [[ -z "$FORK_SLUG" ]]; then
  err "Unable to derive fork slug from FORK_SLUG env var or git origin."
  exit 2
fi
log "Fork infra slug: ${BOLD}${FORK_SLUG}${NC} (used for VM DNS aliases)"

# Derive DOMAIN from FORK_ROOT + DEPLOY_ENV using the same convention as
# provision-env-vm.sh. Single source (FORK_DOMAIN_ROOT env var), two
# consumers (bootstrap.sh writes secrets here; provision-env-vm.sh
# re-derives the same value). Both compute the same answer — no drift
# risk because the convention is shared.
DOMAIN=$(domain_for_env "$DEPLOY_ENV" "$FORK_ROOT") || { err "Unsupported DEPLOY_ENV: $DEPLOY_ENV"; exit 2; }
VM_DNS_HOST=$(vm_host_for_env "$DEPLOY_ENV" "$FORK_ROOT" "$FORK_SLUG")
log "Derived DOMAIN: ${BOLD}${DOMAIN}${NC} (for $DEPLOY_ENV)"
log "Derived VM DNS host: ${BOLD}${VM_DNS_HOST}${NC}"

# Installer hints reference scripts/bootstrap/install/install-<tool>.sh
# instead of brew/apt — these are the canonical wrappers for this repo and
# handle platform differences (don't reinvent the wheel).
declare -A INSTALLER=(
  [pnpm]="scripts/bootstrap/install/install-pnpm.sh"
  [tofu]="scripts/bootstrap/install/install-tofu.sh"
  [yq]="scripts/bootstrap/install/install-yq.sh"
)
for tool in gh tofu ssh-keygen age-keygen openssl curl jq yq pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "Required CLI not found: $tool"
    if [[ -n "${INSTALLER[$tool]:-}" ]]; then
      err "  Install: bash ${INSTALLER[$tool]}"
    else
      err "  Install via your OS package manager (brew/apt). Re-run when ready."
    fi
    exit 2
  fi
done

# Detect repo from origin (works for forks)
ORIGIN_URL=$(git -C "$REPO_ROOT" remote get-url origin)
GH_REPO=$(echo "$ORIGIN_URL" | sed -E 's#.*github.com[:/]([^/]+/[^/.]+).*#\1#')
log "GitHub repo: ${BOLD}${GH_REPO}${NC}"

# Refuse to run inside the upstream node template. Bootstrap mutates secrets,
# environments, and deploy branches — it must target a repo that owns its
# deploy state. The hub (Cogni-DAO/cogni) is valid; the bare template is not.
if [[ "$GH_REPO" == "Cogni-DAO/node-template" ]]; then
  err "origin points at the upstream node template (${GH_REPO}). Bootstrap must run inside the hub or a fork."
  err "Fork first for node-template: see docs/runbooks/fork-quickstart.md"
  exit 2
fi

export GH_TOKEN="$GITHUB_ADMIN_PAT"

# A3 — Validate GITHUB_ADMIN_USERNAME matches the PAT's actual login.
# Canary tripped on `i_am_coco` (underscore) vs `i-am-coco` (hyphen);
# GitHub usernames disallow underscores so this would otherwise 404 the
# admin-role check below with a misleading "user not found" message.
PAT_LOGIN=$(gh api user --jq .login 2>/dev/null || echo "")
if [[ -z "$PAT_LOGIN" ]]; then
  err "GITHUB_ADMIN_PAT failed to authenticate (gh api user returned empty)."
  err "Mint a fresh PAT and update .env.bootstrap."
  exit 2
fi
if [[ "$PAT_LOGIN" != "$GITHUB_ADMIN_USERNAME" ]]; then
  err "GITHUB_ADMIN_USERNAME='${GITHUB_ADMIN_USERNAME}' does not match the PAT's login '${PAT_LOGIN}'."
  err "GitHub usernames disallow underscores — did you mistype? Use ${BOLD}${PAT_LOGIN}${NC} in .env.bootstrap."
  exit 2
fi

# Admin-role check at ingest (spec §Validating Admin role).
PERM=$(gh api "repos/${GH_REPO}/collaborators/${GITHUB_ADMIN_USERNAME}/permission" \
       --jq '.permission' 2>/dev/null || echo "")
if [[ "$PERM" != "admin" ]]; then
  err "GitHub user '${GITHUB_ADMIN_USERNAME}' lacks Admin role on ${GH_REPO}."
  err "Got: '${PERM:-<unable to read>}'. Required: 'admin'."
  err "Fix: GitHub → repo Settings → Collaborators and teams → Add ${GITHUB_ADMIN_USERNAME} as Admin."
  exit 2
fi
log "Admin role verified for ${GITHUB_ADMIN_USERNAME}"

# FORK_IMAGE_NAME — derived, never hand-typed. GHCR package-write is
# owner-scoped, so a fork must build + push to its OWN namespace; pushing to
# upstream's ghcr.io/cogni-dao/... fails with `permission_denied`. Unlike
# FORK_DOMAIN_ROOT (an external Cloudflare fact the human must supply), this is
# fully computable from the repo owner — so we derive + set it here rather than
# asking. Two consumers read it: CI build workflows via
# `${{ vars.FORK_IMAGE_NAME || upstream-default }}`, and provision-env-vm.sh via
# the exported env below. (bug.5083)
if [[ "$GH_REPO" == "Cogni-DAO/cogni" ]]; then
  log "Hub repo detected; image namespace remains catalog/default-driven"
else
  FORK_IMAGE_NAME=$(fork_image_name "$REPO_ROOT")
  export FORK_IMAGE_NAME
  log "Fork image namespace: ${BOLD}${FORK_IMAGE_NAME}${NC} (derived from origin owner)"
  if gh variable set FORK_IMAGE_NAME --repo "$GH_REPO" --body "$FORK_IMAGE_NAME" >/dev/null 2>&1; then
    log "Set GH repo variable FORK_IMAGE_NAME (CI builds push here)"
  else
    warn "Could not set FORK_IMAGE_NAME repo variable (gh scope?); CI uses the upstream default until set:"
    warn "  gh variable set FORK_IMAGE_NAME --repo ${GH_REPO} --body ${FORK_IMAGE_NAME}"
  fi
fi

# B1 fail-fast — confirm push access on origin BEFORE spending money on a
# Cherry VM. Canary's auto-flight died at Phase 4c with 'fatal: 403' after
# a VM was already billed because origin pointed at the upstream template
# the bot couldn't write to. (Admin role implies push, but checking
# explicitly catches token-scope mismatches that don't surface in role
# checks alone.)
CAN_PUSH=$(gh api "repos/${GH_REPO}" --jq '.permissions.push // false' 2>/dev/null || echo "false")
if [[ "$CAN_PUSH" != "true" ]]; then
  err "GITHUB_ADMIN_PAT lacks push access on ${GH_REPO} (got permissions.push=${CAN_PUSH})."
  err "This would fail Phase 4c (env-state push) AFTER the Cherry VM is already billed."
  err "Re-mint the PAT with Contents:Write on this repo, then re-run."
  exit 2
fi
log "Push access verified — bootstrap will not strand a billed VM at Phase 4c."

# Cloudflare zone reachability: already validated earlier when deriving
# CLOUDFLARE_ZONE_NAME from the same API endpoint. Skip the duplicate call.

# Cherry token validation (use /v1/teams, not /v1/regions — see node-setup SKILL)
CHERRY_OK=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $CHERRY_AUTH_TOKEN" "https://api.cherryservers.com/v1/teams")
[[ "$CHERRY_OK" == "200" ]] || { err "Cherry token rejected (HTTP $CHERRY_OK)"; exit 2; }
log "Cherry token verified"

# ── Phase 2: generate agent secrets + write .env.${DEPLOY_ENV} ───────────────
step "Phase 2 · Generate agent secrets"

ENV_FILE="$REPO_ROOT/.env.${DEPLOY_ENV}"
mkdir -p "$REPO_ROOT/.local"

rand64() { openssl rand -base64 "${1:-32}" | tr -d '\n='; }
randHex() { openssl rand -hex "${1:-32}"; }

# Per-env DB names + users (matches existing convention in setup-secrets.ts)
APP_DB_NAME="cogni_operator"
APP_DB_USER="app_user"
APP_DB_SERVICE_USER="app_service"
APP_DB_READONLY_USER="app_readonly"
TEMPORAL_DB_USER="temporal"

# Generate (or reuse) all openssl-rand values. ENV_FILE is the source of truth
# so re-runs stay idempotent (reuses prior values; only fresh ones are minted).
declare -A GEN=()
if [[ -f "$ENV_FILE" ]]; then
  log "Reusing existing $ENV_FILE (idempotent re-run)"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi
declare_or_gen() {
  local name="$1" generator="$2"
  if [[ -n "${!name:-}" ]]; then GEN[$name]="${!name}"; return; fi
  GEN[$name]="$($generator)"
}
declare_or_gen AUTH_SECRET                "rand64 32"
declare_or_gen LITELLM_MASTER_KEY         "echo sk-cogni-$(randHex 24)"
declare_or_gen OPENCLAW_GATEWAY_TOKEN     "rand64 32"
declare_or_gen SCHEDULER_API_TOKEN        "rand64 32"
declare_or_gen BILLING_INGEST_TOKEN       "rand64 32"
declare_or_gen INTERNAL_OPS_TOKEN         "rand64 32"
declare_or_gen METRICS_TOKEN              "rand64 32"
declare_or_gen GH_WEBHOOK_SECRET          "randHex 32"
declare_or_gen POSTGRES_ROOT_PASSWORD     "randHex 32"
declare_or_gen APP_DB_PASSWORD            "randHex 32"
declare_or_gen APP_DB_SERVICE_PASSWORD    "randHex 32"
declare_or_gen APP_DB_READONLY_PASSWORD   "randHex 32"
declare_or_gen TEMPORAL_DB_PASSWORD       "randHex 32"
declare_or_gen OPENCLAW_GITHUB_RW_TOKEN   "echo $GITHUB_ADMIN_PAT"  # v1: reuse admin PAT
declare_or_gen CONNECTIONS_ENCRYPTION_KEY "randHex 32"
declare_or_gen POLY_WALLET_AEAD_KEY_HEX   "randHex 32"
POLY_WALLET_AEAD_KEY_ID="${POLY_WALLET_AEAD_KEY_ID:-v1}"

# Write .env.${DEPLOY_ENV} — provision-env-vm.sh reads this
cat > "$ENV_FILE" <<EOF
# Auto-generated by scripts/setup/bootstrap.sh for ${DEPLOY_ENV}. Do not commit.
APP_DB_NAME=${APP_DB_NAME}
APP_DB_USER=${APP_DB_USER}
APP_DB_SERVICE_USER=${APP_DB_SERVICE_USER}
APP_DB_READONLY_USER=${APP_DB_READONLY_USER}
TEMPORAL_DB_USER=${TEMPORAL_DB_USER}
POSTGRES_ROOT_USER=postgres
POSTGRES_ROOT_PASSWORD=${GEN[POSTGRES_ROOT_PASSWORD]}
APP_DB_PASSWORD=${GEN[APP_DB_PASSWORD]}
APP_DB_SERVICE_PASSWORD=${GEN[APP_DB_SERVICE_PASSWORD]}
APP_DB_READONLY_PASSWORD=${GEN[APP_DB_READONLY_PASSWORD]}
TEMPORAL_DB_PASSWORD=${GEN[TEMPORAL_DB_PASSWORD]}
AUTH_SECRET=${GEN[AUTH_SECRET]}
LITELLM_MASTER_KEY=${GEN[LITELLM_MASTER_KEY]}
OPENCLAW_GATEWAY_TOKEN=${GEN[OPENCLAW_GATEWAY_TOKEN]}
OPENCLAW_GITHUB_RW_TOKEN=${GEN[OPENCLAW_GITHUB_RW_TOKEN]}
SCHEDULER_API_TOKEN=${GEN[SCHEDULER_API_TOKEN]}
BILLING_INGEST_TOKEN=${GEN[BILLING_INGEST_TOKEN]}
INTERNAL_OPS_TOKEN=${GEN[INTERNAL_OPS_TOKEN]}
METRICS_TOKEN=${GEN[METRICS_TOKEN]}
GH_WEBHOOK_SECRET=${GEN[GH_WEBHOOK_SECRET]}
CONNECTIONS_ENCRYPTION_KEY=${GEN[CONNECTIONS_ENCRYPTION_KEY]}
POLY_WALLET_AEAD_KEY_HEX=${GEN[POLY_WALLET_AEAD_KEY_HEX]}
POLY_WALLET_AEAD_KEY_ID=${POLY_WALLET_AEAD_KEY_ID}
EOF
chmod 600 "$ENV_FILE"
log "Wrote $ENV_FILE"

# Mirror to .env.operator for provision-env-vm.sh (which reads that path)
cat > "$REPO_ROOT/.env.operator" <<EOF
CHERRY_AUTH_TOKEN=${CHERRY_AUTH_TOKEN}
CHERRY_PROJECT_ID=${CHERRY_PROJECT_ID}
CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}
CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID}
GHCR_DEPLOY_TOKEN=${GITHUB_ADMIN_PAT}
GHCR_DEPLOY_USERNAME=${GITHUB_ADMIN_USERNAME}
DOMAIN=${DOMAIN}
EOF
chmod 600 "$REPO_ROOT/.env.operator"
log "Wrote .env.operator (consumed by provision-env-vm.sh)"

# ── Phase 3: GitHub environment + secret PUTs ────────────────────────────────
step "Phase 3 · GitHub env + secrets"

# Create the GitHub environment (idempotent — PUT)
gh api -X PUT "repos/${GH_REPO}/environments/${DEPLOY_ENV}" >/dev/null
log "Environment ${DEPLOY_ENV} present"

set_env_secret() {
  local name="$1" val="$2"
  [[ -z "$val" ]] && return 0
  gh secret set "$name" --repo "$GH_REPO" --env "$DEPLOY_ENV" --body "$val" >/dev/null
  echo "    · $name"
}
set_repo_secret() {
  local name="$1" val="$2"
  [[ -z "$val" ]] && return 0
  gh secret set "$name" --repo "$GH_REPO" --body "$val" >/dev/null
  echo "    · $name (repo)"
}
set_repo_var() {
  local name="$1" val="$2"
  [[ -z "$val" ]] && return 0
  gh variable set "$name" --repo "$GH_REPO" --body "$val" >/dev/null 2>&1 || \
    gh variable set "$name" --repo "$GH_REPO" --env "$DEPLOY_ENV" --body "$val" >/dev/null
  echo "    · $name (var)"
}

log "Repo-level secrets:"
set_repo_secret CHERRY_AUTH_TOKEN          "$CHERRY_AUTH_TOKEN"
set_repo_secret GHCR_DEPLOY_TOKEN          "$GITHUB_ADMIN_PAT"
set_repo_secret ACTIONS_AUTOMATION_BOT_PAT "$GITHUB_ADMIN_PAT"
set_repo_secret GIT_READ_TOKEN             "$GITHUB_ADMIN_PAT"

# Provisioning floor consumed by provision-env.yml's env: block (Cloudflare,
# Cherry project, GH-admin). Previously these had to be hand-set with
# `gh secret set` per env — the seam. Push them from .env.bootstrap so it is
# the single source for the whole minting floor (no manual gh).
log "Env-level provisioning floor (provision-env.yml-consumed):"
set_env_secret CLOUDFLARE_API_TOKEN "$CLOUDFLARE_API_TOKEN"
set_env_secret CLOUDFLARE_ZONE_ID   "$CLOUDFLARE_ZONE_ID"
set_env_secret CHERRY_PROJECT_ID    "$CHERRY_PROJECT_ID"
set_env_secret GH_ADMIN_PAT         "$GITHUB_ADMIN_PAT"
set_env_secret GH_ADMIN_USERNAME    "$GITHUB_ADMIN_USERNAME"

log "Env-level agent-generated secrets:"
for k in AUTH_SECRET LITELLM_MASTER_KEY OPENCLAW_GATEWAY_TOKEN OPENCLAW_GITHUB_RW_TOKEN \
         SCHEDULER_API_TOKEN BILLING_INGEST_TOKEN INTERNAL_OPS_TOKEN METRICS_TOKEN \
         GH_WEBHOOK_SECRET CONNECTIONS_ENCRYPTION_KEY \
         POLY_WALLET_AEAD_KEY_HEX POSTGRES_ROOT_PASSWORD \
         APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD APP_DB_READONLY_PASSWORD \
         TEMPORAL_DB_PASSWORD; do
  set_env_secret "$k" "${GEN[$k]:-${!k:-}}"
done
set_env_secret APP_DB_NAME              "$APP_DB_NAME"
set_env_secret APP_DB_USER              "$APP_DB_USER"
set_env_secret APP_DB_SERVICE_USER      "$APP_DB_SERVICE_USER"
set_env_secret APP_DB_READONLY_USER     "$APP_DB_READONLY_USER"
set_env_secret TEMPORAL_DB_USER         "$TEMPORAL_DB_USER"
set_env_secret POSTGRES_ROOT_USER       "postgres"
set_env_secret POLY_WALLET_AEAD_KEY_ID  "$POLY_WALLET_AEAD_KEY_ID"

log "Env-level config (non-secret):"
set_env_secret DOMAIN                       "$DOMAIN"
set_repo_var   DOMAIN                       "$DOMAIN"
# task.0284 — OPENROUTER_API_KEY, GRAFANA_CLOUD_LOKI_*, PROMETHEUS_*, DISCORD_*,
# OAuth client creds, Privy/Polymarket external creds: ALL moved out of GH env.
# They flow OpenBao → ESO → native k8s Secret (Spec Invariant 5
# OPENBAO_IS_SINGLE_SOURCE_OF_TRUTH). Operator enters them post-bootstrap via:
#   pnpm secrets:set <env> node-template OPENROUTER_API_KEY
#   pnpm secrets:set <env> node-template GRAFANA_CLOUD_LOKI_API_KEY
#   ...
# See docs/guides/secrets-add-new.md. Phase 6 of this script prints the list.

# DSNs — construct from parts. provision-env-vm.sh re-derives with VM IP after
# tofu apply; this pre-set is for env validation (server-env.ts requires them
# to exist at deploy time). They'll be re-set with the real VM IP in Phase 4.
set_env_secret DATABASE_URL          "postgresql://${APP_DB_USER}:${GEN[APP_DB_PASSWORD]}@127.0.0.1:5432/${APP_DB_NAME}?sslmode=disable"
set_env_secret DATABASE_SERVICE_URL  "postgresql://${APP_DB_SERVICE_USER}:${GEN[APP_DB_SERVICE_PASSWORD]}@127.0.0.1:5432/${APP_DB_NAME}?sslmode=disable"

# ── Phase 4: provision VM + DNS + deploy branch (Steps A+B+partial-D) ────────
step "Phase 4 · Provision VM + DNS via provision-env-vm.sh"
log "Delegating to scripts/setup/provision-env-vm.sh (already validated)"

# Pass DOMAIN through so candidate-a inherits the FQDN we want
export DOMAIN
bash "$REPO_ROOT/scripts/setup/provision-env-vm.sh" "$DEPLOY_ENV" --yes

# Post-provision: re-set DATABASE_URLs with real IP and VM_HOST with DNS alias
VM_IP=$(cat "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-ip")
log "VM_IP=${VM_IP}; updating DATABASE_URLs and VM_HOST=${VM_DNS_HOST} in GitHub env"
set_env_secret VM_HOST "$VM_DNS_HOST"
set_env_secret DATABASE_URL         "postgresql://${APP_DB_USER}:${GEN[APP_DB_PASSWORD]}@${VM_IP}:5432/${APP_DB_NAME}?sslmode=disable"
set_env_secret DATABASE_SERVICE_URL "postgresql://${APP_DB_SERVICE_USER}:${GEN[APP_DB_SERVICE_PASSWORD]}@${VM_IP}:5432/${APP_DB_NAME}?sslmode=disable"

# SSH key + age key → GitHub env (provision-env-vm.sh wrote them to .local/)
set_env_secret SSH_DEPLOY_KEY "$(cat "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key")"

# Deploy + readyz verification happens inside provision-env-vm.sh:
#   • Phase 7 applies the ApplicationSets — Argo reconciles deploy/* automatically
#   • Phase 9 polls /readyz on each node with a 5-min budget and reports green/red
# No further dispatch needed here. The legacy `gh workflow run
# promote-and-deploy.yml -f environment=candidate-a` call belonged to a
# pre-Argo-substrate architecture; that workflow only accepts preview |
# production and returns HTTP 422 for candidate-a (bug.0446 post-green
# blocker surfaced on validator run 26544140153).

cat <<EOF

${GREEN}${BOLD}Bootstrap complete.${NC}

Environment:  ${DEPLOY_ENV}
Domain:       https://${DOMAIN}
VM IP:        ${VM_IP}
VM DNS:       ${VM_DNS_HOST}
GitHub env:   https://github.com/${GH_REPO}/settings/environments

${BOLD}App secrets — enter via the substrate now${NC} (task.0284):
  Pods that depend on external creds will CrashLoop until you set them.

  pnpm secrets:set ${DEPLOY_ENV} node-template OPENROUTER_API_KEY     # mandatory
  pnpm secrets:set ${DEPLOY_ENV} node-template GRAFANA_CLOUD_LOKI_API_KEY   # optional
  pnpm secrets:set ${DEPLOY_ENV} node-template PROMETHEUS_REMOTE_WRITE_URL # optional
  pnpm secrets:set ${DEPLOY_ENV} node-template PROMETHEUS_PASSWORD         # optional

  Catalog of accepted services: ls infra/catalog/*.yaml
  Guides: docs/guides/secrets-add-new.md  |  docs/guides/secrets-rotate.md

Re-running ${BOLD}pnpm bootstrap${NC} is safe (idempotent).

Next:
  • To provision preview:    DEPLOY_ENV=preview pnpm bootstrap
  • To provision production: DEPLOY_ENV=production pnpm bootstrap
  • To delete .env.bootstrap: rm .env.bootstrap  (values persist in OpenBao + GitHub env)

EOF
