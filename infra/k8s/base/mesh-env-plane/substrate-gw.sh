#!/bin/sh
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# substrate-gw — the env VM's ONE tailnet device (tag:substrate). task.5428, design: hub
# node-service-delivery §2 (connectivity decision, task.5384). Stock tooling only: the pinned
# tailscale 1.104.4 image's tailscaled + tailscale CLI + busybox (sh, sed, awk, bc, base64).
#
# Three jobs, one loop:
#   1. RUN   tailscaled in userspace (no TUN, no capabilities), state on the env VM's local-path PVC,
#            no log upload, our control URL only, control over TLS 443 only. tailscaled inherits the
#            HR21 knobs from the container env (substrate-gw.yaml, bug.5588): TS_NO_LOGS_NO_SUPPORT,
#            TS_FORCE_NOISE_443 (no refused port-80 try, so a Headscale restart starts no bootstrap DNS to
#            derp*.tailscale.com), TS_DISABLE_FEATURE=captiveportal,clientupdate and the
#            TS_PANIC_IF_HIT_MAIN_CONTROL tripwire. The state dir is a SUBDIRECTORY of the volume that
#            this uid creates and owns (mode 0700): the local-path volume root is root-owned 0777 and
#            tailscaled must chmod its state dir, which a non-root, capability-free uid cannot do on a
#            root-owned directory. Deleting the volume still deletes all state (HR10: fresh device). `tailscale up` holds NO key: an unregistered device
#            asks to join with --advertise-tags=tag:substrate and waits for approval (enrollment by
#            approval). It asks AGAIN whenever the device is not joined and has no pending request
#            (its node was deleted, HR11, or the coordinator was wiped, HR10): no person acts.
#   2. GUARD (fail closed, hard requirement 20). substrate-gw enforces the policy from its LAST map, so
#            while it cannot reach Headscale a deleted node keeps access. When the device is out of
#            its map poll for longer than SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS (default 4 h) this loop
#            runs `tailscale serve reset`: nothing is forwarded. When the map poll returns it applies
#            the declared serve config again. The lost-since clock is kept on the state volume, so a
#            container restart does not reset the bound.
#   3. PUBLISH the enrollment request: {authId, machineKey, nodeKey, backendState, publishedAt} at
#            $SUBSTRATE_GW_PUBLISH_DIR/substrate-gw.json, served read-only by the publisher sidecar
#            behind this VM's DNS-only ACME site. Nothing here is a credential: the sequencer approves
#            ONLY a request it reads over that verified channel and then checks tags + keys (HR11).
#            tailscale 1.104.4 exposes no pending node key and no machine key on its CLI/LocalAPI, so
#            the machine key is derived from the device's own state (X25519 of `_machinekey`, in bc)
#            and the node key is published as soon as the device knows it (after approval).
#
# Delivery: infra/k8s/base/mesh-env-plane (Argo, the env VM's own k3s). Log lines are JSON on stdout
# (Loki {namespace="cogni-mesh",container="substrate-gw"}):
#   substrate_gw_watchdog        heartbeat once a minute
#   substrate_gw_map_poll_lost   every tick while joined but out of map poll {lostSeconds, boundSeconds}
#   substrate_gw_enrollment_pending  once a minute while not joined (waiting for approval)
#   substrate_gw_enrollment_requested  `tailscale up` (re)issued: boot, NoState/NeedsLogin with no running
#                                    request, deleted device or wiped coordinator {reason, backendState,
#                                    backoffSeconds}
#   substrate_gw_serve_reset     the bound passed; forwarding stopped
#   substrate_gw_serve_restored  the declared serve config is applied (boot or map poll returned)
#   substrate_gw_control_probe   before tailscaled starts: one TCP connect try to the control host :443
#                                failed {try, waitedSeconds, boundSeconds}
#   substrate_gw_control_reachable  the connect succeeded; tailscaled starts now {tries, waitedSeconds}
#   substrate_gw_control_unreachable  no connect within the bound; exit 1 (the pod restarts)
set -u

: "${MESH_CONTROL_URL:?MESH_CONTROL_URL is required (https://mesh-<env>.<zone>)}"
: "${TS_SERVE_CONFIG:?TS_SERVE_CONFIG is required (declared tailnet ports)}"
: "${TS_STATE_DIR:=/var/lib/tailscale/state}"
: "${TS_SOCKET:=/tmp/tailscaled.sock}"
: "${TS_HOSTNAME:=substrate-gw}"
: "${TS_PORT:=41641}"
BOUND="${SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS:-14400}"
INTERVAL="${SUBSTRATE_GW_WATCHDOG_INTERVAL_SECONDS:-15}"
PROBE_BOUND="${SUBSTRATE_GW_CONTROL_PROBE_BOUND_SECONDS:-60}"
PUBLISH_DIR="${SUBSTRATE_GW_PUBLISH_DIR:-/publish}"
LOST_FILE="${TS_STATE_DIR}/watchdog.lost-since"
STATE_FILE="${TS_STATE_DIR}/tailscaled.state"

case "$MESH_CONTROL_URL" in
  https://*:*|https://*/*) echo "MESH_CONTROL_URL must be https://<host> on 443 only" >&2; exit 64 ;;
  https://?*) ;;
  *) echo "MESH_CONTROL_URL must be https:// (hard requirement 22)" >&2; exit 64 ;;
esac
case "$BOUND$INTERVAL$PROBE_BOUND" in *[!0-9]*) echo "bounds and interval must be whole seconds" >&2; exit 64 ;; esac
CONTROL_HOST="${MESH_CONTROL_URL#https://}"

ts() { tailscale --socket="$TS_SOCKET" "$@"; }
now() { date +%s; }
log() { printf '{"msg":"%s","ts":"%s"%s}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:+,$2}"; }

# X25519(k, 9) — the public half of a curve25519 private key (RFC 7748 §5), in POSIX bc.
# $1 = 64 hex chars of the private key (little-endian bytes). Prints 64 hex chars (little-endian).
x25519_public() {
  hex="$1"
  case "$hex" in *[!0-9a-fA-F]*|"") return 1 ;; esac
  [ "${#hex}" -eq 64 ] || return 1
  # Little-endian bytes -> big-endian hex for bc; clamp first (RFC 7748 decodeScalar25519).
  be="$(printf '%s' "$hex" | awk '{
    for (i = 0; i < 32; i++) b[i] = substr($0, 2*i+1, 2)
    d0 = 0; d31 = 0
    for (j = 1; j <= 2; j++) {
      d0 = d0 * 16 + index("0123456789abcdef", tolower(substr(b[0], j, 1))) - 1
      d31 = d31 * 16 + index("0123456789abcdef", tolower(substr(b[31], j, 1))) - 1
    }
    d0 = d0 - d0 % 8; d31 = d31 % 64 + 64
    b[0] = sprintf("%02x", d0); b[31] = sprintf("%02x", d31)
    out = ""; for (i = 31; i >= 0; i--) out = out b[i]
    print toupper(out)
  }')"
  out="$(BC_LINE_LENGTH=0 bc <<BC
ibase=16
k=$be
ibase=A
p=2^255-19
define m(x) { auto r; r = x % p; if (r < 0) r += p; return r; }
define pw(b, e) { auto r; r = 1; b = m(b); while (e > 0) { if (e % 2 == 1) r = m(r * b); b = m(b * b); e = e / 2; }; return r; }
for (i = 0; i < 255; i++) { t[i] = k % 2; k = k / 2; }
x1 = 9; x2 = 1; z2 = 0; x3 = 9; z3 = 1; s = 0
for (i = 254; i >= 0; i--) {
  if (s != t[i]) { q = x2; x2 = x3; x3 = q; q = z2; z2 = z3; z3 = q; }
  s = t[i]
  a = m(x2 + z2); aa = m(a * a); b = m(x2 - z2); bb = m(b * b); e = m(aa - bb)
  c = m(x3 + z3); d = m(x3 - z3); da = m(d * a); cb = m(c * b)
  x3 = m((da + cb) * (da + cb)); z3 = m(x1 * m((da - cb) * (da - cb)))
  x2 = m(aa * bb); z2 = m(e * m(aa + 121665 * e))
  }
if (s == 1) { q = x2; x2 = x3; x3 = q; q = z2; z2 = z3; z3 = q; }
obase=16
m(x2 * pw(z2, p - 2))
BC
)" || return 1
  printf '%s\n' "$out" | awk '{
    s = $0; while (length(s) < 64) s = "0" s
    o = ""; for (i = 31; i >= 0; i--) o = o substr(s, 2*i+1, 2); print tolower(o)
  }'
}

# The device's machine key, derived once from its own persisted state (never leaves this host).
machine_key() {
  [ -s "$STATE_FILE" ] || return 1
  b64="$(sed -n 's/.*"_machinekey": *"\([A-Za-z0-9+/=]*\)".*/\1/p' "$STATE_FILE" | head -n1)"
  [ -n "$b64" ] || return 1
  priv="$(printf '%s' "$b64" | base64 -d 2>/dev/null | sed -n 's/^privkey:\([0-9a-f]\{64\}\)$/\1/p')"
  [ -n "$priv" ] || return 1
  pub="$(x25519_public "$priv")" || return 1
  printf 'mkey:%s' "$pub"
}

# `tailscale status --json` is indented JSON; Self's fields are the only ones at 4 spaces.
field() { printf '%s\n' "$1" | sed -n "s/^$2\"$3\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" | head -n1; }

in_map_poll() {
  # Healthy = Running AND Self.Online. tailscaled sets Self.Online from its health tracker's
  # in-map-poll flag (the `not-in-map-poll` warnable), so it is false the moment the long poll to
  # Headscale is gone. Measured on 1.104.4: the Health[] text array stays EMPTY during an outage, so
  # it is not a usable signal.
  [ "$1" = "Running" ] || return 1
  [ "$(field "$2" '    ' Online)" = "true" ]
}

serving() { [ "$(ts serve status --json 2>/dev/null | tr -d ' \n')" != "{}" ]; }

apply_serve() {
  if ts debug localapi POST serve-config - < "$TS_SERVE_CONFIG" >/dev/null 2>&1; then
    log substrate_gw_serve_restored "\"servePorts\":\"$(sed -n 's/^ *"\([0-9]*\)": *{.*/\1/p' "$TS_SERVE_CONFIG" | tr '\n' ' ' | sed 's/ $//')\""
  else
    log substrate_gw_serve_apply_failed ""
  fi
}

publish() {
  [ -d "$PUBLISH_DIR" ] || return 0
  auth_id=""
  if [ "$1" = "NeedsLogin" ] || [ "$1" = "NeedsMachineAuth" ]; then
    case "$2" in */register/*) auth_id="${2##*/register/}" ;; esac
  fi
  case "$3" in nodekey:0000000000000000000000000000000000000000000000000000000000000000) node_key="" ;; *) node_key="$3" ;; esac
  tmp="$PUBLISH_DIR/.substrate-gw.json.$$"
  printf '{"authId":"%s","machineKey":"%s","nodeKey":"%s","backendState":"%s","controlUrl":"%s","publishedAt":"%s"}\n' \
    "$auth_id" "$MKEY" "$node_key" "$1" "$MESH_CONTROL_URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" \
    && mv -f "$tmp" "$PUBLISH_DIR/substrate-gw.json"
}

# The volume root is root-owned 0777: create our own 0700 subdirectory (tailscaled chmods it).
# mesh-env-plane.spec.ts pins TS_STATE_DIR strictly below the state volume's mountPath.
mkdir -p "$TS_STATE_DIR" && chmod 0700 "$TS_STATE_DIR" \
  || { echo "cannot create state dir $TS_STATE_DIR" >&2; exit 1; }

# HR21 at pod start (bug.5588). tailscaled's control dialer starts bootstrap DNS to derp*.tailscale.com on
# ANY failed dial, and tailscale 1.104.4 has no knob to turn that off. On a fresh pod the first dial can be
# refused before this pod's NetworkPolicy egress is programmed (validated 10:04:52-57Z: "dial tcp
# <mesh-control-fwd ClusterIP>:443: connection refused" -> 10 and 12 bootstrapDNS lines). So tailscaled starts only after a
# plain TCP connect to the SAME host:port it will dial (the control host, a hostAlias to mesh-control-fwd,
# :443) succeeds. Probe = the image's busybox `nc -z` (no bash in the image; its nc getopt string
# "^np:s:ubvw:+lki:o:z" has -z and -w). It contacts only the forwarder. Backoff 1, 2, 4, 8, 8 ... s, up
# to PROBE_BOUND (60 s default); never reached -> exit 1, the pod restarts and tries again.
wait_for_control() {
  start="$(now)"; delay=1; try=0
  while :; do
    try=$((try + 1))
    if nc -z -w 3 "$CONTROL_HOST" 443 </dev/null >/dev/null 2>&1; then
      log substrate_gw_control_reachable "\"tries\":$try,\"waitedSeconds\":$(($(now) - start))"
      return 0
    fi
    waited=$(($(now) - start))
    log substrate_gw_control_probe "\"try\":$try,\"waitedSeconds\":$waited,\"boundSeconds\":$PROBE_BOUND"
    [ "$waited" -lt "$PROBE_BOUND" ] || return 1
    sleep "$delay"
    delay=$((delay * 2)); [ "$delay" -le 8 ] || delay=8
  done
}
wait_for_control || { log substrate_gw_control_unreachable "\"boundSeconds\":$PROBE_BOUND"; exit 1; }

tailscaled --tun=userspace-networking --statedir="$TS_STATE_DIR" --socket="$TS_SOCKET" \
  --port="$TS_PORT" --no-logs-no-support &
TSD=$!
trap 'kill -TERM "$TSD" "${UP:-}" 2>/dev/null; wait "$TSD"; exit 0' TERM INT

i=0
until ts status --json >/dev/null 2>&1; do
  kill -0 "$TSD" 2>/dev/null || { echo "tailscaled exited during start" >&2; exit 1; }
  i=$((i + 1)); [ "$i" -le 60 ] || { echo "tailscaled LocalAPI never answered" >&2; exit 1; }
  sleep 1
done

# Holds no key. Registered state on the volume: returns at once. Unregistered: waits for approval.
# Re-requests back off: INTERVAL, doubling, at most 300 s; reset once the device is Running.
UP=""
UP_BACKOFF="$INTERVAL"
NEXT_UP=0
# The CLI is started with `exec` in its background subshell, so $UP is the `tailscale up` process
# itself (a backgrounded shell function would leave $! = a wrapper subshell, and killing that
# orphans the CLI). Kill, then wait: the old request is gone and reaped before a new one starts.
request_enrollment() {
  if [ -n "$UP" ]; then
    kill "$UP" 2>/dev/null || true
    wait "$UP" 2>/dev/null || true
  fi
  (exec tailscale --socket="$TS_SOCKET" up --login-server="$MESH_CONTROL_URL" --hostname="$TS_HOSTNAME" \
    --advertise-tags=tag:substrate --accept-dns=false --accept-routes=false --timeout=0 >/dev/null 2>&1) &
  UP=$!
  NEXT_UP=$(($(now) + UP_BACKOFF))
  log substrate_gw_enrollment_requested "\"reason\":\"$1\",\"backendState\":\"${2:-}\",\"backoffSeconds\":$UP_BACKOFF"
  UP_BACKOFF=$((UP_BACKOFF * 2)); [ "$UP_BACKOFF" -le 300 ] || UP_BACKOFF=300
}
request_enrollment boot

MKEY=""
tick=0
noauth=0
while kill -0 "$TSD" 2>/dev/null; do
  [ -n "$MKEY" ] || MKEY="$(machine_key 2>/dev/null || true)"
  st="$(ts status --json 2>/dev/null || true)"
  backend="$(field "$st" '  ' BackendState)"
  auth_url="$(field "$st" '  ' AuthURL)"
  node_key="$(field "$st" '    ' PublicKey)"
  publish "${backend:-unknown}" "$auth_url" "$node_key"

  # Re-enrollment (HR10/HR11): not joined (NoState included: a fresh or wiped store) and no pending
  # request for more than 2 ticks, or the waiting `tailscale up` is gone -> ask again, with backoff,
  # so a fresh authId is published with no person. Never wait forever on NoState.
  case "$backend" in
    NoState | NeedsLogin | NeedsMachineAuth | Stopped)
      if [ -z "$auth_url" ]; then noauth=$((noauth + 1)); else noauth=0; fi
      if { [ "$noauth" -gt 2 ] || ! kill -0 "${UP:-0}" 2>/dev/null; } && [ "$(now)" -ge "$NEXT_UP" ]; then
        noauth=0
        request_enrollment "not_joined_no_pending_request" "$backend"
      fi ;;
    Running) noauth=0; UP_BACKOFF="$INTERVAL" ;;
    *) noauth=0 ;;
  esac

  t="$(now)"
  if in_map_poll "$backend" "$st"; then
    if [ -s "$LOST_FILE" ]; then rm -f "$LOST_FILE"; fi
    serving || apply_serve
  else
    [ -s "$LOST_FILE" ] || printf '%s\n' "$t" > "$LOST_FILE"
    since="$(cat "$LOST_FILE")"; case "$since" in *[!0-9]*|"") since="$t" ;; esac
    lost=$((t - since))
    on=false; serving && on=true
    case "$backend" in
      # Not joined (first boot, or its device was deleted): waiting for approval, not a lost poll.
      NeedsLogin | NeedsMachineAuth)
        [ $((tick % (60 / INTERVAL + 1))) -eq 0 ] \
          && log substrate_gw_enrollment_pending "\"authIdPublished\":$([ -n "$auth_url" ] && echo true || echo false),\"serving\":$on" ;;
      *) log substrate_gw_map_poll_lost "\"lostSeconds\":$lost,\"boundSeconds\":$BOUND,\"backendState\":\"${backend:-unknown}\",\"serving\":$on" ;;
    esac
    if [ "$lost" -gt "$BOUND" ] && [ "$on" = true ]; then
      ts serve reset >/dev/null 2>&1 && log substrate_gw_serve_reset "\"lostSeconds\":$lost,\"boundSeconds\":$BOUND"
    fi
  fi

  if [ $((tick % (60 / INTERVAL + 1))) -eq 0 ]; then
    on=false; serving && on=true
    log substrate_gw_watchdog "\"backendState\":\"${backend:-unknown}\",\"boundSeconds\":$BOUND,\"serving\":$on,\"machineKeyKnown\":$([ -n "$MKEY" ] && echo true || echo false)"
  fi
  tick=$((tick + 1))
  sleep "$INTERVAL"
done
echo "tailscaled exited" >&2
exit 1
