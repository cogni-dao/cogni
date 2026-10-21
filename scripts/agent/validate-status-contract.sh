#!/usr/bin/env bash
# Claude Code Stop hook: WARN (non-blocking) on a final response that breaches Cogni's status
# contract. The `Cogni Contract` output style is the primary driver — it shapes generation in
# the system-prompt layer. This hook is the secondary detector: it surfaces the breach so the
# agent self-corrects on the NEXT turn, but it NEVER re-prompts or hard-blocks. A hard Stop-block
# runs on every agent on the node, so one over-strict check wedges the whole fleet (the pre-#2722
# per-reply /work/items/ loop) and can only grade format, taxing substantive replies with re-emit
# round-trips. See .claude/skills/cognition-expert/SKILL.md (warn-only is canon).

set -euo pipefail

INPUT="$(cat)"
MESSAGE="$(printf '%s' "$INPUT" | jq -r '.last_assistant_message // ""')"
SCRATCHPAD_DIR="$(printf '%s' "$INPUT" | jq -r '.scratchpad_dir // ""')"

# The bundle owns the envelope. Observe only an admitted local contract; this
# read-only loader mode never refreshes, links credentials, or takes a hook lock.
# The cache may be newer than Claude's already-resolved import, so this remains
# advisory evidence, not a claim about exactly what the current model received.
LOADER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/session-cognition.sh"
CONTRACT="$(bash "$LOADER" --cached-contract)"
[[ -n "$CONTRACT" ]] || exit 0

# Short-circuit readers must not close a producer pipe under pipefail: a valid
# large response can otherwise fail with SIGPIPE before the advisory is decided.
first_nonempty="$(awk 'NF { print; exit }' <<<"$MESSAGE")"
last_nonempty="$(printf '%s\n' "$MESSAGE" | awk 'NF { line=$0 } END { print line }')"
# A cold Claude import can precede a concurrent successful cache warm. Clearly
# marked recovery is diagnostic, never an alternate normal response template.
case "$first_nonempty" in
  *'COGNI COGNITION'*'BOOTSTRAP RECOVERY'*) exit 0 ;;
esac

# Emit a non-blocking advisory (systemMessage, no decision:block).
advise() {
  jq -cn --arg reason "contract advisory (non-blocking): $1" '{systemMessage:$reason}'
  exit 0
}

# Extract generic Markdown table groups without assuming production field labels
# or item-column counts. Separators establish tables; return header + data rows.
table_rows() {
  awk -v wanted="$1" '
    function separator(line, cells, count, i) {
      gsub(/[[:space:]]/, "", line)
      sub(/^\|/, "", line); sub(/\|$/, "", line)
      count = split(line, cells, "|")
      if (count < 2) return 0
      for (i = 1; i <= count; i++) if (cells[i] !~ /^:?---[-]*:?$/) return 0
      return 1
    }
    /^[[:space:]]*\|.*\|[[:space:]]*$/ {
      if (separator($0)) {
        number++
        active = 1
        if (number == wanted) print previous
      } else {
        if (active && number == wanted) print
        previous = $0
      }
      next
    }
    { active = 0; previous = "" }
  '
}
normalize_row() {
  awk -F'|' '{
    for (i = 2; i < NF; i++) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
      printf "%s%s", (i > 2 ? "|" : ""), $i
    }
    print ""
  }'
}
summary_labels() {
  table_rows 1 | awk -F'|' '{
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2
  }'
}
expected_labels="$(printf '%s\n' "$CONTRACT" | summary_labels)"
actual_labels="$(printf '%s\n' "$MESSAGE" | summary_labels)"
[[ "$actual_labels" == "$expected_labels" ]] ||
  advise "Envelope mismatch: use the summary table fields and order in the loaded cognition status-contract."
expected_header="$(printf '%s\n' "$CONTRACT" | table_rows 2 | awk 'NR == 1' | normalize_row)"
actual_header="$(printf '%s\n' "$MESSAGE" | table_rows 2 | awk 'NR == 1' | normalize_row)"
[[ "$actual_header" == "$expected_header" ]] ||
  advise "Envelope mismatch: use the item-table columns in the loaded cognition status-contract."
item_columns="$(printf '%s\n' "$expected_header" | awk -F'|' '{ print NF }')"
printf '%s\n' "$MESSAGE" | table_rows 2 | awk -F'|' -v columns="$item_columns" '
  NF - 2 != columns { bad = 1 }
  END { exit (NR < 2 || bad) }
' || advise "Envelope mismatch: item rows must match the loaded template column count."
next_field="$(printf '%s\n' "$expected_header" | awk -F'|' '{
  for (i = 1; i <= NF; i++) if (tolower($i) == "next") print i + 1
}')"

# The final quote label and divider are template-owned too. Do not introduce a
# production label when the admitted template does not contain one.
quote_label="$(printf '%s\n' "$CONTRACT" | awk '
  /^>/ && match($0, /\*\*[^*]+\*\*/) { label = substr($0, RSTART, RLENGTH) }
  END { print label }
')"
if [[ -n "$quote_label" ]]; then
  [[ "$last_nonempty" == '>'* && "$last_nonempty" == *"$quote_label"* ]] ||
    advise "Envelope mismatch: end with the final quote label in the loaded cognition template."
fi
if grep -Eq '^([*][*][*]|---)$' <<<"$CONTRACT"; then
  grep -Eq '^([*][*][*]|---)$' <<<"$MESSAGE" ||
    advise "Envelope mismatch: include the divider shown in the loaded cognition template."
fi
outside_block="$(awk '
  NF == 0 { next }
  /^\|/ { next }
  /^---$/ { next }
  /^\*\*\*$/ { next }
  /^>/ { next }
  { print; exit }
' <<<"$MESSAGE")"
[[ -z "$outside_block" ]] ||
  advise "Envelope mismatch: follow the loaded template without extra prose outside its tables and final quote."

extract_cell() {
  local row_pattern="$1"
  awk -F'|' -v pattern="$row_pattern" '
    $2 ~ pattern {
      value=$3
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' <<<"$MESSAGE"
}

GOAL="$(extract_cell 'Goal')"
DONE_WHEN="$(extract_cell 'Done when')"
STATUS="$(extract_cell 'Status')"
ETA_CONF="$(extract_cell 'ETA · Conf')"
FOLLOWED="$(extract_cell 'Followed')"
template_has_field() {
  grep -Fq "$1" <<<"$expected_labels"
}
if ! template_has_field Goal || ! template_has_field 'Done when'; then
  exit 0
fi
[[ -n "$GOAL" && -n "$DONE_WHEN" ]] ||
  advise "Contract breach: the loaded Goal and Done when fields need complete values."

if [[ "$GOAL" == "—" || "$DONE_WHEN" == "—" ]]; then
  [[ "$GOAL" == "—" && "$DONE_WHEN" == "—" ]] ||
    advise "Contract breach: before substantive alignment, Goal and Done when must both remain —. Continue research and rewrite the whole response."
  ! template_has_field Status || [[ "$STATUS" == "—" ]] ||
    advise "Process-contract breach: before the evidence pass supports a proposal, Goal, Done when, and Status must all remain —. Continue research silently and rewrite the complete block."
  if [[ -n "$next_field" ]] && ! printf '%s\n' "$MESSAGE" | table_rows 2 | awk -F'|' -v field="$next_field" '
    $field ~ /👉 needs you:|👀/ { found=1 }
    END { exit found ? 0 : 1 }
  '; then
    advise "Process-contract breach: Goal and Done when are still —, and no human or asynchronous gate exists. A preliminary status is not a legal stop; continue the agent-owned research now, then return with an evidence-backed proposal."
  fi
else
  ! template_has_field Followed || [[ "$FOLLOWED" != "—" && "$FOLLOWED" == *"https://"* ]] ||
    advise "Process-contract breach: a substantive proposal requires Followed to contain verified human URLs for sources actually consulted. Continue research; do not propose from an empty evidence base."
  if grep -Eqi 'reviewed[[:space:]]+0|(^|[^0-9])0/[1-9][0-9]*|0[[:space:]]+sources' <<<"$ETA_CONF"; then
    advise "Process-contract breach: a substantive proposal cannot report zero reviewed sources. Keep Goal, Done when, and Status as —, complete the required research pass, then propose from evidence."
  fi

  # A Stop hook validates STRUCTURE, never ledger-completeness. Whether every
  # material source is cited — and which planes (skill / code / work item) apply —
  # depends on the task and is graded by the eval / human, not a regex. The old
  # per-plane URL mandates (skills|knowledge, a code blob, a work-item URL) plus a
  # hard >=3 count were unsatisfiable for legitimate replies that have no work item
  # or no code source (e.g. a definitional Q&A), so they rejected every rewrite and
  # looped the agent forever. Keep only what is deterministically checkable: a
  # substantive proposal cites at least one real source.
  REVIEWED_COUNT="$(printf '%s\n' "$ETA_CONF" | grep -Eo '[0-9]+/[0-9]+[[:space:]]+(relevant[[:space:]]+)?sources' | tail -n 1 | cut -d/ -f1 || true)"
  URL_COUNT="$(printf '%s\n' "$FOLLOWED" | grep -Eo 'https://[^| )]+' | sort -u | wc -l | tr -d ' ' || true)"
  if [[ -n "$FOLLOWED" && -n "$REVIEWED_COUNT" && "$REVIEWED_COUNT" -gt "$URL_COUNT" ]]; then
    advise "Process-contract breach: ETA · Conf claims $REVIEWED_COUNT reviewed sources but Followed contains only $URL_COUNT distinct URLs. Add every material source actually used or correct the count."
  fi
fi

if [[ -n "$SCRATCHPAD_DIR" && -d "$SCRATCHPAD_DIR" ]]; then
  STATE_FILE="$SCRATCHPAD_DIR/cogni-status-contract.json"
  if [[ -s "$STATE_FILE" ]]; then
    EXPECTED_GOAL="$(jq -r '.goal' "$STATE_FILE")"
    EXPECTED_DONE="$(jq -r '.doneWhen' "$STATE_FILE")"
    if [[ "$GOAL" != "$EXPECTED_GOAL" || "$DONE_WHEN" != "$EXPECTED_DONE" ]]; then
      advise "Contract breach: Goal and Done when are frozen after proposal. Rewrite the response using exactly: Goal = $EXPECTED_GOAL ; Done when = $EXPECTED_DONE"
    fi
  elif [[ "$GOAL" != "—" && "$DONE_WHEN" != "—" ]]; then
    jq -cn --arg goal "$GOAL" --arg doneWhen "$DONE_WHEN" \
      '{goal:$goal,doneWhen:$doneWhen}' >"$STATE_FILE"
  fi
fi

exit 0
