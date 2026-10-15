#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Project canonical readonly backup kits. No Bao writes or provider operations."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlparse, parse_qsl, unquote

kits = json.load(sys.stdin)
if not isinstance(kits, list) or not kits:
    raise ValueError("nonempty canonical backup kit required")
groups = {}
for kit in kits:
    if set(kit) != {"version", "nodeId", "environment", "databaseName", "systemIdentifier", "dsn", "tlsCaCertificate", "encryptionKey"}:
        raise ValueError("unknown backup kit field")
    node = kit["nodeId"]
    database = kit["databaseName"]
    if kit["version"] != 1 or kit["environment"] != "production" or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", node) or not re.fullmatch(r"cogni_[a-z0-9_]+", database) or not re.fullmatch(r"[0-9]+", kit["systemIdentifier"]):
        raise ValueError("backup kit scope invalid")
    url = urlparse(kit["dsn"])
    role = "backup_" + database[len("cogni_"):]
    if url.scheme not in ("postgres", "postgresql") or unquote(url.username or "") != role or not re.fullmatch(r"[0-9a-f]{48}", unquote(url.password or "")) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]+", url.hostname or "") or re.fullmatch(r"[0-9.]+", url.hostname or "") or not url.port or unquote(url.path) != "/" + database or parse_qsl(url.query) != [("sslmode", "verify-full")] or url.fragment:
        raise ValueError("backup DSN is outside canonical readonly scope")
    if not kit["tlsCaCertificate"].startswith("-----BEGIN CERTIFICATE-----") or not re.fullmatch(r"[0-9a-f]{64}", kit["encryptionKey"]):
        raise ValueError("backup custody invalid")
    existing = groups.setdefault(node, [])
    if any(value[0]["databaseName"] == database for value in existing):
        raise ValueError("duplicate backup database")
    if existing and (existing[0][0]["tlsCaCertificate"] != kit["tlsCaCertificate"] or existing[0][0]["encryptionKey"] != kit["encryptionKey"]):
        raise ValueError("backup custody differs within one cell")
    existing.append((kit, url, role))

root = Path(sys.argv[1] if len(sys.argv) == 2 else "/opt/cogni/database-cell-backup")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
for node, entries in groups.items():
    directory = root / node
    if directory.is_symlink():
        raise ValueError("backup directory must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    services, targets = [], []
    for kit, url, role in entries:
        services.append(f"[{role}]\nhost={url.hostname}\nport={url.port}\ndbname={kit['databaseName']}\nuser={role}\npassword={unquote(url.password)}\nsslmode=verify-full\nsslrootcert=/database-cell-backup/{node}/ca.crt\nconnect_timeout=5\n")
        targets.append("\t".join((role, kit["databaseName"], kit["environment"], node, kit["systemIdentifier"])))
    values = {"pg_service.conf": "\n".join(services), "ca.crt": entries[0][0]["tlsCaCertificate"] + "\n", "encryption.key": entries[0][0]["encryptionKey"] + "\n", "targets.tsv": "\n".join(targets) + "\n"}
    for name, content in values.items():
        fd, temporary = tempfile.mkstemp(prefix=".projection-", dir=directory)
        try:
            with os.fdopen(fd, "w") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, directory / name)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
