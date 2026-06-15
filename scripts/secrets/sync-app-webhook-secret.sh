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
slug="$(curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" "$api/app" 2>/dev/null | sed -n 's/.*"slug":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[[ -n "$slug" ]] || { err "FATAL: App JWT rejected (check GH_REVIEW_APP_ID matches the private key)"; exit 1; }
err "syncing webhook secret to App '${slug}' (id ${APP_ID})"

code="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  "$api/app/hook/config" \
  -d "$(printf '{"secret":"%s"}' "$WEBHOOK_SECRET")")"

if [[ "$code" == "200" ]]; then
  err "OK — App '${slug}' webhook secret now matches the provisioned GH_WEBHOOK_SECRET"
else
  err "FATAL: PATCH /app/hook/config returned HTTP $code"; exit 1
fi
