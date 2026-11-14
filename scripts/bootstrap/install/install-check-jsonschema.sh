#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/bootstrap/install/install-check-jsonschema.sh
# Purpose: Install check-jsonschema CLI for catalog schema validation (CATALOG_IS_SSOT, https://cognidao.org/knowledge/operator-pipeline-contract axiom 16).
# Status: OPT-IN. Not wired into setup.sh. Only catalog editors need it locally.
#         CI is the authoritative validator (pipx install + run inside pr-build.yml).
# Usage: bash scripts/bootstrap/install/install-check-jsonschema.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if command -v check-jsonschema >/dev/null 2>&1; then
    log_info "check-jsonschema is already installed ($(command -v check-jsonschema))"
    check-jsonschema --version
    exit 0
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! command -v brew >/dev/null 2>&1; then
        log_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
        exit 1
    fi
    log_info "Installing check-jsonschema via Homebrew..."
    brew install check-jsonschema

elif [[ -f /etc/debian_version ]] || [[ -f /etc/alpine-release ]]; then
    if ! command -v pipx >/dev/null 2>&1; then
        log_info "pipx not found, installing via apt/apk..."
        if [[ -f /etc/debian_version ]]; then
            sudo apt-get update -qq && sudo apt-get install -y -qq pipx
        else
            apk add --no-cache pipx
        fi
        pipx ensurepath || true
    fi
    log_info "Installing check-jsonschema via pipx..."
    pipx install check-jsonschema

else
    log_error "Unsupported OS. Install check-jsonschema manually: https://github.com/python-jsonschema/check-jsonschema"
    exit 1
fi

if command -v check-jsonschema >/dev/null 2>&1; then
    check-jsonschema --version
    log_info "check-jsonschema installation complete!"
else
    log_error "check-jsonschema installation failed — not found in PATH after install."
    exit 1
fi
