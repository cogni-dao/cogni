#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Exercise the real no-argument projector against the worker's independent mount contract.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
python3 - <<'PY'
import io
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import tempfile
from unittest.mock import patch

projector = Path("scripts/ci/project-database-cell-backup.remote.py").resolve()
contract_root = Path(os.environ.get("DATABASE_CELL_BACKUP_CONTRACT_ROOT", "."))
installer = (contract_root / "infra/compose/runtime/db-backup/install-cell-timer.sh").read_text()
runtime = re.search(r"^runtime=(/[^\n]+)$", installer, re.MULTILINE).group(1)
expected_root = runtime + "/database-cell-backup"
compose = (contract_root / "infra/compose/runtime/docker-compose.yml").read_text()
assert "./database-cell-backup:/database-cell-backup:ro" in compose
reconcile = (contract_root / "scripts/ci/reconcile-node-substrate.sh").read_text()
assert "remote \"python3 '${cell_backup_projector_stage}'\"" in reconcile
node = "11111111-1111-4111-8111-111111111111"
kit = {"version": 1, "nodeId": node, "environment": "production",
       "databaseName": "cogni_neutral", "systemIdentifier": "1234567890123456789",
       "dsn": "postgresql://backup_neutral:" + "a" * 48 + "@provider.example.org:15432/cogni_neutral?sslmode=verify-full",
       "tlsCaCertificate": "-----BEGIN CERTIFICATE-----\nneutral-fixture\n-----END CERTIFICATE-----",
       "encryptionKey": "b" * 64}
with tempfile.TemporaryDirectory() as temporary:
    real_path = Path
    redirected = real_path(temporary) / "runtime-backup"
    requested = []
    def owning_root(value):
        requested.append(str(value))
        assert str(value) == expected_root, "projector default is outside the actual worker/installer mount"
        return redirected
    # Intercept ONLY the chosen filesystem root, keeping actual validation,
    # directory/file creation, atomic replace, contents and permissions intact.
    with patch("pathlib.Path", side_effect=owning_root), patch.object(sys, "argv", [str(projector)]), patch.object(sys, "stdin", io.StringIO(json.dumps([kit]))):
        runpy.run_path(str(projector), run_name="__main__")
    assert requested == [expected_root]
    directory = redirected / node
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    for name in ("pg_service.conf", "ca.crt", "encryption.key", "targets.tsv"):
        assert stat.S_IMODE((directory / name).stat().st_mode) == 0o600
    service = (directory / "pg_service.conf").read_text()
    assert "sslrootcert=/database-cell-backup/" + node + "/ca.crt" in service
    assert "user=backup_neutral\n" in service and "dbname=cogni_neutral\n" in service
    assert (directory / "targets.tsv").read_text().endswith("\t" + kit["systemIdentifier"] + "\n")
    # Existing explicit-root fixture seam keeps its behavior.
    explicit = real_path(temporary) / "explicit"
    with patch.object(sys, "argv", [str(projector), str(explicit)]), patch.object(sys, "stdin", io.StringIO(json.dumps([kit]))):
        runpy.run_path(str(projector), run_name="__main__")
    assert (explicit / node / "pg_service.conf").is_file()
print("PASS actual no-arg backup projector matches worker/installer runtime mount; atomic private files/CA path and explicit-root behavior preserved.")
PY
