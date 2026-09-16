#!/usr/bin/env bash
# recover-orphaned-akash-lease.sh — close an Akash lease that no live controller
# still owns, PROVE it closed, and only then let Kubernetes finish its teardown.
#
# WHY: an Akash lease is paid, wallet-global state whose lifetime is longer than
# any Kubernetes object's. Two ways that binding breaks, both seen in bug.5189:
#
#   (1) TRACKING OBJECT STUCK, LEASE UNTRACKED. A legacy `ComputeWorkload` sits
#       terminating on finalizer `compute.cogni.io/external-resource` whose owner
#       (the legacy compute-workload-controller) was removed from the cluster in
#       PR #2212 and deleted in #2276. Nothing alive can clear it, so its Argo
#       Application + ApplicationSet wedge behind it. The obvious "fix" — strip
#       the finalizer — destroys the only record of a lease that keeps spending.
#   (2) TRACKING OBJECT GONE, LEASE STILL BILLING. The k8s object was GC'd (or an
#       Argo cascade deleted the XR) without its lease ever being released. There
#       is now nothing in-cluster naming the lease; it is recoverable by dseq
#       ALONE, from the wallet, and it bills until someone closes it.
#
# Both are the same job in a fixed, non-negotiable order:
#
#     CLOSE THE LEASE  →  VERIFY IT CLOSED  →  ONLY THEN TOUCH THE FINALIZER
#
# This script refuses to invert that order. If closure cannot be PROVEN by
# re-reading Console state, it exits non-zero with the finalizer left in place:
# a wedged namespace is recoverable, an orphaned paid lease is not.
#
# INVARIANTS
#   - CLOSE_BEFORE_CLEAR: the finalizer is only ever cleared after a Console
#     read-back proves deployment+lease+escrow are all closed. A 200 from any
#     writer is NOT proof; only the re-read is.
#   - SANCTIONED_WRITER_FIRST: closure is attempted through the akash-tx-actuator
#     (`POST /v1/akash/delete`), the ONE legitimate writer for this wallet, so the
#     release is recorded in the `akash_tx_allocations` ledger and
#     ONE_WALLET_ONE_WRITER holds. Console is a fallback used ONLY when the
#     actuator structurally cannot act — i.e. no durable receipt binds the lease,
#     which is exactly the case for leases minted by the retired legacy
#     controller (the actuator answers `422 identity_conflict`).
#   - CREDENTIAL_NEVER_LEAVES_THE_POD: every Console/actuator call runs INSIDE the
#     actuator pod against its own projected credentials. No secret is ever read
#     into this script, an argv, an env var, or a log line.
#   - RECOVERABLE_BY_DSEQ_ALONE: a lease whose k8s object no longer exists is
#     still fully recoverable — pass `--dseq`. Step 4 is then a documented no-op,
#     not a failure.
#   - IDEMPOTENT: an already-closed lease verifies and proceeds; an absent k8s
#     object is reported and skipped. Re-running changes nothing.
#
# Usage:
#   # (1) a ComputeWorkload stuck on the legacy finalizer — resolves its own dseq
#   recover-orphaned-akash-lease.sh --workload 72aa130b-f0ad-495a-a061-9ee1f9c9525d
#
#   # (2) an orphan whose tracking object is already gone — dseq is enough
#   recover-orphaned-akash-lease.sh --dseq 1789530710249
#
#   # audit only: never writes, never clears anything
#   recover-orphaned-akash-lease.sh --audit
#
#   # several at once; flags may repeat and mix
#   recover-orphaned-akash-lease.sh --workload <name> --dseq <dseq> --dseq <dseq>
#
# Env:
#   KUBECONFIG          required; the cluster holding the actuator
#   NAMESPACE           default `cogni-candidate-a`
#   DRY_RUN=1           resolve + read Console, but never close and never clear
#
# Exit: 0 = every target closed, verified, and unwedged (or already was)
#       1 = a target could not be PROVEN closed — finalizer deliberately left on
#
# See: docs/spec/cicd-platform-boundary.md (deploy brain is frozen — this is a
#      one-shot ops script, not new pipeline logic), infra/crossplane/AGENTS.md,
#      nodes/operator/app/src/features/compute/akash-tx/akash-tx-actuator.ts.
set -euo pipefail

NAMESPACE="${NAMESPACE:-cogni-candidate-a}"
DRY_RUN="${DRY_RUN:-0}"
LEGACY_FINALIZER="compute.cogni.io/external-resource"

WORKLOADS=()
DSEQS=()
AUDIT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workload) WORKLOADS+=("${2:?--workload needs a name}"); shift 2 ;;
    --dseq)     DSEQS+=("${2:?--dseq needs a dseq}"); shift 2 ;;
    --audit)    AUDIT_ONLY=1; shift ;;
    --namespace) NAMESPACE="${2:?--namespace needs a value}"; shift 2 ;;
    -h|--help)  sed -n '2,70p' "$0"; exit 0 ;;
    *) echo "FATAL: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

if [ "$AUDIT_ONLY" = 0 ] && [ ${#WORKLOADS[@]} -eq 0 ] && [ ${#DSEQS[@]} -eq 0 ]; then
  echo "FATAL: nothing to do — pass --workload, --dseq, or --audit." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# In-pod execution. The actuator pod is the ONLY place that holds the wallet
# credential; we send it code, never ask it for secrets.
# ---------------------------------------------------------------------------

ACTUATOR_POD="$(kubectl -n "$NAMESPACE" get pods \
  -l app.kubernetes.io/name=akash-tx-actuator \
  -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' 2>/dev/null | awk '{print $1}')"
if [ -z "$ACTUATOR_POD" ]; then
  # Fall back to the deployment's generated name prefix (label schemes have drifted).
  ACTUATOR_POD="$(kubectl -n "$NAMESPACE" get pods --no-headers 2>/dev/null \
    | awk '$3=="Running" && $1 ~ /akash-tx-actuator/ {print $1; exit}')"
fi
if [ -z "$ACTUATOR_POD" ]; then
  echo "FATAL: no Running akash-tx-actuator pod in namespace '$NAMESPACE'." >&2
  echo "  Without the sanctioned writer there is no safe way to close a lease;" >&2
  echo "  refusing to proceed rather than clearing a finalizer blind." >&2
  exit 1
fi

# The pod filesystem is read-only, so the helper is streamed in as base64 and run
# via `node --input-type=module -e`. Nothing is written to disk, in or out.
POD_HELPER="$(mktemp)"
trap 'rm -f "$POD_HELPER"' EXIT
cat > "$POD_HELPER" <<'POD_JS'
import { readFileSync } from "node:fs";

const SECRET_DIR = "/var/run/secrets/akash-tx";
const CONSOLE_BASE = "https://console-api.akash.network";
const ACTUATOR_BASE = "http://127.0.0.1:8080";
const read = (name) => readFileSync(`${SECRET_DIR}/${name}`, "utf8").trim();

/** Console read. Returns the closure-relevant facts ONLY — never the SDL, which
 *  echoes env keys and future resolved secrets. */
async function describe(dseq) {
  const r = await fetch(`${CONSOLE_BASE}/v1/deployments/${encodeURIComponent(dseq)}`, {
    headers: { "x-api-key": read("AKASH_ACTUATOR_CONSOLE_API_KEY"), accept: "application/json" },
  });
  if (r.status === 404) return { dseq, http: 404, absent: true };
  const j = await r.json().catch(() => undefined);
  const d = (j && typeof j === "object" && "data" in j) ? j.data : j;
  const leases = d?.leases ?? [];
  return {
    dseq,
    http: r.status,
    deploymentState: d?.deployment?.state ?? null,
    leaseStates: leases.map((l) => l.state ?? null),
    closeReasons: leases.map((l) => l.reason ?? null),
    escrowState: d?.escrow_account?.state?.state ?? null,
    escrowFunds: d?.escrow_account?.state?.funds?.[0]?.amount ?? null,
    owner: d?.deployment?.id?.owner ?? null,
  };
}

/** The durable receipt, if one exists. Absent => the actuator structurally
 *  cannot act on this lease and Console fallback is the ONLY path. */
async function receipt(dseq) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(read("DATABASE_URL"), { max: 1 });
  try {
    const rows = await sql`
      select cogni_key, state, external_name, node_id
      from akash_tx_allocations
      where external_name = ${String(dseq)}
      limit 1`;
    return rows[0] ?? null;
  } finally {
    await sql.end();
  }
}

/** Every active deployment on the wallet — the only honest orphan audit, since
 *  a lease with no k8s object is invisible from the cluster. */
async function walletActive() {
  const key = read("AKASH_ACTUATOR_CONSOLE_API_KEY");
  const all = [];
  for (let skip = 0; ; skip += 1000) {
    const r = await fetch(`${CONSOLE_BASE}/v1/deployments?skip=${skip}&limit=1000`, {
      headers: { "x-api-key": key, accept: "application/json" },
    });
    const j = await r.json(); const d = j.data ?? j;
    all.push(...(d?.deployments ?? []));
    if (!d?.pagination?.hasMore) break;
  }
  return all
    .filter((x) => (x.state ?? x.deployment?.state) === "active")
    .map((x) => String(x.dseq ?? x.deployment?.id?.dseq));
}

async function actuatorDelete(cogniKey, dseq) {
  const r = await fetch(`${ACTUATOR_BASE}/v1/akash/delete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${read("AKASH_TX_ACTUATOR_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cogniKey, externalName: String(dseq) }),
  });
  return { http: r.status, body: await r.text() };
}

async function consoleDelete(dseq) {
  const r = await fetch(`${CONSOLE_BASE}/v1/deployments/${encodeURIComponent(dseq)}`, {
    method: "DELETE",
    headers: { "x-api-key": read("AKASH_ACTUATOR_CONSOLE_API_KEY"), accept: "application/json" },
  });
  await r.body?.cancel().catch(() => {});
  return { http: r.status };
}

const [op, ...rest] = process.argv.slice(1);
let out;
switch (op) {
  case "describe":        out = await describe(rest[0]); break;
  case "receipt":         out = await receipt(rest[0]); break;
  case "wallet-active":   out = { active: await walletActive() }; break;
  case "actuator-delete": out = await actuatorDelete(rest[0], rest[1]); break;
  case "console-delete":  out = await consoleDelete(rest[0]); break;
  default: throw new Error(`unknown op '${op}'`);
}
console.log(JSON.stringify(out));
POD_JS
POD_HELPER_B64="$(base64 < "$POD_HELPER" | tr -d '\n')"

in_pod() {
  kubectl -n "$NAMESPACE" exec "$ACTUATOR_POD" -- sh -c \
    "node --input-type=module -e \"\$(echo $POD_HELPER_B64 | base64 -d)\" $*"
}

jget() { printf '%s' "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))"; }

# ---------------------------------------------------------------------------
# Closure proof. This is the gate the whole script exists to defend.
# ---------------------------------------------------------------------------

# Prints a human summary; returns 0 ONLY when Console independently confirms the
# deployment, every lease, and the escrow account are all closed.
verify_closed() {
  local dseq="$1" state
  state="$(in_pod describe "$dseq")"
  local deployment escrow leases funds
  deployment="$(jget "$state" deploymentState)"
  escrow="$(jget "$state" escrowState)"
  funds="$(jget "$state" escrowFunds)"
  leases="$(printf '%s' "$state" | python3 -c "import json,sys; print(','.join(str(x) for x in json.load(sys.stdin).get('leaseStates',[])) or 'none')")"
  echo "    console: deployment=$deployment leases=[$leases] escrow=$escrow funds=$funds"

  if [ "$(jget "$state" absent)" = "True" ]; then
    echo "    VERIFIED: Console has no such deployment (nothing to bill)."
    return 0
  fi
  if [ "$deployment" != "closed" ]; then
    echo "    NOT CLOSED: deployment.state='$deployment' (want 'closed')." >&2
    return 1
  fi
  if printf '%s' "$leases" | grep -qv '^\(closed\|none\)\(,\(closed\|none\)\)*$'; then
    echo "    NOT CLOSED: a lease is not in state 'closed' (=[$leases])." >&2
    return 1
  fi
  if [ -n "$escrow" ] && [ "$escrow" != "closed" ]; then
    echo "    NOT CLOSED: escrow account state='$escrow' (want 'closed')." >&2
    return 1
  fi
  echo "    VERIFIED: deployment + leases + escrow all closed."
  return 0
}

# ---------------------------------------------------------------------------
# Step 1 — close, sanctioned writer first.
# ---------------------------------------------------------------------------

close_lease() {
  local dseq="$1" rec cogni_key http body

  rec="$(in_pod receipt "$dseq")"
  cogni_key="$(jget "$rec" cogni_key)"

  if [ -n "$cogni_key" ]; then
    echo "    receipt: cogniKey=$cogni_key state=$(jget "$rec" state) node=$(jget "$rec" node_id)"
    echo "    closing via the sanctioned writer (akash-tx-actuator delete)…"
    local resp; resp="$(in_pod actuator-delete "$cogni_key" "$dseq")"
    http="$(jget "$resp" http)"; body="$(jget "$resp" body)"
    if [ "$http" = "200" ]; then
      echo "    actuator: HTTP 200 $body  (release recorded in akash_tx_allocations)"
      return 0
    fi
    echo "    actuator refused: HTTP $http $body" >&2
    # `identity_conflict` is terminal by design: no receipt binds this key to this
    # resource, so no retry can change the answer. Fall through to Console.
  else
    echo "    receipt: NONE — no durable receipt binds this lease."
    echo "    The actuator's delete calls requireStoredHandle() and will answer"
    echo "    422 identity_conflict; the sanctioned writer structurally cannot act."
  fi

  echo "    FALLBACK: closing via Console API with the actuator's own credential," \
       "from inside the actuator pod (key never materialised outside it)."
  local dresp; dresp="$(in_pod console-delete "$dseq")"
  http="$(jget "$dresp" http)"
  echo "    console DELETE /v1/deployments/$dseq -> HTTP $http"
  case "$http" in
    2*|404) return 0 ;;
    *) echo "    FATAL: Console refused the close (HTTP $http)." >&2; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Step 3 — clear the finalizer. Reached ONLY after verify_closed succeeded.
# ---------------------------------------------------------------------------

clear_finalizer() {
  local name="$1"
  if ! kubectl -n "$NAMESPACE" get computeworkload "$name" >/dev/null 2>&1; then
    echo "    k8s: no ComputeWorkload '$name' — already GC'd; nothing to unwedge."
    return 0
  fi
  local fins
  fins="$(kubectl -n "$NAMESPACE" get computeworkload "$name" -o jsonpath='{.metadata.finalizers}' 2>/dev/null || true)"
  case "$fins" in
    *"$LEGACY_FINALIZER"*) ;;
    *) echo "    k8s: '$name' does not carry $LEGACY_FINALIZER (finalizers=$fins); leaving alone."; return 0 ;;
  esac
  if [ "$DRY_RUN" = "1" ]; then
    echo "    DRY_RUN: would remove $LEGACY_FINALIZER from '$name'."
    return 0
  fi
  echo "    clearing $LEGACY_FINALIZER on '$name' (closure proven above)…"
  kubectl -n "$NAMESPACE" patch computeworkload "$name" --type=json \
    -p "[{\"op\":\"remove\",\"path\":\"/metadata/finalizers\"}]"
}

# ---------------------------------------------------------------------------
# Drive one target through the fixed order.
# ---------------------------------------------------------------------------

FAILED=0

recover() {
  local name="$1" dseq="$2"
  echo "=== recovering ${name:+workload=$name }dseq=${dseq:-<unresolved>}"

  if [ -z "$dseq" ]; then
    if [ -n "$name" ] && ! kubectl -n "$NAMESPACE" get computeworkload "$name" >/dev/null 2>&1; then
      echo "    FATAL: no ComputeWorkload '$name' in '$NAMESPACE' — the tracking object" >&2
      echo "    is already gone. Its lease (if any) is now recoverable by dseq ALONE:" >&2
      echo "    find it with --audit and re-run with --dseq <dseq>." >&2
    else
      echo "    FATAL: no lease id for '$name' — the object records no status.resource.id." >&2
      echo "    Find it on the wallet (--audit) and re-run with --dseq." >&2
    fi
    FAILED=1; return
  fi

  # Step 1+2. Already-closed is the idempotent happy path: verify, never re-close.
  if verify_closed "$dseq"; then
    echo "    already closed — no write needed (idempotent)."
  elif [ "$DRY_RUN" = "1" ]; then
    echo "    DRY_RUN: would close $dseq, then re-verify. Stopping before any write."
    FAILED=1; return
  else
    close_lease "$dseq" || { FAILED=1; return; }
    echo "    re-reading Console (a 200 is not proof)…"
    if ! verify_closed "$dseq"; then
      echo "    REFUSING to clear any finalizer: closure of $dseq is UNPROVEN." >&2
      echo "    A wedged namespace is recoverable; an orphaned paid lease is not." >&2
      FAILED=1; return
    fi
  fi

  # Step 3. Only ever reached with closure proven by read-back.
  if [ -n "$name" ]; then
    clear_finalizer "$name"
  else
    echo "    k8s: no tracking object for this lease — nothing to unwedge (recovered by dseq alone)."
  fi
  echo "    done."
}

# --audit: the wallet is the only honest source for orphans with no k8s object.
if [ "$AUDIT_ONLY" = 1 ] || [ ${#WORKLOADS[@]} -gt 0 ] || [ ${#DSEQS[@]} -gt 0 ]; then
  echo "=== wallet audit (active deployments, authoritative) ==="
  in_pod wallet-active | python3 -c "
import json,sys
a=json.load(sys.stdin)['active']
print('    active deployments:', len(a))
for d in a: print('     ', d)
"
fi
[ "$AUDIT_ONLY" = 1 ] && [ ${#WORKLOADS[@]} -eq 0 ] && [ ${#DSEQS[@]} -eq 0 ] && exit 0

for name in ${WORKLOADS[@]+"${WORKLOADS[@]}"}; do
  dseq="$(kubectl -n "$NAMESPACE" get computeworkload "$name" \
    -o jsonpath='{.status.resource.id}' 2>/dev/null || true)"
  recover "$name" "$dseq"
done

for dseq in ${DSEQS[@]+"${DSEQS[@]}"}; do
  # A lease known only by dseq may still have a ComputeWorkload naming it; if the
  # receipt knows the node, that name is the object to unwedge.
  name="$(in_pod receipt "$dseq" | python3 -c "import json,sys; r=json.load(sys.stdin); print((r or {}).get('node_id') or '')" 2>/dev/null || true)"
  if [ -n "$name" ] && ! kubectl -n "$NAMESPACE" get computeworkload "$name" >/dev/null 2>&1; then
    name=""
  fi
  recover "$name" "$dseq"
done

if [ "$FAILED" != 0 ]; then
  echo "FAILED: at least one lease could not be proven closed; finalizers left in place." >&2
  exit 1
fi
echo "OK: every target closed, verified against Console, and unwedged."
