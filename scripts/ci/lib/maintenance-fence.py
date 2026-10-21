#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Read-only per-node deploy fence. This phase cannot create or clear markers."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

MARKER = ".promote-state/maintenance-drain.json"
RECEIPT = ".promote-state/maintenance-drain-receipt.json"


def read_present(root, relative):
    path = Path(root) / relative
    if not os.path.lexists(path):
        return None
    if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
        raise RuntimeError("maintenance_guard_file_unproven")
    if path.stat().st_size > 65536:
        raise RuntimeError("maintenance_guard_file_unproven")
    try:
        value = json.loads(path.read_text())
    except (ValueError, OSError):
        raise RuntimeError("maintenance_guard_json_invalid") from None
    # A PRESENT JSON null is never an absent marker.
    if not isinstance(value, dict) or not value:
        raise RuntimeError("maintenance_guard_shape_invalid")
    return value


def compare_source(repository, base, head):
    value = subprocess.check_output(
        ["gh", "api", f"repos/{repository}/compare/{base}...{head}", "--jq", ".status"],
        text=True, stderr=subprocess.PIPE, timeout=30,
        env={**os.environ, "GH_TOKEN": os.environ.get("SOURCE_READ_TOKEN") or os.environ.get("GH_TOKEN", "")},
    ).strip()
    if value not in ("ahead", "behind", "identical", "diverged"):
        raise RuntimeError("maintenance_floor_comparison_unknown")
    return value


def check(root, repository=None, source_sha=None, compare=None):
    marker = read_present(root, MARKER)
    if marker is not None:
        # No operation ID, audited phase or rollback setting bypasses this first
        # guard-only delivery. Activation requires a later reviewed executor.
        raise RuntimeError("maintenance_drain_active")
    receipt = read_present(root, RECEIPT)
    if receipt is None:
        return
    request = receipt.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("maintenance_compatibility_floor_invalid")
    floor_repository = request.get("sourceRepository")
    floor_sha = request.get("sourceSha")
    if (receipt.get("version") != 1 or receipt.get("phase") != "audited"
            or not re.fullmatch(r"[a-f0-9]{64}", receipt.get("operationId", ""))
            or not isinstance(floor_repository, str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", floor_repository)
            or repository != floor_repository
            or not isinstance(floor_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", floor_sha)
            or not isinstance(source_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", source_sha)):
        raise RuntimeError("maintenance_compatibility_floor_invalid")
    compare = compare or compare_source
    # Squash merge breaks PR-head ancestry. A durable floor must first be
    # reachable from the owning repository's actual main, never a premerge head.
    if compare(repository, floor_sha, "main") not in ("ahead", "identical"):
        raise RuntimeError("maintenance_floor_not_on_main")
    if source_sha != floor_sha and compare(repository, floor_sha, source_sha) != "ahead":
        raise RuntimeError("maintenance_compatibility_floor_violation")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "check":
            raise RuntimeError("maintenance_guard_check_only")
        check(sys.argv[2], os.environ.get("SOURCE_REPOSITORY"), os.environ.get("SOURCE_SHA"))
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r"maintenance_[a-z0-9_]+", message) else "maintenance_guard_unavailable", file=sys.stderr)
        sys.exit(1)
