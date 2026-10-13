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
printf '%s\n' "$MESSAGE" | grep -Eq '^\|[[:space:]]*item[[:space:]]*\|[[:space:]]*owner[[:space:]]*\|[[:space:]]*deliverable links[[:space:]]*\|[[:space:]]*status[[:space:]]*\|[[:space:]]*ETA · Conf[[:space:]]*\|[[:space:]]*next[[:space:]]*\|' ||
  block "Contract breach: the items table must include item, owner, deliverable links, status, ETA · Conf, and next. Rewrite the whole response in the required shape."

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

validate_short_eta() {
  local value="$1"
  local duration normalized lower upper unit

  duration="${value%%·*}"
  normalized="$(printf '%s' "$duration" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]+//g; s/minutes?/m/g; s/hours?/h/g')"
  printf '%s' "$normalized" | grep -Eq '^[0-9]+([–-][0-9]+)?[mh]$' || return 1

  lower="$(printf '%s' "$normalized" | grep -Eo '^[0-9]+')"
  upper="$(printf '%s' "$normalized" | grep -Eo '[0-9]+' | tail -n 1)"
  unit="${normalized#"${normalized%?}"}"

  if [[ "$unit" == "m" ]]; then
    [[ "$lower" -ge 5 && "$lower" -le "$upper" && "$upper" -le 240 ]]
  else
    [[ "$lower" -ge 1 && "$lower" -le "$upper" && "$upper" -le 4 ]]
  fi
}

validate_status_semantics() {
  local value="$1"
  case "$value" in
    "🔵 in progress" | "👉 needs you" | "🟢 full E2E Done") return 0 ;;
    "👀 watching" | "👀 watching "* | "👀 verifying" | "👀 verifying "*) return 0 ;;
    "🟡 warning" | "🟡 warning "*) return 0 ;;
    "🔴 broken" | "🔴 broken "* | "🔴 fixing" | "🔴 fixing "*) return 0 ;;
    *) return 1 ;;
  esac
}

GOAL="$(extract_cell 'Goal')"
DONE_WHEN="$(extract_cell 'Done when')"
STATUS="$(extract_cell 'Status')"
ETA_CONF="$(extract_cell 'ETA · Conf')"
FOLLOWED="$(extract_cell 'Followed')"
[[ -n "$GOAL" && -n "$DONE_WHEN" ]] ||
  block "Contract breach: Goal and Done when must each occupy one complete table cell. Rewrite the whole response in the required shape."

if [[ "$STATUS" != "—" ]]; then
  validate_status_semantics "$STATUS" ||
    block "Semantic-status breach: summary status must use the canonical state vocabulary; emoji are not decorative. Rewrite the complete block."
  summary_status_words="$(printf '%s' "$STATUS" | awk '{ print NF-1 }')"
  [[ "$summary_status_words" -le 6 ]] ||
    block "Contract breach: summary status prose must be at most six words. Rewrite the complete block."
fi

if [[ "$ETA_CONF" != —* ]]; then
  printf '%s' "$ETA_CONF" | grep -Eq '·[[:space:]]*earned[[:space:]]+[0-9]+%' ||
    block "Feedback-loop breach: top-level ETA must include earned confidence. Rewrite the complete block."
  top_confidence="$(printf '%s' "$ETA_CONF" | grep -Eo 'earned[[:space:]]+[0-9]+%' | head -n 1 | grep -Eo '[0-9]+')"
  [[ -n "$top_confidence" && "$top_confidence" -le 100 ]] ||
    block "Feedback-loop breach: top-level earned confidence must be 0–100%. Rewrite the complete block."
  if [[ "$ETA_CONF" == 0m* ]]; then
    [[ "$STATUS" == 🟢* && "$ETA_CONF" == *"earned 100%"* ]] ||
      block "Feedback-loop breach: top-level 0m is reserved for a green completed Goal at earned 100% confidence. Rewrite the complete block."
  elif ! validate_short_eta "$ETA_CONF"; then
    block "Feedback-loop breach: top-level ETA must be a 5m–4h estimate such as 15m, 45–90m, or 2–3h. Decompose day-scale work and rewrite the complete block."
  elif [[ "$STATUS" == 🟢* ]]; then
    block "Semantic-status breach: a green completed Goal must use 0m · earned 100%. Rewrite the complete block."
  fi
fi

row_error="$(printf '%s\n' "$MESSAGE" | awk -F'|' '
  BEGIN { in_items=0; row_count=0 }
  $2 ~ /^[[:space:]]*item[[:space:]]*$/ { in_items=1; next }
  in_items && $0 ~ /^\|[[:space:]-]+\|/ { next }
  in_items && $0 !~ /^\|/ { in_items=0 }
  in_items && /^\|/ {
    row_count++
    if (NF != 8) { print "table:malformed"; next }

    item=$2; owner=$3; deliverable=$4; status=$5; eta=$6; next_cell=$7
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", item)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", owner)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", deliverable)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", eta)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", next_cell)

    linked_item=item ~ /^\[(story|task|bug|spike|subtask)[.][0-9]+[[:space:]]+—[[:space:]].+\]\(https:\/\/([a-z0-9-]+[.])?cognidao[.]org\/work\/items\/(story|task|bug|spike|subtask)[.][0-9]+\)$/
    proposed_item=item ~ /^proposed story[[:space:]]+—[[:space:]].+$/
    if (linked_item) {
      label_id=item
      sub(/^\[/, "", label_id)
      sub(/[[:space:]]+—.*/, "", label_id)
      url_id=item
      sub(/^.*\/work\/items\//, "", url_id)
      sub(/\).*$/, "", url_id)
      if (label_id != url_id) linked_item=0
    }
    if (!linked_item && !proposed_item) { print "item:unlinked"; next }

    visible_item=item
    sub(/\]\([^)]*\)[[:space:]]*$/, "]", visible_item)
    gsub(/\[|\]/, "", visible_item)
    purpose_count=split(visible_item, item_parts, /[[:space:]]+—[[:space:]]+/)
    if (purpose_count < 2) { print "item:missing-purpose"; exit }
    word_count=split(item_parts[purpose_count], purpose_words, /[[:space:]]+/)
    if (word_count > 4) { print "item:verbose"; exit }

    if (owner != "dev-manager, me" && owner !~ /^subagent [a-zA-Z0-9_.-]+$/) {
      print "owner:invalid"; next
    }
    if (deliverable != "-" && deliverable !~ /\[[^]]+\]\(https:\/\/[^)]+\)/) {
      print "deliverable:invalid"; next
    }
    if (next_cell == "") { print "next:missing"; next }

    status_without_emoji=status
    emoji_count=gsub(/🔵|👀|👉|🟡|🔴|🟢/, "", status_without_emoji)
    if (status !~ /^(🔵|👀|👉|🟡|🔴|🟢)/ || emoji_count != 1) { print "status:" status; exit }
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", status_without_emoji)
    status_word_count=split(status_without_emoji, status_words, /[[:space:]]+/)
    if (status_word_count > 4) { print "status:verbose"; exit }
    semantic_status = \
      status == "🔵 in progress" || status == "👉 needs you" || status == "🟢 full E2E Done" || \
      status ~ /^👀 (watching|verifying)([[:space:]]|$)/ || status ~ /^🟡 warning([[:space:]]|$)/ || \
      status ~ /^🔴 (broken|fixing)([[:space:]]|$)/
    if (!semantic_status) { print "status:meaning"; next }

    human_gate = next_cell ~ /^👉 needs you: \[[^]]+\]\(https:\/\/[^)]+\)$/
    async_gate = next_cell ~ /^👀 \[[^]]+\]\(https:\/\/[^)]+\)$/
    if (status ~ /^👉/ && !human_gate) { print "status:gate"; next }
    if (status ~ /^👀/ && !async_gate) { print "status:gate"; next }
    if (status ~ /^🟢/ && next_cell != "-") { print "status:gate"; next }
    if (status ~ /^(🔵|🟡|🔴)/ && (human_gate || next_cell == "-")) {
      print "status:gate"; next
    }
    if (eta == "") { print "eta:missing"; exit }
    print "row:" status "\t" eta "\t" next_cell
  }
  END {
    if (row_count == 0) print "table:empty"
    if (row_count > 4) print "table:too-many"
  }
')"

human_rows=0
async_rows=0
complete_rows=0
active_rows=0
while IFS=$'\t' read -r marker row_eta row_next; do
  [[ -n "$marker" ]] || continue
  case "$marker" in
    table:*) block "Contract breach: the items table must contain 1–4 complete six-cell rows. Rewrite the complete block." ;;
    item:*) block "Contract breach: each item must be a linked id or proposed story plus a purpose of at most four words. Move detail behind links and rewrite the complete block." ;;
    owner:*) block "Contract breach: each owner must be exactly dev-manager, me or subagent <name>. Rewrite the complete block." ;;
    deliverable:*) block "Contract breach: deliverable links must be verified HTTPS artifact links or -. Rewrite the complete block." ;;
    next:*) block "Contract breach: every item row needs a next ownership gate or -. Rewrite the complete block." ;;
    status:meaning) block "Semantic-status breach: each status must use canonical wording that matches its emoji; work-item states and decorative colors are invalid. Rewrite the complete block." ;;
    status:gate) block "Ownership breach: each status must agree with next—human, async, active, or complete. Rewrite the complete block." ;;
    status:*) block "Contract breach: each item status must start with exactly one canonical status emoji. Rewrite the complete block." ;;
    eta:*) block "Feedback-loop breach: every item row needs ETA · Conf. Rewrite the complete block." ;;
    row:*)
      row_status="${marker#row:}"
      if [[ "$row_eta" == "0m · earned 100%" ]]; then
        [[ "$row_status" == 🟢* ]] || block "Feedback-loop breach: only a completed green row may use 0m · earned 100%. Rewrite the complete block."
      else
        [[ "$row_status" != 🟢* ]] ||
          block "Semantic-status breach: a green completed row must use 0m · earned 100%. Rewrite the complete block."
        validate_short_eta "$row_eta" || block "Feedback-loop breach: each active row ETA must be 5m–4h. Decompose day-scale work and rewrite the complete block."
        printf '%s' "$row_eta" | grep -Eq '·[[:space:]]*earned[[:space:]]+[0-9]+%' ||
          block "Feedback-loop breach: each item row must pair ETA with earned confidence. Rewrite the complete block."
        row_confidence="$(printf '%s' "$row_eta" | grep -Eo 'earned[[:space:]]+[0-9]+%' | head -n 1 | grep -Eo '[0-9]+')"
        [[ -n "$row_confidence" && "$row_confidence" -le 100 ]] ||
          block "Feedback-loop breach: each item row earned confidence must be 0–100%. Rewrite the complete block."
      fi
      case "$row_next" in
        "-") complete_rows=$((complete_rows + 1)) ;;
        "👉 needs you: "*) human_rows=$((human_rows + 1)) ;;
        "👀 "*) async_rows=$((async_rows + 1)) ;;
        *) active_rows=$((active_rows + 1)) ;;
      esac
      ;;
  esac
done <<<"$row_error"

if [[ "$GOAL" == "—" || "$DONE_WHEN" == "—" ]]; then
  [[ "$GOAL" == "—" && "$DONE_WHEN" == "—" ]] ||
    block "Contract breach: before substantive alignment, Goal and Done when must both remain —. Continue research and rewrite the whole response."
  [[ "$STATUS" == "—" ]] ||
    block "Process-contract breach: before the evidence pass supports a proposal, Goal, Done when, and Status must all remain —. Continue research silently and rewrite the complete block."
  if ! printf '%s\n' "$MESSAGE" | awk -F'|' '
    $7 ~ /👉 needs you:|👀/ { found=1 }
    END { exit found ? 0 : 1 }
  '; then
    block "Process-contract breach: Goal and Done when are still —, and no human or asynchronous gate exists. A preliminary status is not a legal stop; continue the agent-owned research now, then return with an evidence-backed proposal."
  fi
else
  [[ "$active_rows" -eq 0 ]] ||
    block "Ownership breach: an agent-owned next action remains. Continue working; this is not a legal stop state."
  [[ "$human_rows" -eq 0 || "$async_rows" -eq 0 ]] ||
    block "Ownership breach: incomplete rows mix human and async stop classes. Resolve or tighten to one immediate gate."
  if [[ "$human_rows" -gt 0 ]]; then
    [[ "$STATUS" == 👉* ]] ||
      block "Semantic-status breach: the summary must be 👉 needs you when human action is the immediate gate."
  elif [[ "$async_rows" -gt 0 ]]; then
    [[ "$STATUS" == 👀* ]] ||
      block "Semantic-status breach: the summary must be 👀 watching/verifying when every incomplete row waits asynchronously."
  elif [[ "$complete_rows" -gt 0 ]]; then
    [[ "$STATUS" == "🟢 full E2E Done" ]] ||
      block "Semantic-status breach: the summary must be 🟢 full E2E Done when every row is complete."
  fi

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
