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
# `-f` suppresses the response body on an HTTP error, so on failure the captured
# text is curl's own one-line diagnostic ("The requested URL returned error:
# 401") and never a response payload.
gh_get() {
  local path="$1" out
  if ! out="$(curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" "${api}${path}" 2>&1)"; then
    err "FATAL: GET ${path} failed: ${out}"
    return 1
  fi
  printf '%s' "$out"
}

app_json="$(gh_get /app)" || { err "FATAL: App JWT rejected (check GH_REVIEW_APP_ID matches the private key)"; exit 1; }
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
  hook_json="$(gh_get /app/hook/config)" || { err "FATAL: cannot read the App's hook config, so the cross-env guard cannot be evaluated"; exit 1; }
  hook_url="$(printf '%s' "$hook_json" | sed -n 's/.*"url":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
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
