#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the catalog-driven node-DNS reconcile (closes the node-formation
# DNS gap): scripts/ci/lib/cloudflare-dns.sh (idempotent A-record upsert) +
# scripts/ci/reconcile-node-dns.sh (one A record per type:node → VM IP).
#
# A stateful Cloudflare shim ($CF_CURL, a JSON-backed fake DNS store) stands in
# for the real API — no network, no token. Proves:
#   1. upsert is create-on-absent, no-op-on-match, replace-on-drift (idempotent).
#   2. reconcile fans one record per NON-primary catalog node (apex skipped),
#      using host_for_node() — the same host SSOT the edge + smoke checks use.
#   3. --check is a real drift gate: green when all present, non-zero when any
#      node record is missing.
#
# Run: bash scripts/ci/tests/reconcile-node-dns.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t reconcile-node-dns.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

# ── Stateful Cloudflare shim ──────────────────────────────────────────────────
# Backs a JSON store at $CF_STORE; handles GET (list by ?name=&type=A),
# POST /dns_records (create), DELETE /dns_records/<id>. Mirrors the API surface
# cloudflare-dns.sh actually calls.
SHIM="$TMPROOT/cf-shim.py"
cat >"$SHIM" <<'PY'
#!/usr/bin/env python3
import json, os, re, sys

store_path = os.environ["CF_STORE"]

def load():
    try:
        with open(store_path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"records": [], "next_id": 1}

def save(s):
    with open(store_path, "w") as f:
        json.dump(s, f)

args = sys.argv[1:]
method, data, url = "GET", None, None
i = 0
while i < len(args):
    a = args[i]
    if a == "-X":
        method = args[i + 1]; i += 2; continue
    if a == "-d":
        data = args[i + 1]; i += 2; continue
    if a == "-H":
        i += 2; continue
    if a.startswith("http"):
        url = a
    i += 1

s = load()
m = re.search(r"/dns_records/([^/?]+)$", url or "")
if method == "DELETE" and m:
    rid = m.group(1)
    s["records"] = [r for r in s["records"] if r["id"] != rid]
    save(s)
    print(json.dumps({"success": True, "result": {"id": rid}})); sys.exit(0)

if method == "PUT" and m:
    rid = m.group(1)
    b = json.loads(data)
    for r in s["records"]:
        if r["id"] == rid:
            r["name"] = b["name"]; r["content"] = b["content"]
            r["proxied"] = bool(b["proxied"]); r["type"] = b.get("type", "A")
    save(s)
    print(json.dumps({"success": True, "result": {"id": rid}})); sys.exit(0)

if method == "POST" and url and url.endswith("/dns_records"):
    b = json.loads(data)
    rid = "rec%d" % s["next_id"]; s["next_id"] += 1
    s["records"].append({"id": rid, "name": b["name"], "content": b["content"],
                         "proxied": bool(b["proxied"]), "type": b.get("type", "A")})
    save(s)
    print(json.dumps({"success": True, "result": {"id": rid}})); sys.exit(0)

q = {}
if url and "?" in url:
    for kv in url.split("?", 1)[1].split("&"):
        if "=" in kv:
            k, v = kv.split("=", 1); q[k] = v
res = [r for r in s["records"]
       if ("name" not in q or r["name"] == q["name"])
       and ("type" not in q or r["type"] == q["type"])]
print(json.dumps({"success": True, "result": res})); sys.exit(0)
PY
chmod +x "$SHIM"

export CF_STORE="$TMPROOT/store.json"
export CF_CURL="$SHIM"
export CLOUDFLARE_API_TOKEN="test-token"
export CLOUDFLARE_ZONE_ID="zone123"
export FORK_DOMAIN_ROOT="cognidao.org"
export DOMAIN="test.cognidao.org"
VM_IP_FIXTURE="84.32.9.111"

# Count records named $1 in the store.
count_name() { CF_STORE="$CF_STORE" CF_N="$1" python3 -c '
import json,os
s=json.load(open(os.environ["CF_STORE"]))
print(sum(1 for r in s["records"] if r["name"]==os.environ["CF_N"]))'; }

# Echo the proxied flag (true/false) of the first record named $1.
proxied_of() { CF_STORE="$CF_STORE" CF_N="$1" python3 -c '
import json,os
s=json.load(open(os.environ["CF_STORE"]))
m=[r for r in s["records"] if r["name"]==os.environ["CF_N"]]
print(("true" if m[0]["proxied"] else "false") if m else "")'; }

# Echo the id of the first record named $1 (proves in-place update keeps it).
id_of() { CF_STORE="$CF_STORE" CF_N="$1" python3 -c '
import json,os
s=json.load(open(os.environ["CF_STORE"]))
m=[r for r in s["records"] if r["name"]==os.environ["CF_N"]]
print(m[0]["id"] if m else "")'; }

pass=0; fail=0
assert_eq() { # <got> <want> <desc>
  if [ "$1" = "$2" ]; then printf 'OK   %s\n' "$3"; pass=$((pass + 1));
  else printf 'FAIL %s — got %q want %q\n' "$3" "$1" "$2"; fail=$((fail + 1)); fi
}

# ── Lib: idempotent upsert ────────────────────────────────────────────────────
# shellcheck source=scripts/ci/lib/cloudflare-dns.sh
source "$REPO_ROOT/scripts/ci/lib/cloudflare-dns.sh"
printf '{"records":[],"next_id":1}' >"$CF_STORE"

# Seed the apex (operator) record — reconcile reads its content as the VM IP.
cf_upsert_a_record test-token zone123 test.cognidao.org "$VM_IP_FIXTURE" true >/dev/null

assert_eq "$(cf_upsert_a_record test-token zone123 oss-test.cognidao.org "$VM_IP_FIXTURE" true)" \
  "created" "upsert creates when absent"
assert_eq "$(cf_upsert_a_record test-token zone123 oss-test.cognidao.org "$VM_IP_FIXTURE" true)" \
  "unchanged" "upsert is a no-op when content+proxied match"
assert_eq "$(cf_a_record_content test-token zone123 oss-test.cognidao.org)" \
  "$VM_IP_FIXTURE" "content read returns the record IP"
id_before="$(id_of oss-test.cognidao.org)"
assert_eq "$(cf_upsert_a_record test-token zone123 oss-test.cognidao.org 10.0.0.9 true)" \
  "updated" "upsert UPDATES IN PLACE when content drifts (no delete-then-create)"
assert_eq "$(cf_a_record_content test-token zone123 oss-test.cognidao.org)" \
  "10.0.0.9" "drifted record now resolves to the new IP"
assert_eq "$(id_of oss-test.cognidao.org)" "$id_before" \
  "in-place update preserves the record id (never deletes the healthy record)"
assert_eq "$(count_name oss-test.cognidao.org)" "1" "update leaves exactly one record"

# ── Lib: PROTECTED guard — never clobber the zone apex / www ──────────────────
# FORK_DOMAIN_ROOT=cognidao.org → apex + www are refused by default.
if cf_upsert_a_record test-token zone123 cognidao.org "$VM_IP_FIXTURE" false >/dev/null 2>&1; then
  printf 'FAIL upsert must REFUSE the zone apex (cognidao.org)\n'; fail=$((fail + 1))
else
  printf 'OK   upsert refuses the zone apex (cognidao.org)\n'; pass=$((pass + 1))
fi
assert_eq "$(count_name cognidao.org)" "0" "apex was never written"
if cf_upsert_a_record test-token zone123 www.cognidao.org "$VM_IP_FIXTURE" false >/dev/null 2>&1; then
  printf 'FAIL upsert must REFUSE www.<root>\n'; fail=$((fail + 1))
else
  printf 'OK   upsert refuses www.<root>\n'; pass=$((pass + 1))
fi
# Deliberate apex provisioning opts in explicitly (provision Phase 4b only).
assert_eq "$(CF_ALLOW_PROTECTED=1 cf_upsert_a_record test-token zone123 cognidao.org "$VM_IP_FIXTURE" false)" \
  "created" "CF_ALLOW_PROTECTED=1 permits deliberate apex provisioning"

# ── Script: reconcile fans one record per non-primary node ────────────────────
printf '{"records":[],"next_id":1}' >"$CF_STORE"
cf_upsert_a_record test-token zone123 test.cognidao.org "$VM_IP_FIXTURE" true >/dev/null

summary_file="$TMPROOT/dns-reconcile-summary.json"
DNS_RECONCILE_SUMMARY_FILE="$summary_file" \
DNS_RECONCILE_CANDIDATE_SHA="0123456789abcdef0123456789abcdef01234567" \
DNS_RECONCILE_HEAD_SHA="abcdef0123456789abcdef0123456789abcdef01" \
DNS_RECONCILE_NODE_SOURCE_SHA="0123456789abcdef0123456789abcdef01234567" \
DNS_RECONCILE_NODE_SLUG="oss" \
GITHUB_RUN_ID="12345" \
GITHUB_RUN_ATTEMPT="2" \
GITHUB_REF_NAME="main" \
bash scripts/ci/reconcile-node-dns.sh candidate-a >/dev/null \
  || { echo "FAIL reconcile exited non-zero"; fail=$((fail + 1)); }

# host_for_node(node, test.cognidao.org) → <node>-test.cognidao.org for non-primary.
for host in oss-test.cognidao.org node-template-test.cognidao.org; do
  assert_eq "$(cf_a_record_content test-token zone123 "$host")" "$VM_IP_FIXTURE" \
    "reconcile created $host → VM IP"
done
assert_eq "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["type"])' "$summary_file")" \
  "dns_reconcile_summary" "reconcile writes Grafana DNS summary type"
assert_eq "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["states"].get("created", 0) > 0)' "$summary_file")" \
  "True" "Grafana DNS summary records created states"
assert_eq "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(any(r.get("host") == "oss-test.cognidao.org" and r.get("state") == "created" for r in d["records"]))' "$summary_file")" \
  "True" "Grafana DNS summary includes per-host state"
assert_eq "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate_sha8"])' "$summary_file")" \
  "01234567" "Grafana DNS summary carries candidate SHA correlation in JSON"
assert_eq "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$summary_file")" \
  "12345" "Grafana DNS summary carries run correlation in JSON"
# operator is is_primary_host (apex) — it must NOT get an operator-test record.
assert_eq "$(count_name operator-test.cognidao.org)" "0" "primary node skipped (no operator-test record)"

# Re-run is idempotent (no growth).
bash scripts/ci/reconcile-node-dns.sh candidate-a >/dev/null
assert_eq "$(count_name oss-test.cognidao.org)" "1" "second reconcile is idempotent"
# Node records mirror the apex proxy state (apex seeded proxied=true above).
assert_eq "$(proxied_of oss-test.cognidao.org)" "true" "node record mirrors proxied apex"

# Apex unproxied (candidate-a today) → node records created unproxied, not flipped.
printf '{"records":[],"next_id":1}' >"$CF_STORE"
cf_upsert_a_record test-token zone123 test.cognidao.org "$VM_IP_FIXTURE" false >/dev/null
bash scripts/ci/reconcile-node-dns.sh candidate-a >/dev/null
assert_eq "$(proxied_of oss-test.cognidao.org)" "false" "node record mirrors UNPROXIED apex (no flip)"

# ── Script: --check drift gate ────────────────────────────────────────────────
if bash scripts/ci/reconcile-node-dns.sh candidate-a --check >/dev/null 2>&1; then
  printf 'OK   --check passes when all node records present\n'; pass=$((pass + 1))
else
  printf 'FAIL --check should pass when all present\n'; fail=$((fail + 1))
fi

# Drop one node record → --check must fail.
printf '{"records":[],"next_id":1}' >"$CF_STORE"
cf_upsert_a_record test-token zone123 test.cognidao.org "$VM_IP_FIXTURE" true >/dev/null
if bash scripts/ci/reconcile-node-dns.sh candidate-a --check >/dev/null 2>&1; then
  printf 'FAIL --check should fail when node records missing\n'; fail=$((fail + 1))
else
  printf 'OK   --check fails (non-zero) when node records missing\n'; pass=$((pass + 1))
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "PASS: reconcile-node-dns.test.sh"
