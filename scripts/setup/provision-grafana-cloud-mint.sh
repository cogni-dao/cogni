#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Phase 5e Grafana auto-mint — single-root-token derivation.
#
# Input: ONE Grafana Cloud admin token (glc_*) with scopes:
#   stacks:read, stack-service-accounts:write,
#   accesspolicies:read, accesspolicies:write
# Output: BOTH the read-path child SA token (glsa_*) AND the write-path
# (Loki/Prom push) access-policy token (glc_*) derived from that one root.
# Replaces the older glsa_-parent design (which could not mint write tokens —
# the access-policy API is Cloud-side only).
#
# API surface (canonical paths; verified against the upstream gcom client
# https://github.com/grafana/grafana-com-public-clients/tree/main/go/gcom
# and https://grafana.com/docs/grafana-cloud/developer-resources/api-reference/cloud-api/):
#   GET  grafana.com/api/orgs                                              → orgs list
#   GET  grafana.com/api/orgs/<slug>/instances                             → stacks + regionSlug
#         response field names (verbatim):
#           id, slug, url, regionSlug,
#           hlInstanceUrl, hlInstanceId   (Loki write URL + numeric user)
#           hmInstancePromUrl, hmInstancePromId (Prom write URL + numeric user)
#   GET  grafana.com/api/instances/<slug>/api/serviceaccounts/search       → find Cloud-side SA
#   POST grafana.com/api/instances/<slug>/api/serviceaccounts              → create Cloud-side SA
#   POST grafana.com/api/instances/<slug>/api/serviceaccounts/<id>/tokens  → mint glsa_
#   GET  grafana.com/api/v1/accesspolicies?region=<slug>&name=<n>          → find policy
#   POST grafana.com/api/v1/accesspolicies?region=<slug>                   → create policy
#   POST grafana.com/api/v1/tokens?region=<slug>                           → mint glc_
#
# Inputs (env):
#   GH_GRAFANA_CLOUD_ADMIN_TOKEN  glc_* Cloud admin token (see scope list above)
#   GRAFANA_URL                   stack URL (https://<stack>.grafana.net) — used
#                                  to disambiguate when an org has multiple stacks
#   GRAFANA_CLOUD_ORG_SLUG        org slug (the segment in https://grafana.com/orgs/<slug>).
#                                  Required because access-policy tokens scoped
#                                  to one org cannot list /api/orgs; the script
#                                  uses /api/orgs/<slug> and /api/orgs/<slug>/instances.
#   DEPLOY_ENV                    env name (candidate-a | preview | production)
#   FORK_SLUG                     fork slug for SA + policy naming
#   REPO_ROOT                     absolute path to repo root
#
# Output:
#   .local/${DEPLOY_ENV}-grafana-sa-token.json  (operator-facing snapshot, 8 fields)
#   stdout: 8 KEY=VALUE pairs the wrapper seeds into cogni/<env>/_shared:
#     GRAFANA_SERVICE_ACCOUNT_TOKEN=<glsa_ child read>
#     GRAFANA_URL=<stack url>
#     LOKI_WRITE_URL=<hlInstanceUrl>
#     LOKI_USERNAME=<hlInstanceId>
#     LOKI_PASSWORD=<glc_ push token>
#     PROMETHEUS_REMOTE_WRITE_URL=<hmInstancePromUrl>
#     PROMETHEUS_USERNAME=<hmInstancePromId>
#     PROMETHEUS_PASSWORD=<glc_ push token>
#
# Graceful skip: if all three (GH_GRAFANA_CLOUD_ADMIN_TOKEN + GRAFANA_URL +
# GRAFANA_CLOUD_ORG_SLUG) are empty, log + exit 0 with no artifact and no
# stdout (scorecard row 5 stays 🟡, bootstrap continues). Partial config is
# a setup error (caught by workflow preflight; this script also re-checks).
# Per design invariant GRAFANA_AUTOMINT_GRACEFUL_SKIP.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[grafana-cloud-mint]${NC} $1" >&2; }
log_warn() { echo -e "${YELLOW}[grafana-cloud-mint]${NC} $1" >&2; }
log_error() { echo -e "${RED}[grafana-cloud-mint]${NC} $1" >&2; }

: "${DEPLOY_ENV:?DEPLOY_ENV not set}"
: "${FORK_SLUG:?FORK_SLUG not set}"
: "${REPO_ROOT:?REPO_ROOT not set}"

ARTIFACT="$REPO_ROOT/.local/${DEPLOY_ENV}-grafana-sa-token.json"
CLOUD_SA_NAME="cogni-${FORK_SLUG}-${DEPLOY_ENV}-bootstrap-minter"
CHILD_SA_NAME="${FORK_SLUG}-${DEPLOY_ENV}-validator"
PUSH_POLICY_NAME="cogni-${FORK_SLUG}-${DEPLOY_ENV}-push"
CLOUD_API="https://grafana.com/api"

# ─── Graceful skip ───────────────────────────────────────────────────
# Token + URL both unset → skip Phase 5e (scorecard row 5 stays 🟡).
if [[ -z "${GH_GRAFANA_CLOUD_ADMIN_TOKEN:-}" && -z "${GRAFANA_URL:-}" ]]; then
  log_info "GH_GRAFANA_CLOUD_ADMIN_TOKEN / GRAFANA_URL both unset — skipping (scorecard row 5 stays 🟡)"
  exit 0
fi
if [[ -z "${GH_GRAFANA_CLOUD_ADMIN_TOKEN:-}" || -z "${GRAFANA_URL:-}" ]]; then
  log_error "Set BOTH GH_GRAFANA_CLOUD_ADMIN_TOKEN and GRAFANA_URL, or neither."
  exit 1
fi
# Auto-derive org slug from URL host when not explicitly set.
# https://<slug>.grafana.net → <slug>. Override via GH_GRAFANA_ORG_SLUG for
# multi-stack orgs or custom domains where slug ≠ subdomain.
if [[ -z "${GRAFANA_CLOUD_ORG_SLUG:-}" ]]; then
  HOST="${GRAFANA_URL#https://}"; HOST="${HOST%%/*}"
  GRAFANA_CLOUD_ORG_SLUG="${HOST%.grafana.net}"
  log_info "GRAFANA_CLOUD_ORG_SLUG unset — derived '$GRAFANA_CLOUD_ORG_SLUG' from URL host"
fi

# ─── Preflight: MUST be a glc_ Cloud admin token ─────────────────────
case "$GH_GRAFANA_CLOUD_ADMIN_TOKEN" in
  glc_*) : ;;
  glsa_*)
    log_error "GH_GRAFANA_CLOUD_ADMIN_TOKEN is a stack SA token (glsa_*)."
    log_error "Phase 5e now derives BOTH the read child SA AND the write Loki/Prom token from ONE Cloud admin token (glc_*)."
    log_error "A glsa_ token cannot mint Cloud access-policies (different API surface)."
    log_error "Mint a glc_ token at: https://grafana.com/orgs/<your-org-slug>/access-policies"
    log_error "Add these 4 scopes via the 'Add scope' dropdown near the bottom (NOT the default checkboxes — those are data-plane write):"
    log_error "  stacks:read, stack-service-accounts:write, accesspolicies:read, accesspolicies:write"
    log_error "Full walkthrough: https://cognidao.org/knowledge/fork-quickstart-guide §6.2 row 9."
    exit 1
    ;;
  glb_*)
    log_error "GH_GRAFANA_CLOUD_ADMIN_TOKEN is a Grafana Cloud bearer token (glb_*) — not supported."
    log_error "Use a glc_ access-policy token. Walkthrough: https://cognidao.org/knowledge/fork-quickstart-guide §6.2 row 9."
    exit 1
    ;;
  *)
    log_error "GH_GRAFANA_CLOUD_ADMIN_TOKEN does not start with glc_ — refusing."
    log_error "Mint at: https://grafana.com/orgs/<your-org-slug>/access-policies (use 'Add scope' dropdown)."
    log_error "Required scopes: stacks:read, stack-service-accounts:write, accesspolicies:read, accesspolicies:write"
    log_error "Full walkthrough: https://cognidao.org/knowledge/fork-quickstart-guide §6.2 row 9."
    exit 1
    ;;
esac

GRAFANA_URL="${GRAFANA_URL%/}"
mkdir -p "$REPO_ROOT/.local"

# ─── HTTP helper: avoid the func-piped-via-stdin subshell trap ───────
# `func | pipe` runs each stage in a subshell so CODE/BODY set inside die at
# the boundary and `set -u` then trips on the next read. We use command
# substitution into a single var and split via parameter expansion to keep
# state in this shell. Pattern lifted from provision-grafana-child-sa.sh.
cloud_call() {
  # cloud_call <method> <url> [<json-body>]
  # Echoes the response body + a trailing line with the HTTP status. Caller
  # splits via SPLIT_RESP.
  local method="$1" url="$2" body="${3:-}"
  if [[ "$method" == "GET" ]]; then
    curl -sS -w "\n%{http_code}" \
      -H "Authorization: Bearer $GH_GRAFANA_CLOUD_ADMIN_TOKEN" \
      "$url"
  else
    curl -sS -w "\n%{http_code}" -X "$method" \
      -H "Authorization: Bearer $GH_GRAFANA_CLOUD_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" "$url"
  fi
}

stack_call() {
  # stack_call <method> <path> [<json-body>] — auth with the minted glsa_
  # (set after Step 2). Calls the stack instance HTTP API at $GRAFANA_URL.
  local method="$1" path="$2" body="${3:-}"
  if [[ "$method" == "GET" ]]; then
    curl -sS -w "\n%{http_code}" \
      -H "Authorization: Bearer $STACK_SA_TOKEN" \
      "$GRAFANA_URL$path"
  else
    curl -sS -w "\n%{http_code}" -X "$method" \
      -H "Authorization: Bearer $STACK_SA_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" "$GRAFANA_URL$path"
  fi
}

SPLIT_RESP() {
  local resp="$1"
  CODE="${resp##*$'\n'}"
  BODY="${resp%$'\n'*}"
}

ts_suffix() {
  local ts rand4
  ts=$(date -u +%s)
  rand4=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 4 || echo "xxxx")
  echo "${ts}-${rand4}"
}

# ─── Step 1: Cloud lookup — org + stack + region + push endpoints ────
# Org slug is operator-provided (GRAFANA_CLOUD_ORG_SLUG) rather than
# discovered via GET /api/orgs. The list endpoint requires `orgs:read`
# which is NOT in the recommended 4-scope set (stacks:read,
# stack-service-accounts:write, accesspolicies:*); a correctly-configured
# access-policy token will 403 on it. Verified against access-policy:
#   GET /api/orgs                       → 403 (needs orgs:read)
#   GET /api/orgs/<slug>                → 200 ✓
#   GET /api/orgs/<slug>/instances      → 200 ✓
log_info "Step 1: looking up org=$GRAFANA_CLOUD_ORG_SLUG + stack at $GRAFANA_URL"

ORG_SLUG="$GRAFANA_CLOUD_ORG_SLUG"
RESP=$(cloud_call GET "$CLOUD_API/orgs/$ORG_SLUG")
SPLIT_RESP "$RESP"
case "$CODE" in
  200) : ;;
  401)
    log_error "Cloud admin token rejected (HTTP 401 on GET /api/orgs/$ORG_SLUG). Token revoked or wrong type."
    exit 1
    ;;
  403)
    log_error "Cloud admin token missing scopes (HTTP 403 on GET /api/orgs/$ORG_SLUG)."
    log_error "Required: stacks:read, stack-service-accounts:write, accesspolicies:read, accesspolicies:write"
    log_error "Recreate the access-policy at https://grafana.com/orgs/$ORG_SLUG/access-policies (use 'Add scope' dropdown)."
    exit 1
    ;;
  404)
    log_error "Org slug \"$ORG_SLUG\" not found (HTTP 404 on GET /api/orgs/$ORG_SLUG)."
    log_error "Update GRAFANA_CLOUD_ORG_SLUG / GH_GRAFANA_ORG_SLUG to match your Grafana Cloud URL: https://grafana.com/orgs/<slug>."
    exit 1
    ;;
  *)
    log_error "Org lookup HTTP $CODE: $BODY"
    exit 1
    ;;
esac
log_info "  org slug=$ORG_SLUG (verified)"

RESP=$(cloud_call GET "$CLOUD_API/orgs/$ORG_SLUG/instances")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" ]] || { log_error "instances lookup HTTP $CODE: $BODY"; exit 1; }

# Prefer the instance whose `url` matches GRAFANA_URL exactly (handles multi-
# stack orgs); fall back to the first if no exact match (single-stack org or
# operator typo'd the URL but only has one stack).
STACK=$(echo "$BODY" | jq --arg u "$GRAFANA_URL" '.items[] | select(.url == $u)' | head -c 100000)
if [[ -z "$STACK" ]]; then
  STACK=$(echo "$BODY" | jq '.items[0]')
  STACK_URL=$(echo "$STACK" | jq -r '.url')
  if [[ "$STACK_URL" != "$GRAFANA_URL" ]]; then
    log_warn "no stack with url=$GRAFANA_URL; falling back to first stack url=$STACK_URL"
  fi
fi
[[ -n "$STACK" && "$STACK" != "null" ]] || { log_error "no stack found for org $ORG_SLUG"; exit 1; }

STACK_SLUG=$(echo "$STACK" | jq -r '.slug')
STACK_ID=$(echo "$STACK" | jq -r '.id')
REGION_SLUG=$(echo "$STACK" | jq -r '.regionSlug')
LOKI_WRITE_URL=$(echo "$STACK" | jq -r '.hlInstanceUrl + "/loki/api/v1/push"')
LOKI_USERNAME=$(echo "$STACK" | jq -r '.hlInstanceId')
PROMETHEUS_REMOTE_WRITE_URL=$(echo "$STACK" | jq -r '.hmInstancePromUrl + "/api/prom/push"')
PROMETHEUS_USERNAME=$(echo "$STACK" | jq -r '.hmInstancePromId')

for v in STACK_SLUG STACK_ID REGION_SLUG LOKI_WRITE_URL LOKI_USERNAME PROMETHEUS_REMOTE_WRITE_URL PROMETHEUS_USERNAME; do
  val="${!v}"
  [[ -n "$val" && "$val" != "null" ]] || { log_error "missing $v in stack response: $STACK"; exit 1; }
done
log_info "  stack slug=$STACK_SLUG id=$STACK_ID region=$REGION_SLUG"
log_info "  loki=$LOKI_WRITE_URL (user $LOKI_USERNAME)"
log_info "  prom=$PROMETHEUS_REMOTE_WRITE_URL (user $PROMETHEUS_USERNAME)"

# ─── Step 2: Cloud-side bootstrap minter SA (idempotent) ─────────────
# This Admin-role SA gives us a glsa_ token authorized against the stack
# instance HTTP API for service-account management. Editor role lacks
# serviceaccounts:read (validator caught this: GET /api/serviceaccounts/search
# returns 403 with role=Editor). Admin is the minimum role that includes
# serviceaccounts:* capabilities. The SA is long-lived but its tokens are
# short-lived (each provision mints a fresh one); future tightening could
# delete-after-use to make Admin role transient too.
log_info "Step 2: ensure-Admin Cloud-side bootstrap SA name=$CLOUD_SA_NAME"

# Validator caught that the prior PATCH-to-promote approach didn't reliably
# update the SA's role (the Cloud API endpoint either doesn't support role
# updates or silently no-op'd, and our log_warn path swallowed the failure).
# Switch to delete-and-recreate: if the SA exists, DELETE it and create fresh
# with role=Admin. The SA's only purpose is to mint a transient glsa_ token
# for Step 3; deleting it invalidates any leaked prior tokens for free.
RESP=$(cloud_call GET "$CLOUD_API/instances/$STACK_SLUG/api/serviceaccounts/search?query=$CLOUD_SA_NAME")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" ]] || { log_error "Cloud SA search HTTP $CODE: $BODY"; exit 1; }
EXISTING_SA_ID=$(echo "$BODY" | jq -r --arg n "$CLOUD_SA_NAME" '.serviceAccounts[]? | select(.name == $n) | .id' | head -1)

if [[ -n "$EXISTING_SA_ID" && "$EXISTING_SA_ID" != "null" ]]; then
  log_info "  existing Cloud SA id=$EXISTING_SA_ID — deleting to force Admin recreate"
  RESP=$(cloud_call DELETE "$CLOUD_API/instances/$STACK_SLUG/api/serviceaccounts/$EXISTING_SA_ID")
  SPLIT_RESP "$RESP"
  case "$CODE" in
    200|204) : ;;
    404) log_info "  already gone (race?) — proceeding to create" ;;
    *) log_warn "  delete HTTP $CODE: $BODY — proceeding to create anyway" ;;
  esac
fi

log_info "  creating Cloud SA with role=Admin"
RESP=$(cloud_call POST "$CLOUD_API/instances/$STACK_SLUG/api/serviceaccounts" \
  "$(jq -n --arg n "$CLOUD_SA_NAME" '{name:$n, role:"Admin", isDisabled:false}')")
SPLIT_RESP "$RESP"
case "$CODE" in
  200|201)
    CLOUD_SA_ID=$(echo "$BODY" | jq -r '.id')
    ;;
  409)
    # Eventual-consistency race: DELETE didn't fully propagate before CREATE.
    # Sleep + retry once.
    log_warn "  409 on create — DELETE may not have propagated; retrying after 3s"
    sleep 3
    RESP=$(cloud_call POST "$CLOUD_API/instances/$STACK_SLUG/api/serviceaccounts" \
      "$(jq -n --arg n "$CLOUD_SA_NAME" '{name:$n, role:"Admin", isDisabled:false}')")
    SPLIT_RESP "$RESP"
    [[ "$CODE" == "200" || "$CODE" == "201" ]] || { log_error "Cloud SA create retry HTTP $CODE: $BODY"; exit 1; }
    CLOUD_SA_ID=$(echo "$BODY" | jq -r '.id')
    ;;
  *)
    log_error "Cloud SA create HTTP $CODE: $BODY"
    exit 1
    ;;
esac
[[ -n "$CLOUD_SA_ID" && "$CLOUD_SA_ID" != "null" ]] || { log_error "could not resolve Cloud SA id"; exit 1; }
log_info "  Cloud SA id=$CLOUD_SA_ID (role=Admin)"

# Mint a fresh glsa_ token on the Cloud-side SA. Tokens cannot be "reused" —
# secret material is only returned at create time; we always mint a new one
# (named with unix-ts suffix to avoid name collisions across re-runs).
CLOUD_TOKEN_NAME="${DEPLOY_ENV}-stack-bootstrap-$(ts_suffix)"
log_info "  minting Cloud SA token name=$CLOUD_TOKEN_NAME"
RESP=$(cloud_call POST "$CLOUD_API/instances/$STACK_SLUG/api/serviceaccounts/$CLOUD_SA_ID/tokens" \
  "$(jq -n --arg n "$CLOUD_TOKEN_NAME" '{name:$n}')")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" || "$CODE" == "201" ]] || { log_error "Cloud SA token mint HTTP $CODE: $BODY"; exit 1; }
STACK_SA_TOKEN=$(echo "$BODY" | jq -r '.key')
[[ "$STACK_SA_TOKEN" == glsa_* ]] || { log_error "Cloud-minted stack token does not start with glsa_: $BODY"; exit 1; }

# ─── Step 3: stack-side Viewer child SA + read token ─────────────────
# Same logic as the prior provision-grafana-child-sa.sh, but auth'd with the
# stack SA token we just minted from the Cloud admin root. Hits the stack
# instance HTTP API directly ($GRAFANA_URL/api/serviceaccounts).
log_info "Step 3: find-or-create Viewer child SA name=$CHILD_SA_NAME at $GRAFANA_URL"

RESP=$(stack_call GET "/api/serviceaccounts/search?query=$CHILD_SA_NAME")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" ]] || { log_error "child SA search HTTP $CODE: $BODY"; exit 1; }
CHILD_SA_ID=$(echo "$BODY" | jq -r --arg n "$CHILD_SA_NAME" '.serviceAccounts[]? | select(.name == $n) | .id' | head -1)

if [[ -z "$CHILD_SA_ID" || "$CHILD_SA_ID" == "null" ]]; then
  log_info "  creating child SA (Viewer)"
  RESP=$(stack_call POST "/api/serviceaccounts" \
    "$(jq -n --arg n "$CHILD_SA_NAME" '{name:$n, role:"Viewer", isDisabled:false}')")
  SPLIT_RESP "$RESP"
  case "$CODE" in
    200|201)
      CHILD_SA_ID=$(echo "$BODY" | jq -r '.id')
      ;;
    409)
      log_warn "  409 on create — re-searching"
      RESP=$(stack_call GET "/api/serviceaccounts/search?query=$CHILD_SA_NAME")
      SPLIT_RESP "$RESP"
      [[ "$CODE" == "200" ]] || { log_error "re-search HTTP $CODE"; exit 1; }
      CHILD_SA_ID=$(echo "$BODY" | jq -r --arg n "$CHILD_SA_NAME" '.serviceAccounts[]? | select(.name == $n) | .id' | head -1)
      ;;
    *)
      log_error "child SA create HTTP $CODE: $BODY"
      exit 1
      ;;
  esac
fi
[[ -n "$CHILD_SA_ID" && "$CHILD_SA_ID" != "null" ]] || { log_error "could not resolve child SA id"; exit 1; }
log_info "  child SA id=$CHILD_SA_ID"

CHILD_TOKEN_NAME="${DEPLOY_ENV}-bootstrap-$(ts_suffix)"
log_info "  minting child token name=$CHILD_TOKEN_NAME"
RESP=$(stack_call POST "/api/serviceaccounts/$CHILD_SA_ID/tokens" \
  "$(jq -n --arg n "$CHILD_TOKEN_NAME" '{name:$n}')")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" || "$CODE" == "201" ]] || { log_error "child token mint HTTP $CODE: $BODY"; exit 1; }
CHILD_READ_TOKEN=$(echo "$BODY" | jq -r '.key')
[[ "$CHILD_READ_TOKEN" == glsa_* ]] || { log_error "child read token does not start with glsa_"; exit 1; }

# ─── Step 4: Cloud access-policy for Loki/Prom push (idempotent) ─────
# Single policy covers logs:write + metrics:write + logs:read + metrics:read.
# Same glc_ token serves both LOKI_PASSWORD and PROMETHEUS_PASSWORD downstream.
log_info "Step 4: find-or-create push access-policy name=$PUSH_POLICY_NAME (region=$REGION_SLUG)"

RESP=$(cloud_call GET "$CLOUD_API/v1/accesspolicies?region=$REGION_SLUG&name=$PUSH_POLICY_NAME")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" ]] || { log_error "access-policy search HTTP $CODE: $BODY"; exit 1; }
POLICY_ID=$(echo "$BODY" | jq -r --arg n "$PUSH_POLICY_NAME" '.items[]? | select(.name == $n) | .id' | head -1)

if [[ -z "$POLICY_ID" || "$POLICY_ID" == "null" ]]; then
  log_info "  creating access-policy"
  POLICY_BODY=$(jq -n \
    --arg n "$PUSH_POLICY_NAME" \
    --arg d "$PUSH_POLICY_NAME" \
    --arg id "$STACK_ID" \
    '{name:$n, displayName:$d,
      scopes:["logs:write","metrics:write","logs:read","metrics:read"],
      realms:[{type:"stack", identifier:$id, labelPolicies:[]}]}')
  RESP=$(cloud_call POST "$CLOUD_API/v1/accesspolicies?region=$REGION_SLUG" "$POLICY_BODY")
  SPLIT_RESP "$RESP"
  case "$CODE" in
    200|201) POLICY_ID=$(echo "$BODY" | jq -r '.id') ;;
    409)
      log_warn "  409 on create: $BODY"
      log_warn "  re-searching by name + falling back to full list match"
      RESP=$(cloud_call GET "$CLOUD_API/v1/accesspolicies?region=$REGION_SLUG&name=$PUSH_POLICY_NAME")
      SPLIT_RESP "$RESP"
      [[ "$CODE" == "200" ]] || { log_error "re-search HTTP $CODE: $BODY"; exit 1; }
      POLICY_ID=$(echo "$BODY" | jq -r --arg n "$PUSH_POLICY_NAME" '.items[]? | select(.name == $n) | .id' | head -1)
      if [[ -z "$POLICY_ID" || "$POLICY_ID" == "null" ]]; then
        RESP=$(cloud_call GET "$CLOUD_API/v1/accesspolicies?region=$REGION_SLUG")
        SPLIT_RESP "$RESP"
        [[ "$CODE" == "200" ]] || { log_error "full-list search HTTP $CODE: $BODY"; exit 1; }
        POLICY_ID=$(echo "$BODY" | jq -r --arg n "$PUSH_POLICY_NAME" '.items[]? | select(.name == $n) | .id' | head -1)
        [[ -n "$POLICY_ID" && "$POLICY_ID" != "null" ]] || { log_error "409 but no policy with name=$PUSH_POLICY_NAME in region=$REGION_SLUG — likely a non-name-conflict 409 (e.g. invalid realm). Raw policies: $(echo "$BODY" | jq -c '.items | map({id,name,realms})')"; exit 1; }
      fi
      ;;
    *) log_error "access-policy create HTTP $CODE: $BODY"; exit 1 ;;
  esac
fi
[[ -n "$POLICY_ID" && "$POLICY_ID" != "null" ]] || { log_error "could not resolve access-policy id"; exit 1; }
log_info "  policy id=$POLICY_ID"

# ─── Step 5: mint glc_ push token on the access-policy ───────────────
# Tokens cannot be re-fetched after issue; we always mint fresh (unique
# unix-ts-suffixed name). Operator can revoke prior tokens via Cloud UI.
PUSH_TOKEN_NAME="${DEPLOY_ENV}-push-$(ts_suffix)"
log_info "Step 5: minting push token name=$PUSH_TOKEN_NAME"
TOKEN_BODY=$(jq -n \
  --arg n "$PUSH_TOKEN_NAME" \
  --arg p "$POLICY_ID" \
  --arg d "$PUSH_TOKEN_NAME" \
  '{name:$n, displayName:$d, accessPolicyId:$p}')
RESP=$(cloud_call POST "$CLOUD_API/v1/tokens?region=$REGION_SLUG" "$TOKEN_BODY")
SPLIT_RESP "$RESP"
[[ "$CODE" == "200" || "$CODE" == "201" ]] || { log_error "push token mint HTTP $CODE: $BODY"; exit 1; }
PUSH_TOKEN=$(echo "$BODY" | jq -r '.token')
[[ "$PUSH_TOKEN" == glc_* ]] || { log_error "push token does not start with glc_: $BODY"; exit 1; }

# ─── Step 6: write operator-facing artifact (chmod 600) ──────────────
MINTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
umask 077
jq -n \
  --arg url "$GRAFANA_URL" \
  --arg token "$CHILD_READ_TOKEN" \
  --arg sa_name "$CHILD_SA_NAME" \
  --argjson sa_id "$CHILD_SA_ID" \
  --arg token_name "$CHILD_TOKEN_NAME" \
  --arg minted_at "$MINTED_AT" \
  --arg loki_write_url "$LOKI_WRITE_URL" \
  --arg loki_username "$LOKI_USERNAME" \
  --arg prometheus_remote_write_url "$PROMETHEUS_REMOTE_WRITE_URL" \
  --arg prometheus_username "$PROMETHEUS_USERNAME" \
  --arg push_token "$PUSH_TOKEN" \
  '{url:$url, token:$token, sa_id:$sa_id, sa_name:$sa_name, token_name:$token_name, minted_at:$minted_at,
    loki_write_url:$loki_write_url, loki_username:$loki_username,
    prometheus_remote_write_url:$prometheus_remote_write_url, prometheus_username:$prometheus_username,
    push_token:$push_token}' \
  > "$ARTIFACT"
chmod 600 "$ARTIFACT"
log_info "wrote artifact $ARTIFACT (8 fields)"

# ─── Step 7: emit 8 KEY=VALUE lines for the wrapper to seed_kv ───────
# Same glc_ push token under both LOKI_PASSWORD and PROMETHEUS_PASSWORD —
# the single access-policy holds both logs:write and metrics:write scopes,
# so Alloy can use one credential for both push paths.
printf 'GRAFANA_SERVICE_ACCOUNT_TOKEN=%s\n' "$CHILD_READ_TOKEN"
printf 'GRAFANA_URL=%s\n' "$GRAFANA_URL"
printf 'LOKI_WRITE_URL=%s\n' "$LOKI_WRITE_URL"
printf 'LOKI_USERNAME=%s\n' "$LOKI_USERNAME"
printf 'LOKI_PASSWORD=%s\n' "$PUSH_TOKEN"
printf 'PROMETHEUS_REMOTE_WRITE_URL=%s\n' "$PROMETHEUS_REMOTE_WRITE_URL"
printf 'PROMETHEUS_USERNAME=%s\n' "$PROMETHEUS_USERNAME"
printf 'PROMETHEUS_PASSWORD=%s\n' "$PUSH_TOKEN"
