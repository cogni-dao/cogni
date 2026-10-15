#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Sign a cell's server leaf for its observed provider TCP hostname/IP.
# Scope: Sole materializer endpoint phase; private input files and public output chain.
# Invariants: The per-cell CA key never reaches the provider; no secret values in argv/logs.
set -euo pipefail
umask 077

[[ "$#" == 5 ]] || { echo 'expected CA certificate, CA key, server key, observed host, output chain paths' >&2; exit 2; }
ca_certificate="$1" ca_key="$2" server_key="$3" observed_host="$4" output_chain="$5"
[[ "$observed_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$ ]] || exit 2
for private_input in "$ca_certificate" "$ca_key" "$server_key"; do
  [[ -s "$private_input" ]] || exit 2
done
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
if [[ "$observed_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$observed_host" == *:* ]]; then
  alternative="IP:$observed_host"
else
  alternative="DNS:$observed_host"
fi
cat > "$temporary/leaf.extensions" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$alternative
EOF
openssl req -new -sha256 -key "$server_key" -subj "/CN=$observed_host" \
  -out "$temporary/leaf.csr" >/dev/null 2>&1
# Random serial avoids a second issuer-state ledger. The existing private CA is
# set-once by the sole writer; this operation only signs the observed endpoint.
serial="$(openssl rand -hex 16)"
openssl x509 -req -sha256 -days 90 -in "$temporary/leaf.csr" \
  -CA "$ca_certificate" -CAkey "$ca_key" -set_serial "0x$serial" \
  -extfile "$temporary/leaf.extensions" -out "$temporary/leaf.crt" >/dev/null 2>&1
openssl verify -purpose sslserver -CAfile "$ca_certificate" "$temporary/leaf.crt" >/dev/null
cat "$temporary/leaf.crt" "$ca_certificate" > "$output_chain"
