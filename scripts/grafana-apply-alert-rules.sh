#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Apply Grafana-managed alert rules + contact points + notification policy from
# git to a Grafana Cloud stack via the HTTP provisioning API. This is Layer 3
# of the three-layer datasource-health contract documented in
# infra/grafana/AGENTS.md.
#
# Idempotent: every apply ends with a PUT-by-UID against each resource. Source
# of truth lives under infra/grafana/alerts/.
#
# Required env:
#   GRAFANA_URL                       e.g. https://<org>.grafana.net
#   GRAFANA_SERVICE_ACCOUNT_TOKEN     glsa_… (Editor / Admin)
#   GRAFANA_ALERTS_EMAIL              recipient address for the email contact point
#
# Optional env:
#   COGNI_ENVS                        default: candidate-a,preview,production
#   COGNI_NODE_DBS                    default: cogni_operator,cogni_poly,cogni_resy
#   ALERTS_FOLDER_UID                 default: cogni-grafana-alerts
#   ALERTS_FOLDER_TITLE               default: Cogni alerts
#   ALERTS_REPO_ROOT                  default: $(git rev-parse --show-toplevel)

set -euo pipefail

log() {
  echo "[grafana-alerts] $*"
}

if [[ -z "${GRAFANA_URL:-}" && -z "${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  log "Grafana not configured; skipping alert-rule apply"
  exit 0
fi

: "${GRAFANA_URL:?GRAFANA_URL not set}"
: "${GRAFANA_SERVICE_ACCOUNT_TOKEN:?GRAFANA_SERVICE_ACCOUNT_TOKEN not set}"
: "${GRAFANA_ALERTS_EMAIL:?GRAFANA_ALERTS_EMAIL not set (email for contact-point derek-email)}"

case "$GRAFANA_SERVICE_ACCOUNT_TOKEN" in
  glc_*)
    echo "GRAFANA_SERVICE_ACCOUNT_TOKEN is a Grafana Cloud token (glc_), not a Grafana stack service-account token (glsa_)" >&2
    exit 1
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

repo_root="${ALERTS_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
alerts_dir="${repo_root}/infra/grafana/alerts"
contact_point_file="${alerts_dir}/contact-points/derek-email.json"
policy_file="${alerts_dir}/notification-policies/root.json"
rule_template_file="${alerts_dir}/rules/postgres-datasource-health.template.json"

for f in "$contact_point_file" "$policy_file" "$rule_template_file"; do
  [[ -f "$f" ]] || { echo "missing alert source file: $f" >&2; exit 1; }
done

grafana_base="${GRAFANA_URL%/}"
folder_uid="${ALERTS_FOLDER_UID:-cogni-grafana-alerts}"
folder_title="${ALERTS_FOLDER_TITLE:-Cogni alerts}"
envs="${COGNI_ENVS:-candidate-a,preview,production}"
dbs="${COGNI_NODE_DBS:-cogni_operator,cogni_poly,cogni_resy}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

curl_grafana() {
  curl -sS \
    -H "Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN}" \
    -H "X-Disable-Provenance: true" \
    "$@"
}

# 1. Ensure the alert folder exists. POST is "create or 409 already exists";
#    PUT then sets the title idempotently.
log "ensuring folder ${folder_uid}"
folder_payload="${tmpdir}/folder.json"
jq -n --arg uid "$folder_uid" --arg title "$folder_title" \
  '{uid: $uid, title: $title}' > "$folder_payload"

folder_status=$(curl_grafana -o "${tmpdir}/folder.create.json" -w "%{http_code}" \
  -X POST "${grafana_base}/api/folders" \
  -H "content-type: application/json" \
  --data @"$folder_payload")
case "$folder_status" in
  200|201|409|412) ;;
  *)
    echo "folder create failed: HTTP ${folder_status}" >&2
    cat "${tmpdir}/folder.create.json" >&2 || true
    exit 1
    ;;
esac

# 2. Apply contact point (idempotent PUT-by-UID; POST first if absent).
log "applying contact point derek-email"
cp_payload="${tmpdir}/contact-point.json"
GRAFANA_ALERTS_EMAIL="$GRAFANA_ALERTS_EMAIL" \
  envsubst '${GRAFANA_ALERTS_EMAIL}' < "$contact_point_file" \
  | jq '. + {uid: "derek-email"}' > "$cp_payload"

cp_get=$(curl_grafana -o "${tmpdir}/cp.get.json" -w "%{http_code}" \
  "${grafana_base}/api/v1/provisioning/contact-points?name=derek-email")
if [[ "$cp_get" == "200" ]] && [[ "$(jq 'length' "${tmpdir}/cp.get.json")" != "0" ]]; then
  curl_grafana -fsS -X PUT "${grafana_base}/api/v1/provisioning/contact-points/derek-email" \
    -H "content-type: application/json" --data @"$cp_payload" >/dev/null
else
  curl_grafana -fsS -X POST "${grafana_base}/api/v1/provisioning/contact-points" \
    -H "content-type: application/json" --data @"$cp_payload" >/dev/null
fi

# 3. Apply notification policy (root tree is a single resource — PUT only).
# WARNING: this overwrites the entire root tree, including any sibling routes
# added via the UI. This script is the source of truth for the root policy;
# extend root.json (add `routes`) rather than editing in Grafana.
log "applying notification policy"
curl_grafana -fsS -X PUT "${grafana_base}/api/v1/provisioning/policies" \
  -H "content-type: application/json" --data @"$policy_file" >/dev/null

# 4. Render and apply alert rule group.
log "rendering rule group cogni-postgres-datasource-health"
rules_dir="${tmpdir}/rules"
mkdir -p "$rules_dir"

IFS=',' read -ra envs_arr <<< "$envs"
IFS=',' read -ra dbs_arr <<< "$dbs"
for env_name in "${envs_arr[@]}"; do
  env_name="$(echo "$env_name" | xargs)"
  [[ -n "$env_name" ]] || continue
  for db_name in "${dbs_arr[@]}"; do
    db_name="$(echo "$db_name" | xargs)"
    [[ -n "$db_name" ]] || continue
    node="${db_name#cogni_}"
    # Grafana caps alert-rule UIDs at 40 chars; pg-health-* keeps the longest
    # combo (candidate-a / operator → 30) under the limit.
    rule_uid="pg-health-${env_name}-${node}"
    rendered="${rules_dir}/rule-${env_name}-${node}.json"

    env="$env_name" node="$node" ALERTS_FOLDER_UID="$folder_uid" \
      envsubst '${env} ${node} ${ALERTS_FOLDER_UID}' < "$rule_template_file" \
      | jq --arg uid "$rule_uid" '. + {uid: $uid}' > "$rendered"
  done
done

rules_array_file="${tmpdir}/rules.array.json"
jq -s '.' "$rules_dir"/rule-*.json > "$rules_array_file"

group_payload="${tmpdir}/rule-group.json"
jq -n \
  --arg title "cogni-postgres-datasource-health" \
  --arg folderUID "$folder_uid" \
  --slurpfile rules "$rules_array_file" \
  '{
    title: $title,
    folderUid: $folderUID,
    interval: 60,
    rules: $rules[0]
  }' > "$group_payload"

log "PUT rule group → ${folder_uid}/cogni-postgres-datasource-health"
curl_grafana -fsS -X PUT \
  "${grafana_base}/api/v1/provisioning/folder/${folder_uid}/rule-groups/cogni-postgres-datasource-health" \
  -H "content-type: application/json" \
  --data @"$group_payload" >/dev/null

log "applied $(jq 'length' "$rules_array_file") rules across envs=${envs} dbs=${dbs}"
log "done"
