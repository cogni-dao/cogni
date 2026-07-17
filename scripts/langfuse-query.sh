#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Ad-hoc Langfuse reader for AI graph traces. The /traces counterpart to
# scripts/loki-query.sh — Langfuse has no MCP server, so curl is the only path.
#
# Requires (typically from the gitignored .env.cogni):
#   LANGFUSE_PUBLIC_KEY    pk-lf-…
#   LANGFUSE_SECRET_KEY    sk-lf-…
#   LANGFUSE_BASE_URL      optional; DEFAULTS to https://us.cloud.langfuse.com
#                          (the Cogni project lives on the US region — the EU
#                          host https://cloud.langfuse.com returns "Invalid
#                          credentials. Confirm that you've configured the
#                          correct host.")
#
# Usage:
#   scripts/langfuse-query.sh '<api-path-with-query>'
#
# The path is any Langfuse Public API GET route. Output is raw JSON on stdout —
# pipe through jq.
#
# Examples:
#   # Recent traces (newest first)
#   scripts/langfuse-query.sh '/api/public/traces?limit=20&fromTimestamp=2026-06-01T00:00:00Z'
#   # ERROR-level observations only
#   scripts/langfuse-query.sh '/api/public/observations?level=ERROR&limit=50&fromStartTime=2026-06-01T00:00:00Z'
#   # One full trace, with its observation tree
#   scripts/langfuse-query.sh '/api/public/traces/<traceId>'
#   # Traces for one graph by name
#   scripts/langfuse-query.sh '/api/public/traces?name=graph-execution&limit=50'

set -euo pipefail

API_PATH="${1:-}"
if [[ -z "$API_PATH" ]]; then
  sed -n '2,30p' "$0" >&2
  exit 2
fi

# Pull only the three keys we need — do NOT `source` .env.cogni: it carries
# unquoted <placeholder> lines that abort `set -a; .` (see the env-sourcing trap).
ENV_FILE="${COGNI_ENV_FILE:-./.env.cogni}"
read_key() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-; }

: "${LANGFUSE_PUBLIC_KEY:=$(read_key LANGFUSE_PUBLIC_KEY)}"
: "${LANGFUSE_SECRET_KEY:=$(read_key LANGFUSE_SECRET_KEY)}"
: "${LANGFUSE_BASE_URL:=$(read_key LANGFUSE_BASE_URL)}"
LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-https://us.cloud.langfuse.com}"

: "${LANGFUSE_PUBLIC_KEY:?LANGFUSE_PUBLIC_KEY not set (add to .env.cogni or export it)}"
: "${LANGFUSE_SECRET_KEY:?LANGFUSE_SECRET_KEY not set (add to .env.cogni or export it)}"

curl -sS -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
  "${LANGFUSE_BASE_URL%/}${API_PATH}"
