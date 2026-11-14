#!/bin/bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# UI Token Enforcement Checks
# Purpose: Ban raw typography utilities and arbitrary values without var(--token)
# Runs: Part of pnpm check (see scripts/check-all.sh)
# Scope: src/** excluding styles/kit/vendor directories
# Links: https://node-template.cognidao.org/knowledge/frontend-development Phase 2

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo "🔍 Checking UI token compliance..."

# (a) Ban raw typography utilities outside allowed dirs
echo "  → Checking for raw text-* utilities..."
if rg "text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)" \
  --type tsx \
  --glob '!src/styles/**' \
  --glob '!src/components/kit/**' \
  --glob '!src/components/vendor/**' \
  --glob '!tests/**' \
  --glob '!e2e/**' \
  -c 2>/dev/null | grep -q .; then
  echo -e "${RED}✗ ERROR: Raw text-* utilities found outside styles/kit/vendor${NC}"
  echo "Files with violations:"
  rg "text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)" \
    --type tsx \
    --glob '!src/styles/**' \
    --glob '!src/components/kit/**' \
    --glob '!src/components/vendor/**' \
    --glob '!tests/**' \
    --glob '!e2e/**' \
    --files-with-matches
  echo ""
  echo "Fix: Use text-[var(--text-sm)] or similar token references"
  echo "See: https://node-template.cognidao.org/knowledge/frontend-development"
  exit 1
fi

# (b) Ban arbitrary values without var(--token)
echo "  → Checking for arbitrary values without var(--token)..."
# Match brackets with magic numbers/hex values (px, rem, %, hex colors)
# Exclude var(--token) pattern and test files
if rg '\[[0-9]+px\]|\[[0-9]+rem\]|\[[0-9]+%\]|\[#[0-9a-fA-F]+\]' \
  --type tsx \
  --glob '!src/styles/**' \
  --glob '!src/components/kit/**' \
  --glob '!src/components/vendor/**' \
  --glob '!tests/**' \
  --glob '!e2e/**' \
  -c 2>/dev/null | grep -q .; then
  echo -e "${RED}✗ ERROR: Arbitrary values without var(--token) found${NC}"
  echo "Files with violations:"
  rg '\[[0-9]+px\]|\[[0-9]+rem\]|\[[0-9]+%\]|\[#[0-9a-fA-F]+\]' \
    --type tsx \
    --glob '!src/styles/**' \
    --glob '!src/components/kit/**' \
    --glob '!src/components/vendor/**' \
    --glob '!tests/**' \
    --glob '!e2e/**' \
    --files-with-matches
  echo ""
  echo "Fix: Use [var(--token-name)] instead of magic numbers/hex values"
  echo "See: https://node-template.cognidao.org/knowledge/frontend-development"
  exit 1
fi

echo -e "${GREEN}✓ UI token checks passed${NC}"
