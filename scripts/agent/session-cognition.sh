#!/usr/bin/env bash
# Session-start cognition substrate loader — shared by the Claude Code
# (.claude/settings.json) and Codex (.codex/config.toml) SessionStart hooks.
# Pulls the node's kickstart bundle and prints it to stdout; both runtimes inject
# SessionStart stdout into agent context. Non-fatal by design: on any failure it
# degrades to a one-line self-serve hint so a session never blocks on the network.
# Override the target with COGNI_COGNITION_URL (e.g. candidate-a / preview).
set -u

URL="${COGNI_COGNITION_URL:-https://cognidao.org/api/v1/cognition}"

# Cognition now requires a principal (KNOWLEDGE_READ_REQUIRES_PRINCIPAL). Pass the
# agent key as a bearer when present; without it the request 401s and we fall
# through to the self-serve hint below. (Arrays avoided for bash 3.2 portability.)
if [ -n "${COGNI_API_KEY:-}" ]; then
  bundle="$(curl -fsS --max-time 6 -H "Authorization: Bearer ${COGNI_API_KEY}" "$URL" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null)"
else
  bundle="$(curl -fsS --max-time 6 "$URL" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null)"
fi

if [ -n "$bundle" ]; then
  printf '%s\n' "$bundle"
else
  printf '(cognition substrate unreachable at %s — self-serve: curl -fsS "%s" | jq -r .markdown)\n' "$URL" "$URL"
fi
