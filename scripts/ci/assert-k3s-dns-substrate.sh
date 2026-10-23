#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Purpose: Fence optional catalog DNS publication on current TEST writer and substrate facts.
# Scope: Read-only runner kubectl over the existing SSH transport. Does not apply resources or read secret values.
# Invariants: Run before the first deploy-branch copy/commit; unknown ownership or zone disagreement fails.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${TARGET:?TARGET required}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-candidate-a}"
export DEPLOY_ENVIRONMENT
plan="$(node --experimental-strip-types "$APP_SOURCE_DIR/scripts/lib/render-k3s-dns.mjs" --preflight "$TARGET")"
[ "$plan" != null ] || { echo 'No explicit k3s DNS intent; existing substrate path unchanged.'; exit 0; }
# This receipt contains public routing metadata and selected resource conditions only.
receipt="${K3S_DNS_PREFLIGHT_RECEIPT:?K3S_DNS_PREFLIGHT_RECEIPT required}"
DNS_PLAN="$plan" python3 - "$receipt" <<'PY'
import json,os,sys
p=json.loads(os.environ['DNS_PLAN'])
p.update(schemaVersion=1,phase='before-overlay-publication',status='pending',configuredZoneId=os.environ.get('CLOUDFLARE_ZONE_ID',''),runId=os.environ.get('GITHUB_RUN_ID'),attempt=os.environ.get('GITHUB_RUN_ATTEMPT'),parentSha=os.environ.get('GITHUB_SHA'),childSha=os.environ.get('NODE_SOURCE_SHA'))
assert p['repository']=='cogni-test-org/cogni-monorepo' and p['environment']=='candidate-a', 'isolated DNS intent is TEST candidate only'
with open(sys.argv[1],'w') as f:json.dump(p,f,indent=2)
PY
: "${VM_HOST:?VM_HOST required for current substrate read}"
ssh_opts_raw="${SSH_OPTS:--i /home/runner/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"
read -r -a ssh_opts <<<"$ssh_opts_raw"
# Only this workflow owns the SSH call. The agent never dials the substrate directly.
"${K3S_DNS_PREFLIGHT_SSH_BIN:-ssh}" "${ssh_opts[@]}" "root@${VM_HOST}" bash -s -- "$TARGET" "$DEPLOY_ENVIRONMENT" > "${receipt}.facts" <<'REMOTE'
set -euo pipefail
node="$1"; env_name="$2"; namespace="cogni-${env_name}"
# Read failures remain UNKNOWN objects, allowing the full identity receipt to be
# captured even if one prerequisite is absent. The local validator refuses them.
read_object() {
  local value
  value="$(kubectl "$@" --ignore-not-found -o json 2>/dev/null)" || value='{"readError":true,"items":[{"readError":true}]}'
  [ -n "$value" ] || value='{}'
  printf '%s' "$value"
}
# Project each resource immediately; no Secret values or Request headers enter stdout.
crd=$(read_object get crd requests.http.m.crossplane.io | jq '{readError:.readError,name:.metadata.name,conditions:.status.conditions}')
provider=$(read_object get provider provider-http | jq '{readError:.readError,name:.metadata.name,package:.spec.package,conditions:.status.conditions}')
config=$(read_object get clusterproviderconfigs.http.m.crossplane.io cogni-http | jq '{readError:.readError,name:.metadata.name,source:.spec.credentials.source}')
eso=$(read_object -n "$namespace" get externalsecret operator-env-secrets | jq '{readError:.readError,name:.metadata.name,conditions:.status.conditions}')
key_present=$(kubectl -n "$namespace" get secret operator-env-secrets -o go-template='{{if index .data "CLOUDFLARE_API_TOKEN"}}true{{else}}false{{end}}' 2>/dev/null) || key_present=false
appset=$(read_object -n argocd get applicationset "cogni-${env_name}-${node}" | jq '{readError:.readError,name:.metadata.name,uid:.metadata.uid,ownerReferences:.metadata.ownerReferences,tracking:.metadata.annotations["argocd.argoproj.io/tracking-id"],argoInstance:.metadata.labels["app.kubernetes.io/instance"],generators:.spec.generators,source:.spec.template.spec.source}')
app=$(read_object -n argocd get application "${env_name}-${node}" | jq '{readError:.readError,name:.metadata.name,ownerReferences:.metadata.ownerReferences,resources:.status.resources,source:.spec.source,destination:.spec.destination,sync:.status.sync,health:.status.health}')
deployment=$(read_object -n "$namespace" get deployment "${node}-node-app" | jq '{readError:.readError,name:.metadata.name,uid:.metadata.uid,tracking:.metadata.annotations["argocd.argoproj.io/tracking-id"],argoInstance:.metadata.labels["app.kubernetes.io/instance"],generation:.metadata.generation,status:.status,replicas:.spec.replicas,images:[.spec.template.spec.containers[]?.image],instance:.spec.template.metadata.labels["app.kubernetes.io/instance"]}')
service=$(read_object -n "$namespace" get service "${node}-node-app" | jq '{readError:.readError,name:.metadata.name,selector:.spec.selector,ports:.spec.ports}')
replicasets=$(read_object -n "$namespace" get replicasets -l "app.kubernetes.io/instance=${node}" | jq '[.items[]?|{readError:.readError,uid:.metadata.uid,ownerReferences:.metadata.ownerReferences}]')
pods=$(read_object -n "$namespace" get pods -l "app.kubernetes.io/instance=${node}" | jq '[.items[]?|{readError:.readError,uid:.metadata.uid,name:.metadata.name,ownerReferences:.metadata.ownerReferences,images:[.spec.containers[]?.image],conditions:.status.conditions}]')
dns_request=$(read_object -n "$namespace" get requests.http.m.crossplane.io "${node}-workload-dns" | jq 'if .readError then {readError:true} elif .metadata.name then {name:.metadata.name,owner:.metadata.annotations["cogni.io/dns-owner"],conditions:.status.conditions} else null end')
endpoints=$(read_object -n "$namespace" get endpointslices -l "kubernetes.io/service-name=${node}-node-app" | jq '[.items[]?|{readError:.readError,name:.metadata.name,endpoints:[.endpoints[]?|{conditions,targetRef}]}]')
jq -nc --argjson crd "$crd" --argjson provider "$provider" --argjson config "$config" --argjson eso "$eso" --argjson keyPresent "$key_present" --argjson appset "$appset" --argjson app "$app" --argjson deployment "$deployment" --argjson service "$service" --argjson replicasets "$replicasets" --argjson pods "$pods" --argjson dnsRequest "$dns_request" --argjson endpoints "$endpoints" '{crd:$crd,provider:$provider,config:$config,eso:$eso,keyPresent:$keyPresent,appset:$appset,app:$app,deployment:$deployment,service:$service,replicasets:$replicasets,pods:$pods,dnsRequest:$dnsRequest,endpoints:$endpoints}'
REMOTE
python3 "$SCRIPT_DIR/lib/check-k3s-dns-preflight.py" "$receipt" "${receipt}.facts"
