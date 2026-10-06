#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
set -euo pipefail
exec node "${OPERATOR_CHANGE_REPLAY_BUNDLE:?trusted replay bundle is required}"
