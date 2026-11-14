#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/bootstrap/install/install-yq.sh
# Purpose: Install yq (mikefarah Go-based v4) for catalog reads (CATALOG_IS_SSOT, https://cognidao.org/knowledge/operator-pipeline-contract axiom 16).
# Usage: bash scripts/bootstrap/install/install-yq.sh
# Note: Pre-installed on ubuntu-24.04 GHA runners. This script is for local dev parity.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if command -v yq >/dev/null 2>&1; then
    if yq --version 2>&1 | grep -qE 'mikefarah|v4\.'; then
        log_info "yq is already installed ($(command -v yq))"
        yq --version
        exit 0
    fi
    log_error "yq is installed but is not the mikefarah/yq v4 variant required by Cogni CI. Found: $(yq --version 2>&1)"
    log_error "Likely Python yq (jq wrapper). Uninstall it and re-run this script, or install mikefarah/yq manually: https://github.com/mikefarah/yq"
    exit 1
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! command -v brew >/dev/null 2>&1; then
        log_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
        exit 1
    fi
    log_info "Installing yq via Homebrew..."
    brew install yq

elif [[ -f /etc/debian_version ]]; then
    log_info "Installing yq via mikefarah/yq GitHub release (apt's yq is the wrong variant)..."
    YQ_VERSION="${YQ_VERSION:-v4.52.5}"
    case "$(uname -m)" in
        x86_64)  YQ_BINARY="yq_linux_amd64" ;;
        aarch64 | arm64) YQ_BINARY="yq_linux_arm64" ;;
        *)
            log_error "Unsupported architecture: $(uname -m). Install mikefarah/yq manually: https://github.com/mikefarah/yq#install"
            exit 1
            ;;
    esac
    sudo curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/${YQ_BINARY}" -o /usr/local/bin/yq
    sudo chmod +x /usr/local/bin/yq

elif [[ -f /etc/alpine-release ]]; then
    log_info "Installing yq via apk..."
    apk add --no-cache yq

else
    log_error "Unsupported OS. Install yq manually: https://github.com/mikefarah/yq#install"
    exit 1
fi

if command -v yq >/dev/null 2>&1; then
    yq --version
    log_info "yq installation complete!"
else
    log_error "yq installation failed — yq not found in PATH after install."
    exit 1
fi
