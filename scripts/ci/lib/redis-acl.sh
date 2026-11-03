#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# redis-acl.sh — the ONE definition of a node's Redis ACL identity (task.5384 phase A).
#
# Shared by the two existing per-node substrate primitives, so the name, the rule set and the
# proof cannot drift between them:
#   - secret-materialize.sh (sole OpenBao writer) mints REDIS_PASSWORD, then composes
#     REDIS_URL only after the lane's Redis PROVES it holds that password's hash.
#   - reconcile-node-substrate.sh (read-only on OpenBao) installs the ACL user from the hash.
#
# FREEZE NOTE (docs/spec/cicd-platform-boundary.md): this is transitional shell inside the
# frozen deploy brain. Its durable home is the typed CD2 credential-binding resolver in the
# operator control plane (node-service-delivery "Shared Cherry services: binding by
# credential"). Do not grow it; move it there.
#
# Invariants:
#   - HASH_ONLY_CROSSES_SSH: only sha256(password) reaches the VM. Redis stores `#<sha256>`
#     natively, so the plaintext never lands in a remote argv, the ACL file or a log.
#   - SERVER_PROOF_BEFORE_URL: a consumer is never handed a credential the server would
#     refuse. Materialize composes REDIS_URL only when `ACL GETUSER` returns this hash.
#   - DEFAULT_USER_UNTOUCHED: phase A never edits `default`; it stays `on nopass` until
#     every consumer reads its own user (phase B).
#   - ACL_FILE_REQUIRED: a user is installed only on a Redis started with `--aclfile`, so
#     `ACL SAVE` persists it across container recreation.
#   - LEAST_PRIVILEGE: a node user reaches only `run:*` streams and its OWN `node:<nodeId>:*`
#     keys, with the stream commands ioredis needs. The install proves this with ACL DRYRUN.
#   - FAIL_LOUD: any docker/redis-cli failure prints `error` and exits nonzero; it never
#     reads as `no-redis` / `no-aclfile` (which mean "skip, nothing changes").
#
# Remote scripts are delivered on stdin (`remote "bash -s"`), never as an argv string.

# Redis user name for a node. Mirrors the Postgres role convention (app_<node>).
redis_acl_user() {
  printf 'node_%s' "${1//-/_}"
}

# Stream namespaces: `run:<runId>` (RUN_STREAM_KEY_PREFIX, packages/graph-execution-core) and
# `node:<nodeId>:events` (container.ts, nodeId = repo-spec node_id). Commands: the ioredis
# connection/ready check (INFO) plus XADD/XREAD/XRANGE/XLEN/EXPIRE. Printed pre-quoted: the
# rules contain glob characters and must never be word-split.
redis_acl_rules() {
  local node_id="$1"
  printf "resetchannels '~run:*' '~node:%s:*' -@all +@connection -@admin -@dangerous +info +xadd +xread +xrange +xlen +expire" "$node_id"
}

redis_acl_password_sha256() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

_redis_acl_valid() {
  [[ "$1" =~ ^node_[a-z0-9_]+$ && "$2" =~ ^[0-9a-f]{64}$ ]]
}

# Resolves the runtime Redis container and whether it runs with an ACL file.
# Exits 0 printing `no-redis` / `no-aclfile` ONLY on a positive answer; anything else is `error`.
_redis_acl_preamble() {
  cat <<'SH'
set -euo pipefail
err() { echo error; exit 3; }
ids="$(docker ps -q --filter label=com.docker.compose.project=cogni-runtime --filter label=com.docker.compose.service=redis)" || err
c="$(sed -n 1p <<<"$ids")"
[ -n "$c" ] || { echo no-redis; exit 0; }
cfg="$(docker exec "$c" redis-cli --raw CONFIG GET aclfile)" || err
[ "$(sed -n 1p <<<"$cfg")" = aclfile ] || err
[ -n "$(sed -n 2p <<<"$cfg")" ] || { echo no-aclfile; exit 0; }
SH
}

# Prints one word: proven | absent | no-aclfile | no-redis | error (exit 3). Read-only.
redis_acl_probe_script() {
  local user="$1" hash="$2"
  _redis_acl_valid "$user" "$hash" || return 2
  _redis_acl_preamble
  cat <<SH
got="\$(docker exec "\$c" redis-cli --raw ACL GETUSER '${user}')" || err
if grep -qx '${hash}' <<<"\$got"; then echo proven; else echo absent; fi
SH
}

# Prints installed | no-aclfile | no-redis; prints error and exits 3 when an ACL-file Redis
# refuses the user or does not enforce the least-privilege rule set (ACL DRYRUN).
redis_acl_install_script() {
  local user="$1" hash="$2" node_id="$3" other="00000000-0000-0000-0000-000000000000"
  _redis_acl_valid "$user" "$hash" || return 2
  [[ "$node_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ && "$node_id" != "$other" ]] || return 2
  _redis_acl_preamble
  cat <<SH
cli() { docker exec "\$c" redis-cli --raw "\$@"; }
out="\$(cli ACL SETUSER '${user}' reset on '#${hash}' $(redis_acl_rules "$node_id"))" || err
[ "\$out" = OK ] || err
out="\$(cli ACL SAVE)" || err
[ "\$out" = OK ] || err
out="\$(cli ACL GETUSER '${user}')" || err
grep -qx '${hash}' <<<"\$out" || err
allowed() { out="\$(cli ACL DRYRUN '${user}' "\$@")" || err; [ "\$out" = OK ] || err; }
refused() { out="\$(cli ACL DRYRUN '${user}' "\$@")" || err; [[ "\$out" == *"no permissions"* ]] || err; }
allowed INFO
allowed XADD 'node:${node_id}:events' '*' k v
allowed XREAD BLOCK 1 STREAMS 'run:dryrun' 0
allowed XRANGE 'run:dryrun' - +
allowed XLEN 'node:${node_id}:events'
allowed EXPIRE 'run:dryrun' 60
refused FLUSHALL
refused KEYS '*'
refused SCAN 0
refused EVAL 'return 1' 0
refused XADD 'node:${other}:events' '*' k v
refused CONFIG GET aclfile
echo installed
SH
}
