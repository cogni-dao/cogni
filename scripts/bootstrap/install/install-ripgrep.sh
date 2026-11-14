#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/bootstrap/install/install-ripgrep.sh
# Purpose: Install ripgrep (rg) binary. Required by RipgrepAdapter for brain repo search.
# Usage: bash scripts/bootstrap/install/install-ripgrep.sh
# Links: https://node-template.cognidao.org/knowledge/repo-read-tools-contract, src/adapters/server/repo/ripgrep.adapter.ts

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if command -v "$1" >/dev/null 2>&1; then
        log_info "$1 is already installed ($(command -v "$1"))"
        return 0
    else
        return 1
    fi
}

if check_command rg; then
    rg --version
    exit 0
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! command -v brew >/dev/null 2>&1; then
        log_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
        exit 1
    fi
    log_info "Installing ripgrep via Homebrew..."
    brew install ripgrep

elif [[ -f /etc/debian_version ]]; then
    log_info "Installing ripgrep via apt..."
    sudo apt-get update -qq && sudo apt-get install -y -qq ripgrep

elif [[ -f /etc/alpine-release ]]; then
    log_info "Installing ripgrep via apk..."
    apk add --no-cache ripgrep

else
    log_error "Unsupported OS. Install ripgrep manually: https://github.com/BurntSushi/ripgrep#installation"
    exit 1
fi

if check_command rg; then
    rg --version
    log_info "ripgrep installation complete!"
else
    log_error "ripgrep installation failed — rg not found in PATH after install."
    exit 1
fi
