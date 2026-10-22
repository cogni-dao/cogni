#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Read-only client for the exact template candidate's existing native engines.
# Public source bytes use stdin and temporary remote files, never runtime writes.
native_preservation_resolve_provider() {
  [[ "$DEPLOY_ENVIRONMENT" == candidate-a && "$TARGET_NODE" == node-template ]] || return 0
  local actual
  actual="$(deployment_provider_for_target "$TARGET_NODE" "$DEPLOY_ENVIRONMENT")" || return 1
  [[ -z "${DEPLOYMENT_PROVIDER_REQUESTED:-}" || "$DEPLOYMENT_PROVIDER_REQUESTED" == "$actual" ]] || {
    echo '::error::template provider disagrees with owning catalog' >&2
    return 1
  }
  DEPLOYMENT_PROVIDER="$actual"
  export DEPLOYMENT_PROVIDER
}

native_preservation_scope() {
  [[ "$DEPLOY_ENVIRONMENT" == candidate-a && "$TARGET_NODE" == node-template && "$DEPLOYMENT_PROVIDER" == akash ]]
}

native_preservation_remote() {
  local host="$1" service="$2" action="$3" expected="${4:-}" program command
  [[ "$host" =~ ^[a-zA-Z0-9.-]+$ ]] || return 1
  program='import io,json,pathlib,sys,tempfile
request=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="cogni-native-readonly-") as directory:
 root=pathlib.Path(directory)
 (root/"compose.yml").write_text(request["compose"])
 args=["native-guard",request["action"],"--compose",str(root/"compose.yml"),"--runtime","/opt/cogni-template-runtime"]
 if request["service"]=="postgres": args += ["--service","postgres"]
 else:
  staged=root/"install-creds.sh"; staged.write_text(request["mountedExecutable"])
  args += ["--file","/opt/cogni-template-runtime/doltgres-init/install-creds.sh="+str(staged)]
 sys.argv=args;sys.stdin=io.StringIO(request["expected"])
 exec(compile(request["helper"],"native-preservation-reviewed","exec"),{"__name__":"__main__"})'
  printf -v command 'python3 -c %q' "$program"
  python3 - "$REPO_ROOT" "$service" "$action" "$expected" <<'PY' | \
    "$NATIVE_PRESERVATION_SSH_BIN" "${NATIVE_PRESERVATION_SSH_OPTS[@]}" "root@$host" "$command"
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);service,action,expected=sys.argv[2:]
print(json.dumps({"service":service,"action":action,"expected":pathlib.Path(expected).read_text() if expected else "", "helper":(root/"scripts/ci/preserve-shared-native.remote.py").read_text(),"compose":(root/"infra/compose/runtime/docker-compose.yml").read_text(),"mountedExecutable":(root/"infra/compose/runtime/doltgres-init/install-creds.sh").read_text()}))
PY
}

native_preservation_begin() {
  NATIVE_PRESERVATION_ACTIVE=false
  native_preservation_scope || return 0
  NATIVE_PRESERVATION_SSH_BIN="${RECONCILE_NODE_SUBSTRATE_SSH_BIN:-ssh}"
  read -r -a NATIVE_PRESERVATION_SSH_OPTS <<< "${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30}"
  NATIVE_PRESERVATION_CONTROL_HOST="$VM_HOST"
  NATIVE_PRESERVATION_PG_HOST="$(lane_db_host "$TARGET_NODE" "$DEPLOY_ENVIRONMENT")" || return 1
  NATIVE_PRESERVATION_OWNS_BASELINE=false
  if [[ -z "${SUBSTRATE_NATIVE_BASELINE_DIR:-}" ]]; then
    SUBSTRATE_NATIVE_BASELINE_DIR=$(mktemp -d -t cogni-native-baseline.XXXXXX) || return 1
    NATIVE_PRESERVATION_OWNS_BASELINE=true
    export SUBSTRATE_NATIVE_BASELINE_DIR
    native_preservation_remote "$NATIVE_PRESERVATION_CONTROL_HOST" both capture > "$SUBSTRATE_NATIVE_BASELINE_DIR/control.json" || return 1
    native_preservation_remote "$NATIVE_PRESERVATION_PG_HOST" postgres capture > "$SUBSTRATE_NATIVE_BASELINE_DIR/postgres.json" || return 1
  fi
  [[ -d "$SUBSTRATE_NATIVE_BASELINE_DIR" && ! -L "$SUBSTRATE_NATIVE_BASELINE_DIR" &&
     -f "$SUBSTRATE_NATIVE_BASELINE_DIR/control.json" && ! -L "$SUBSTRATE_NATIVE_BASELINE_DIR/control.json" &&
     -f "$SUBSTRATE_NATIVE_BASELINE_DIR/postgres.json" && ! -L "$SUBSTRATE_NATIVE_BASELINE_DIR/postgres.json" ]] || return 1
  NATIVE_PRESERVATION_ACTIVE=true
  native_preservation_verify
}

native_preservation_verify() {
  [[ "${NATIVE_PRESERVATION_ACTIVE:-false}" == true ]] || return 0
  native_preservation_remote "$NATIVE_PRESERVATION_CONTROL_HOST" both verify "$SUBSTRATE_NATIVE_BASELINE_DIR/control.json" >/dev/null || return 1
  native_preservation_remote "$NATIVE_PRESERVATION_PG_HOST" postgres verify "$SUBSTRATE_NATIVE_BASELINE_DIR/postgres.json" >/dev/null
}

native_preservation_finish() {
  local rc=0
  native_preservation_verify || rc=1
  if [[ "${NATIVE_PRESERVATION_OWNS_BASELINE:-false}" == true ]]; then
    rm -rf "$SUBSTRATE_NATIVE_BASELINE_DIR"
  fi
  return "$rc"
}
