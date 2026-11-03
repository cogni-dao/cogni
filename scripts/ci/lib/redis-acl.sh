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
# Invariants:
#   - HASH_ONLY_CROSSES_SSH: only sha256(password) reaches the VM. Redis stores `#<sha256>`
#     natively, so the plaintext never lands in a remote argv, the ACL file or a log.
#   - SERVER_PROOF_BEFORE_URL: a consumer is never handed a credential the server would
#     refuse. Materialize composes REDIS_URL only when `ACL GETUSER` returns this hash.
#   - DEFAULT_USER_UNTOUCHED: phase A never edits `default`; it stays `on nopass` until
#     every consumer reads its own user (phase B).
#   - ACL_FILE_REQUIRED: a user is installed only on a Redis started with `--aclfile`, so
#     `ACL SAVE` persists it across container recreation. A Redis without one reports
#     `no-aclfile` and both primitives skip; nothing switches until infra-reconcile lands.
#
# Remote scripts are delivered on stdin (`remote "bash -s"`), never as an argv string.

# Redis user name for a node. Mirrors the Postgres role convention (app_<node>).
redis_acl_user() {
  printf 'node_%s' "${1//-/_}"
}

# Consumers need streams, keys and connection commands (XADD/XREAD/XRANGE/XLEN/EXPIRE,
# INFO for the ioredis ready check). `-@admin` withholds ACL/CONFIG/SHUTDOWN/DEBUG.
# Kept pre-quoted: the rules contain glob characters and must never be word-split.
REDIS_ACL_RULES="'~*' '&*' '+@all' '-@admin'"

redis_acl_password_sha256() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

# Shell fragment that resolves the runtime Redis container and its ACL file.
_redis_acl_preamble() {
  cat <<'SH'
set -eu
c="$(docker ps -q --filter label=com.docker.compose.project=cogni-runtime --filter label=com.docker.compose.service=redis | head -n1)"
[ -n "$c" ] || { echo no-redis; exit 0; }
aclfile="$(docker exec "$c" redis-cli --raw CONFIG GET aclfile | sed -n 2p)"
[ -n "$aclfile" ] || { echo no-aclfile; exit 0; }
SH
}

# Prints one word: proven | absent | no-aclfile | no-redis. Read-only.
redis_acl_probe_script() {
  local user="$1" hash="$2"
  [[ "$user" =~ ^node_[a-z0-9_]+$ && "$hash" =~ ^[0-9a-f]{64}$ ]] || return 2
  _redis_acl_preamble
  cat <<SH
if docker exec "\$c" redis-cli --raw ACL GETUSER '${user}' | grep -qx '${hash}'; then
  echo proven
else
  echo absent
fi
SH
}

# Prints installed | no-aclfile | no-redis; exits nonzero if an ACL-file Redis refuses.
redis_acl_install_script() {
  local user="$1" hash="$2"
  [[ "$user" =~ ^node_[a-z0-9_]+$ && "$hash" =~ ^[0-9a-f]{64}$ ]] || return 2
  _redis_acl_preamble
  cat <<SH
docker exec "\$c" redis-cli --raw ACL SETUSER '${user}' reset on '#${hash}' ${REDIS_ACL_RULES} | grep -qx OK
docker exec "\$c" redis-cli --raw ACL SAVE | grep -qx OK
docker exec "\$c" redis-cli --raw ACL GETUSER '${user}' | grep -qx '${hash}'
echo installed
SH
}
