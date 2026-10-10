#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# sync-app-webhook-secret.sh — push the generated webhook secret to the GitHub
# App's webhook config so the pod's value and the App's value match.
#
# WHY: GH_WEBHOOK_SECRET is `source: agent` + `syncTo: github-app-webhook`
# (secrets-management.md) — we generate it, and it must byte-equal the GitHub
# App's webhook secret, which lives on GitHub's side. Provisioning owns BOTH
# copies: it writes the value to OpenBao / the pod Secret and pushes it to the
# App here, via the App's own key. Without this, every webhook fails HMAC
# verification silently and a Secret re-apply can re-break it on each redeploy.
# See `.claude/skills/cicd-secrets-expert/SKILL.md` "Dual-plane secrets".
#
# No human, self-healing: agent generates → agent pushes → both sides converge.
#
# Inputs (env): GH_REVIEW_APP_ID, GH_REVIEW_APP_PRIVATE_KEY_BASE64, GH_WEBHOOK_SECRET.
# Missing any → SKIP (a node-app without a GitHub App has nothing to sync).
# Idempotent: PATCH is a no-op when the App already holds the value.

set -euo pipefail

err() { printf '[sync-app-webhook] %s\n' "$*" >&2; }

APP_ID="${GH_REVIEW_APP_ID:-}"
PK_B64="${GH_REVIEW_APP_PRIVATE_KEY_BASE64:-}"
WEBHOOK_SECRET="${GH_WEBHOOK_SECRET:-}"

if [[ -z "$APP_ID" || -z "$PK_B64" || -z "$WEBHOOK_SECRET" ]]; then
  err "skip — no GitHub App configured (need GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 + GH_WEBHOOK_SECRET)"
  exit 0
fi

for cmd in openssl curl; do
  command -v "$cmd" >/dev/null 2>&1 || { err "FATAL: $cmd not on PATH"; exit 1; }
done

pem="$(mktemp)"; trap 'rm -f "$pem"' EXIT
printf '%s' "$PK_B64" | base64 -d > "$pem" 2>/dev/null || { err "FATAL: GH_REVIEW_APP_PRIVATE_KEY_BASE64 is not valid base64"; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# RS256 App JWT — GitHub caps exp at 10m; clock-skew cushion on iat.
now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$APP_ID" | b64url)"
sig="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$pem" -binary | b64url)"
jwt="${header}.${payload}.${sig}"

api="https://api.github.com"

# gh_get <path> — read a GitHub App endpoint, FAILING OUT LOUD (bug.5404).
#
# The previous form was `x="$(curl -fsS … 2>/dev/null | sed … )"`, and under this
# script's own `set -euo pipefail` that is a silent-exit trap: curl fails,
# `2>/dev/null` throws away the one line that says why, `pipefail` makes the
# command substitution non-zero, and `set -e` aborts AT THE ASSIGNMENT — so the
# `|| { err "FATAL …"; exit 1; }` on the next line never runs. A rejected App
# JWT therefore produced a non-zero exit with ZERO output anywhere, and
# deploy-infra's fail-closed webhook guard reported only that it had closed,
# never why. That hard-blocked the whole candidate-a infra lane undiagnosably.
#
# Sets GH_GET_STATUS + GH_GET_BODY and returns non-zero ONLY on a transport
# failure, so the caller can branch on the HTTP status. Deliberately NOT a
# command substitution: a subshell cannot export the status back out.
GH_GET_STATUS=""
GH_GET_BODY=""
gh_get() {
  local path="$1" tmp rc
  tmp="$(mktemp)"
  set +e
  GH_GET_STATUS="$(curl -sS -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    "${api}${path}" 2>&1)"
  rc=$?
  set -e
  GH_GET_BODY="$(cat "$tmp")"
  rm -f "$tmp"
  if (( rc != 0 )); then
    err "FATAL: GET ${path} transport failure: ${GH_GET_STATUS}"
    return 1
  fi
  return 0
}

# A DEAD CREDENTIAL IS NOT THIS SYNC'S BLAST RADIUS (bug.5404).
#
# The cross-env guard below already settled the principle for a MISPOINTED
# credential: "Skip (exit 0), loudly: the creds misconfig is its own bug; this
# sync must never be the blast radius." A credential GitHub outright REJECTS is
# the same class of fault and gets the same treatment.
#
# It did not, and the cost was measured on 2026-10-08: candidate-a's App key had
# been rotated in the GitHub environment bank on 10-03 while OpenBao kept the
# superseded copy (secret-materialize's passthrough seeding is create-if-absent
# by design, and deploy-infra's source_openbao_runtime_key prefers the OpenBao
# value). `GET /app` returned 401, this script exited non-zero, and
# deploy-infra's fail-closed webhook guard then failed the ENTIRE infra deploy —
# so one dead test-environment App key blocked every compose-lane deploy,
# including unrelated Grafana datasource provisioning (bug.5117).
#
# Authentication is the one step where skipping is strictly safer than failing:
# if GitHub will not tell us WHICH App these credentials belong to, we were never
# going to be the right actor for any App, and we push nothing. A PATCH failure
# further down still fails hard — there, we know the App and genuinely cannot
# converge its secret, which is exactly what fail-closed is for.
gh_get /app || exit 1
case "$GH_GET_STATUS" in
  2??) ;;
  401 | 403)
    err "REFUSING to sync — GitHub rejected these App credentials (HTTP ${GH_GET_STATUS}) for GH_REVIEW_APP_ID ${APP_ID}"
    err "The environment holds a dead or mismatched App credential; fix the credential, not the App. Skipping so a creds fault cannot fail the whole deploy."
    exit 0
    ;;
  *)
    err "FATAL: GET /app returned HTTP ${GH_GET_STATUS}: ${GH_GET_BODY:0:200}"
    exit 1
    ;;
esac
app_json="$GH_GET_BODY"
slug="$(printf '%s' "$app_json" | sed -n 's/.*"slug":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[[ -n "$slug" ]] || { err "FATAL: GET /app returned no slug (App id ${APP_ID}); response had ${#app_json} bytes"; exit 1; }
err "syncing webhook secret to App '${slug}' (id ${APP_ID})"

# Cross-env clobber guard (bug.5012 follow-on, incident 2026-08-14): an env
# holding ANOTHER env's App credentials would PATCH that env's App and 401 its
# webhooks (candidate-a carried prod's App creds and broke prod for 4 min).
# The App's hook URL names its one true receiver — refuse to PATCH an App that
# does not deliver to THIS env. Skip (exit 0), loudly: the creds misconfig is
# its own bug; this sync must never be the blast radius.
if [[ -n "${EXPECTED_WEBHOOK_HOST:-}" ]]; then
  gh_get /app/hook/config || exit 1
  case "$GH_GET_STATUS" in
    2??) ;;
    401 | 403)
      err "REFUSING to sync — App '${slug}' will not disclose its hook config (HTTP ${GH_GET_STATUS}), so the cross-env guard cannot be evaluated"
      exit 0
      ;;
    *)
      err "FATAL: GET /app/hook/config returned HTTP ${GH_GET_STATUS}, so the cross-env guard cannot be evaluated"
      exit 1
      ;;
  esac
  hook_url="$(printf '%s' "$GH_GET_BODY" | sed -n 's/.*"url":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  hook_host="${hook_url#*://}"; hook_host="${hook_host%%/*}"
  if [[ "$hook_host" != "$EXPECTED_WEBHOOK_HOST" ]]; then
    err "REFUSING cross-env sync — App '${slug}' delivers to '${hook_host}', this env is '${EXPECTED_WEBHOOK_HOST}' (env holds another env's App creds — fix the creds, not the App)"
    exit 0
  fi
fi

code="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  "$api/app/hook/config" \
  -d "$(printf '{"secret":"%s"}' "$WEBHOOK_SECRET")")"

if [[ "$code" == "200" ]]; then
  err "OK — App '${slug}' webhook secret now matches the provisioned GH_WEBHOOK_SECRET"
else
  err "FATAL: PATCH /app/hook/config returned HTTP $code"; exit 1
fi
