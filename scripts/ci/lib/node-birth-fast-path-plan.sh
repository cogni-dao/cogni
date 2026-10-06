#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Trusted parent footprint for cogni.node-birth.v1.
#
# CONSERVATIVE_BOOTSTRAP: empty is deliberate. The classifier must not grant
# the shortcut until the data-only writer AND every downstream projection
# consumer have landed and been proven together. The enabling change replaces
# this empty plan with exact node-scoped paths and matching replay tests.

node_birth_fast_path_paths() {
  : "$1"
}
