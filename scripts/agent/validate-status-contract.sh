#!/usr/bin/env bash
# Claude Code Stop hook: reject a final response that breaches Cogni's status contract.
# Prompt instructions remain the canonical contract; this hook enforces the two properties
# that are deterministic to verify at the response boundary: exact block shape and frozen
# Goal/Done-when state within one session.

set -euo pipefail

INPUT="$(cat)"
MESSAGE="$(printf '%s' "$INPUT" | jq -r '.last_assistant_message // ""')"
SCRATCHPAD_DIR="$(printf '%s' "$INPUT" | jq -r '.scratchpad_dir // ""')"

block() {
  jq -cn --arg reason "$1" '{decision:"block",reason:$reason}'
  exit 0
}

first_nonempty="$(printf '%s\n' "$MESSAGE" | awk 'NF { print; exit }')"
last_nonempty="$(printf '%s\n' "$MESSAGE" | awk 'NF { line=$0 } END { print line }')"

case "$first_nonempty" in
  '| 🎯 **Goal**'*) ;;
  *)
    block "Contract breach: rewrite the entire response as only the required status block. Start with the Goal table; include Done when, Status, ETA · Conf, Followed; then a divider, items table, and Bottom line. No prose may appear outside that block."
    ;;
esac

printf '%s\n' "$MESSAGE" | grep -Eq '^\|[[:space:]]*\*\*Done when\*\*[[:space:]]*\|' ||
  block "Contract breach: the status block is missing its Done when row. Rewrite the whole response in the required shape."
printf '%s\n' "$MESSAGE" | grep -Eq '^\|[[:space:]]*\*\*Status\*\*[[:space:]]*\|' ||
  block "Contract breach: the status block is missing its Status row. Rewrite the whole response in the required shape."
printf '%s\n' "$MESSAGE" | grep -Eq '^\|[[:space:]]*\*\*ETA · Conf\*\*[[:space:]]*\|' ||
  block "Contract breach: the status block is missing its ETA · Conf row. Rewrite the whole response in the required shape."
printf '%s\n' "$MESSAGE" | grep -Eq '^\|[[:space:]]*\*\*Followed\*\*[[:space:]]*\|' ||
  block "Contract breach: the status block is missing its Followed row. Rewrite the whole response in the required shape."
printf '%s\n' "$MESSAGE" | grep -Eq '^([*][*][*]|---)$' ||
  block "Contract breach: the status block is missing the divider before its items table. Rewrite the whole response in the required shape."
printf '%s\n' "$MESSAGE" | grep -Eq '^\|[[:space:]]*item[[:space:]]*\|[[:space:]]*owner[[:space:]]*\|[[:space:]]*deliverable links[[:space:]]*\|[[:space:]]*status[[:space:]]*\|[[:space:]]*next[[:space:]]*\|' ||
  block "Contract breach: the status block is missing its items table. Rewrite the whole response in the required shape."

case "$last_nonempty" in
  '>'*'**Bottom line —**'*) ;;
  *)
    block "Contract breach: Bottom line must be the final line, with no epilogue. Rewrite the whole response in the required shape."
    ;;
esac

outside_block="$(printf '%s\n' "$MESSAGE" | awk '
  NF == 0 { next }
  /^\|/ { next }
  /^---$/ { next }
  /^\*\*\*$/ { next }
  /^>/ { next }
  { print; exit }
')"
[[ -z "$outside_block" ]] ||
  block "Contract breach: prose appeared outside the tables and Bottom line. Rewrite the entire response as only the required status block."

extract_cell() {
  local row_pattern="$1"
  printf '%s\n' "$MESSAGE" | awk -F'|' -v pattern="$row_pattern" '
    $2 ~ pattern {
      value=$3
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      print value
      exit
    }
  '
}

GOAL="$(extract_cell 'Goal')"
DONE_WHEN="$(extract_cell 'Done when')"
STATUS="$(extract_cell 'Status')"
ETA_CONF="$(extract_cell 'ETA · Conf')"
FOLLOWED="$(extract_cell 'Followed')"
[[ -n "$GOAL" && -n "$DONE_WHEN" ]] ||
  block "Contract breach: Goal and Done when must each occupy one complete table cell. Rewrite the whole response in the required shape."

if [[ "$GOAL" == "—" || "$DONE_WHEN" == "—" ]]; then
  [[ "$GOAL" == "—" && "$DONE_WHEN" == "—" ]] ||
    block "Contract breach: before substantive alignment, Goal and Done when must both remain —. Continue research and rewrite the whole response."
  [[ "$STATUS" == "—" ]] ||
    block "Process-contract breach: before the evidence pass supports a proposal, Goal, Done when, and Status must all remain —. Continue research silently and rewrite the complete block."
  if ! printf '%s\n' "$MESSAGE" | awk -F'|' '
    $6 ~ /👉 needs you:|👀/ { found=1 }
    END { exit found ? 0 : 1 }
  '; then
    block "Process-contract breach: Goal and Done when are still —, and no human or asynchronous gate exists. A preliminary status is not a legal stop; continue the agent-owned research now, then return with an evidence-backed proposal."
  fi
else
  [[ "$FOLLOWED" != "—" && "$FOLLOWED" == *"https://"* ]] ||
    block "Process-contract breach: a substantive proposal requires Followed to contain verified human URLs for sources actually consulted. Continue research; do not propose from an empty evidence base."
  if printf '%s\n' "$ETA_CONF" | grep -Eqi 'reviewed[[:space:]]+0|(^|[^0-9])0/[1-9][0-9]*|0[[:space:]]+sources'; then
    block "Process-contract breach: a substantive proposal cannot report zero reviewed sources. Keep Goal, Done when, and Status as —, complete the required research pass, then propose from evidence."
  fi

  URL_COUNT="$(printf '%s\n' "$FOLLOWED" | grep -Eo 'https://[^| )]+' | sort -u | wc -l | tr -d ' ')"
  [[ "$URL_COUNT" -ge 3 ]] ||
    block "Process-contract breach: Followed is an evidence ledger, not highlights. Cite at least the relevant guidance/knowledge, design/code, and work-item sources actually used."

  printf '%s\n' "$FOLLOWED" | grep -Eq 'https://[^| )]+/(skills|knowledge)/' ||
    block "Process-contract breach: Followed omits the orientation, skill, guide, or hub knowledge that informed the proposal. Convert local skill paths to human GitHub blob URLs and cite them."
  printf '%s\n' "$FOLLOWED" | grep -Eq 'https://github\.com/[^| )]+/(blob|tree)/[^| )]+/(docs/|AGENTS\.md|scripts/|packages/|nodes/)' ||
    block "Process-contract breach: Followed omits the applicable design or code source. Convert the local repo path to its human GitHub blob URL at the current SHA and cite it."
  printf '%s\n' "$FOLLOWED" | grep -Eq 'https://([a-z0-9-]+\.)?cognidao\.org/work/items/' ||
    block "Process-contract breach: Followed omits the work-item plane consulted for scope and ownership. Cite the human work-item URL."

  REVIEWED_COUNT="$(printf '%s\n' "$ETA_CONF" | grep -Eo '[0-9]+/[0-9]+[[:space:]]+(relevant[[:space:]]+)?sources' | tail -n 1 | cut -d/ -f1 || true)"
  if [[ -n "$REVIEWED_COUNT" && "$REVIEWED_COUNT" -gt "$URL_COUNT" ]]; then
    block "Process-contract breach: ETA · Conf claims $REVIEWED_COUNT reviewed sources but Followed contains only $URL_COUNT distinct URLs. Add every material source actually used or correct the count."
  fi
fi

if [[ -n "$SCRATCHPAD_DIR" && -d "$SCRATCHPAD_DIR" ]]; then
  STATE_FILE="$SCRATCHPAD_DIR/cogni-status-contract.json"
  if [[ -s "$STATE_FILE" ]]; then
    EXPECTED_GOAL="$(jq -r '.goal' "$STATE_FILE")"
    EXPECTED_DONE="$(jq -r '.doneWhen' "$STATE_FILE")"
    if [[ "$GOAL" != "$EXPECTED_GOAL" || "$DONE_WHEN" != "$EXPECTED_DONE" ]]; then
      block "Contract breach: Goal and Done when are frozen after proposal. Rewrite the response using exactly: Goal = $EXPECTED_GOAL ; Done when = $EXPECTED_DONE"
    fi
  elif [[ "$GOAL" != "—" && "$DONE_WHEN" != "—" ]]; then
    jq -cn --arg goal "$GOAL" --arg doneWhen "$DONE_WHEN" \
      '{goal:$goal,doneWhen:$doneWhen}' >"$STATE_FILE"
  fi
fi

exit 0
