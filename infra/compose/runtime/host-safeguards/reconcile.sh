#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
K3S_CONFIG_CHANGED=false

for source_and_target in \
  "90-cogni-kine.yaml:/etc/rancher/k3s/config.yaml.d/90-cogni-kine.yaml:0644" \
  "k3s-kine-compact.sh:/usr/local/sbin/k3s-kine-compact.sh:0755" \
  "k3s-kine-compact.service:/etc/systemd/system/k3s-kine-compact.service:0644" \
  "k3s-kine-compact.timer:/etc/systemd/system/k3s-kine-compact.timer:0644" \
  "k3s-kine-metrics.sh:/usr/local/sbin/k3s-kine-metrics.sh:0755" \
  "k3s-kine-metrics.service:/etc/systemd/system/k3s-kine-metrics.service:0644" \
  "k3s-kine-metrics.timer:/etc/systemd/system/k3s-kine-metrics.timer:0644"
do
  IFS=: read -r source target mode <<<"$source_and_target"
  [ -f "$SOURCE_DIR/$source" ] || { echo "host safeguard asset missing: $source" >&2; exit 1; }
  install -D -o root -g root -m "$mode" "$SOURCE_DIR/$source" "$target.new"
  if ! cmp -s "$target.new" "$target"; then
    mv -f "$target.new" "$target"
    [ "$source" = "90-cogni-kine.yaml" ] && K3S_CONFIG_CHANGED=true
  else
    rm -f "$target.new"
  fi
done
unset source_and_target source target mode

if ! command -v sqlite3 >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3
fi

systemctl daemon-reload
systemctl enable --now k3s-kine-compact.timer k3s-kine-metrics.timer
systemctl start k3s-kine-metrics.service

if [ "$K3S_CONFIG_CHANGED" = true ]; then
  echo "host-safeguards: k3s config changed; restarting k3s once"
  systemctl restart k3s
  systemctl is-active --quiet k3s || { echo "host-safeguards: k3s failed after convergence" >&2; exit 1; }
else
  echo "host-safeguards: k3s config already converged; restart skipped"
fi
