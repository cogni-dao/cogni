#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Purpose: Exercise control/workload DNS separation through the catalog and real edge renderer.
# Scope: Owned temporary rendered files. Does not contact DNS, Docker or deployed services.
set -euo pipefail
cd "$(dirname "$0")/../../.."
. scripts/ci/lib/image-tags.sh
fail() { echo "FAIL: $*" >&2; exit 1; }
[ "$(k3s_workload_domain test.cognidao.org cogni-testing.org cognidao.org)" = test.cogni-testing.org ] || fail split
[ "$(k3s_workload_domain test.cognidao.org test.cognidao.org cognidao.org)" = test.cognidao.org ] || fail canonical
[ "$(k3s_workload_domain preview.example.org example.net example.org)" = preview.example.net ] || fail preview
for invalid in 'https://bad.example' 'bad..example' 'bad.example/escape' '-bad.example'; do
  if k3s_workload_domain test.cognidao.org "$invalid" cognidao.org >/dev/null 2>&1; then fail invalid; fi
done
if k3s_workload_domain test.cognidao.org.evil.example cogni-testing.org cognidao.org >/dev/null 2>&1; then fail suffix; fi
normal=$(bash scripts/ci/render-caddyfile.sh --domain test.cognidao.org)
split=$(bash scripts/ci/render-caddyfile.sh --domain test.cognidao.org --workload-domain test.cogni-testing.org)
# Operator and www blocks are complete independent site blocks preceding child sites.
primary() { awk '/# ── .* node →/{exit} {print}' <<< "$1"; }
[ "$(primary "$normal")" = "$(primary "$split")" ] || fail 'operator/WWW bytes changed'
grep -Fq 'node-template-test.cogni-testing.org {' <<< "$split" || fail 'isolated k3s host missing'
grep -Fq 'reverse_proxy host.docker.internal:30200' <<< "$split" || fail 'declared NodePort changed'
[ "$(host_for_node node-template cogni-testing.org)" = node-template.cogni-testing.org ] || fail 'Akash convention changed'
echo 'PASS: isolated workload domain retains operator/WWW and native host conventions'

pnpm exec tsx --test scripts/lib/tests/k3s-dns.test.mjs
