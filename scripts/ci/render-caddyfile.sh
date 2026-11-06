#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# render-caddyfile.sh — emit the edge Caddyfile from the catalog (CATALOG_IS_SSOT).
#
# task.5078 — the edge reverse-proxy roster used to be hand-maintained: one
# static site block per node in Caddyfile.tmpl + matching per-node *_DOMAIN /
# *_UPSTREAM vars in deploy-infra.sh and docker-compose.yml. Adding a node (and
# canary proved it) meant editing 3 files in 5+ spots, and the node silently had
# no edge route until someone did. This generator loops NODE_TARGETS instead, so
# a new `type: node` catalog entry (with node_port) yields its edge block for
# free — adding a node is a one-PR, catalog-only change.
#
# Default output is the committed infra/compose/edge/configs/Caddyfile.tmpl,
# with env placeholders for local/cold-start Compose. `--domain` materializes
# those values from the same catalog helpers for atomic reload of a running
# Caddy; no fresh container environment is then required (bug.5133).
#
# task.5428 — `--domain` also renders the env VM's mesh-plane sites from the one tailnet table
# (scripts/ci/lib/mesh-plane.sh), for every tailnet whose relay + substrate-gw run on this VM: one relay
# site per tailnet (`derp-<tailnet>.<zone>`, in that tailnet's own DNS zone -> its derper NodePort) and one enrollment
# publish path per tailnet on the VM's DNS-only alias (`/.well-known/cogni-mesh/<tailnet>/...`). These
# hosts are DNS-only, so each site overrides the global `local_certs` with a publicly trusted ACME
# issuer; every proxied host keeps `local_certs`. This script is the VM's ONE Caddyfile writer, and it
# fails if any of this VM's tailnets lacks its relay site or its publish path. The env is the one whose
# operator domain equals `--domain` (cogni_operator_domain_for_env), or `--env` when given.
#
# Usage: render-caddyfile.sh            # write canonical template to stdout
#        render-caddyfile.sh --check    # diff stdout against the committed file
#        render-caddyfile.sh --domain <base-domain> [--env <env>]  # concrete runtime config
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"
# shellcheck source=scripts/ci/lib/mesh-plane.sh
source "${SCRIPT_DIR}/lib/mesh-plane.sh"
# shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
source "${SCRIPT_DIR}/../setup/lib/cogni-deployment-identity.sh"

CADDYFILE_PATH="${SCRIPT_DIR}/../../infra/compose/edge/configs/Caddyfile.tmpl"

slug_for_node() { echo "$1" | tr '[:lower:]-' '[:upper:]_'; }

is_valid_domain() {
  local domain="$1" label
  local -a labels=()

  [[ -n "$domain" && "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || return 1
  [[ "$domain" != .* && "$domain" != *. && "$domain" != *..* ]] || return 1

  IFS='.' read -r -a labels <<< "$domain"
  for label in "${labels[@]}"; do
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
  done
}

# Emit a reverse-proxy site block. Access logs go to container stdout so the
# existing Alloy Docker source actually ships them. Writing into Caddy's named
# /data volume made the edge opaque: Alloy discovers the container, not files
# hidden inside another Compose project's volume (bug.5132).
emit_site_block() {
  local host="$1" upstream="$2"
  cat <<BLOCK
${host} {
  encode zstd gzip

  @public path /api/v1/public/*
  handle @public {
    reverse_proxy ${upstream} {
      header_up X-Real-IP {remote_host}
      transport http {
        response_header_timeout 10s
      }
    }
  }

  reverse_proxy ${upstream}

  log {
    format json
    output stdout
  }
}
BLOCK
}

# A DNS-only mesh relay site: public ACME certificate, only DERP paths reach the tailnet's derper.
emit_mesh_relay_site() {
  local host="$1" upstream="$2"
  cat <<BLOCK
${host} {
  tls {
    issuer acme
  }

  @mesh path /derp /derp/* /generate_204
  handle @mesh {
    reverse_proxy ${upstream}
  }

  handle {
    respond 404
  }

  log {
    format json
    output stdout
  }
}
BLOCK
}

# The VM alias site: one enrollment publish path per tailnet, nothing else.
#   emit_mesh_publish_site <vm-host> <tailnet>=<nodeport>...
emit_mesh_publish_site() {
  local host="$1" pair tailnet port
  shift
  printf '%s {\n  tls {\n    issuer acme\n  }\n' "$host"
  for pair in "$@"; do
    tailnet="${pair%%=*}"
    port="${pair#*=}"
    cat <<BLOCK

  handle /.well-known/cogni-mesh/${tailnet}/substrate-gw.json {
    rewrite * /substrate-gw.json
    reverse_proxy host.docker.internal:${port}
  }
BLOCK
  done
  cat <<'BLOCK'

  handle {
    respond 404
  }

  log {
    format json
    output stdout
  }
}
BLOCK
}

# The env whose operator domain is DOMAIN under the deployment root, or empty (a fork/local domain).
env_for_domain() {
  local domain="$1" root candidate
  root="${FORK_DOMAIN_ROOT:-$(cogni_domain_root)}"
  for candidate in production preview candidate-a; do
    if [[ "$(cogni_operator_domain_for_env "$candidate" "$root" 2>/dev/null)" == "$domain" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
}

# task.5428 — the env VM's mesh sites (see header). Nothing is emitted for a VM with no tailnet.
emit_mesh_vm_sites() {
  local env="$1" root slug tailnet pairs=() out
  root="${FORK_DOMAIN_ROOT:-$(cogni_domain_root)}"
  slug="$(cogni_deployment_slug)"
  while read -r tailnet; do
    [ -n "$tailnet" ] || continue
    echo
    echo "# ── mesh relay ${tailnet} (DNS-only, public ACME) → k3s NodePort $(mesh_tailnet_field "$tailnet" relay_np) ──"
    emit_mesh_relay_site "$(mesh_host "$tailnet" relay)" \
      "host.docker.internal:$(mesh_tailnet_field "$tailnet" relay_np)"
    pairs+=("${tailnet}=$(mesh_tailnet_field "$tailnet" publish_np)")
  done < <(mesh_vm_tailnets "$env")
  [ "${#pairs[@]}" -gt 0 ] || return 0
  echo
  echo "# ── mesh enrollment publish, one path per tailnet (DNS-only VM alias, public ACME) ──"
  emit_mesh_publish_site "$(cogni_vm_host_for_env "$env" "$root" "$slug")" "${pairs[@]}"
}

# Fail when any tailnet of ENV's VM lacks its relay site or its publish path (one writer, all routes).
assert_mesh_vm_sites() {
  local env="$1" rendered="$2" tailnet
  while read -r tailnet; do
    [ -n "$tailnet" ] || continue
    grep -Fqx "$(mesh_host "$tailnet" relay) {" <<<"$rendered" \
      || { echo "[ERROR] render-caddyfile: relay site for tailnet '$tailnet' missing" >&2; return 1; }
    grep -Fq "handle /.well-known/cogni-mesh/${tailnet}/substrate-gw.json {" <<<"$rendered" \
      || { echo "[ERROR] render-caddyfile: publish path for tailnet '$tailnet' missing" >&2; return 1; }
  done < <(mesh_vm_tailnets "$env")
}

render() {
  local domain="${1:-}" env="${2:-}"
  cat <<'HEADER'
# GENERATED by scripts/ci/render-caddyfile.sh from infra/catalog/*.yaml —
# DO NOT EDIT BY HAND. Add a node = add its catalog entry (with node_port) and
# run `pnpm gen:caddyfile`. CI (`scripts/ci/render-caddyfile.sh --check`) fails
# if this file drifts from the catalog. See docs/guides/node-formation-guide.md.
{
  # Cloudflare terminates public TLS and connects to this origin in Full mode.
  # Keep origin certificates local: public ACME challenges cannot reliably reach
  # a proxied origin and leave the edge serving 525 after a Caddy recreate.
  local_certs

  log {
    level INFO
    format json
    output stdout
  }
}

HEADER

  echo "# Redirect www to non-www (canonical operator domain)"
  if [[ -n "$domain" ]]; then
    printf 'www.%s {\n  redir https://%s{uri} permanent\n}\n' "$domain" "$domain"
  else
    printf 'www.{$DOMAIN} {\n  redir https://{$DOMAIN}{uri} permanent\n}\n'
  fi

  # Primary (operator) first — serves the bare ${DOMAIN}; upstream default
  # stays the docker-DNS `app:3000` for local stacks, overridden to the k3s
  # NodePort by deploy-infra.sh on the VM.
  local node slug port
  for node in "${NODE_TARGETS[@]}"; do
    if is_primary_host "$node"; then
      slug="$(slug_for_node "$node")"
      port="$(node_port_for_target "$node")"
      echo
      echo "# ── ${node} (primary domain) → k3s NodePort ${port} ──────────────────────"
      if [[ -n "$domain" ]]; then
        emit_site_block "$domain" "host.docker.internal:${port}"
      else
        emit_site_block '{$DOMAIN}' "{\$${slug}_UPSTREAM:app:3000}"
      fi
    fi
  done

  # Non-primary nodes, deterministic order. Host is env-substituted
  # ({$<SLUG>_DOMAIN}, written to the edge .env per env); upstream port is baked
  # from catalog node_port (env-invariant). A `.localhost` host default keeps
  # the local docker stack's Caddy loadable when the var is unset.
  for node in $(printf '%s\n' "${NODE_TARGETS[@]}" | sort); do
    is_primary_host "$node" && continue
    slug="$(slug_for_node "$node")"
    port="$(node_port_for_target "$node")"
    echo
    echo "# ── ${node} node → k3s NodePort ${port} ──────────────────────────────────"
    if [[ -n "$domain" ]]; then
      emit_site_block "$(host_for_node "$node" "$domain")" "host.docker.internal:${port}"
    else
      emit_site_block \
        "{\$${slug}_DOMAIN:${node}.localhost}" \
        "{\$${slug}_UPSTREAM:host.docker.internal:${port}}"
    fi
  done

  if [[ -n "$env" ]]; then
    local mesh
    mesh="$(emit_mesh_vm_sites "$env")"
    assert_mesh_vm_sites "$env" "$mesh"
    [ -z "$mesh" ] || printf '%s\n' "$mesh"
  fi
}

case "${1:-}" in
  "") render ;;
  --check)
    [[ $# -eq 1 ]] || { echo "[ERROR] --check accepts no additional arguments" >&2; exit 2; }
    if ! diff -u "$CADDYFILE_PATH" <(render); then
      echo "[ERROR] ${CADDYFILE_PATH} is out of sync with infra/catalog/*.yaml." >&2
      echo "        Run: pnpm gen:caddyfile" >&2
      exit 1
    fi
    echo "Caddyfile.tmpl is in sync with the catalog."
    ;;
  --domain)
    if { [[ $# -ne 2 ]] && [[ $# -ne 4 || "${3:-}" != "--env" ]]; } || ! is_valid_domain "${2:-}"; then
      echo "[ERROR] --domain requires one DNS base domain, optionally followed by --env <env> (got: '${2:-<missing>}')" >&2
      exit 2
    fi
    if [[ $# -eq 4 ]]; then
      case "$4" in
        candidate-a | preview | production | candidate-*) ;;
        *) echo "[ERROR] --env must be candidate-a, candidate-*, preview or production (got: '$4')" >&2; exit 2 ;;
      esac
    fi
    render "$2" "${4:-$(env_for_domain "$2")}"
    ;;
  *) echo "[ERROR] unknown argument: $1" >&2; exit 2 ;;
esac
