#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Preserve the selected production-worker candidate subsection across image copies.

Invoked only by the existing shared-platform manifest guard, before its atomic commit.
HEAD is the deploy checkout before rsync. Protected main is fetched once and pinned;
it is an allowlist, never an instruction to add aliases. No cluster or remote write.
"""
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse

FIELD = "TEMPORAL_CUSTODIED_NODE_ENDPOINTS"
NS = "cogni-candidate-a"
PATH = "infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml"
TOKEN = r'"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"'


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def patch(text):
    if len(text.encode()) > 128000 or "\r" in text:
        raise ValueError("noncanonical worker patch")
    doc = json.loads(subprocess.check_output(["yq", "-o=json", "."], input=text, text=True), object_pairs_hook=unique)
    if set(doc) != {"apiVersion", "kind", "metadata", "data"} or set(doc.get("metadata", {})) != {"name"} or not isinstance(doc.get("data"), dict) or any(not isinstance(value, str) for value in doc["data"].values()):
        raise ValueError("unexpected worker config shape")
    if doc.get("apiVersion") != "v1" or doc.get("kind") != "ConfigMap" or doc.get("metadata", {}).get("name") != "scheduler-worker-config":
        raise ValueError("unexpected worker config identity")
    lines = list(re.finditer(r"^  TEMPORAL_CUSTODIED_NODE_ENDPOINTS: (.*)$", text, re.M))
    if len(lines) != 1 or not (lines[0][1] == '"{}"' or re.fullmatch(r"'(?:[^']|'')*'", lines[0][1])):
        raise ValueError("expected generated quoted custody field")
    raw = "{}" if lines[0][1] == '"{}"' else lines[0][1][1:-1].replace("''", "'")
    if doc["data"][FIELD] != raw:
        raise ValueError("ambiguous worker custody field")
    values = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(values, dict) or any(not isinstance(k, str) or not re.fullmatch(r"cogni-[a-z][a-z0-9-]*", k) or not isinstance(v, str) for k, v in values.items()):
        raise ValueError("invalid custody namespaces")
    members = list(re.finditer(f"({TOKEN})\\s*:\\s*({TOKEN})", raw))
    if len(members) != len(values):
        raise ValueError("invalid namespace map")
    return raw, values, lines[0], next((m for m in members if json.loads(m[1]) == NS), None)


def aliases(csv):
    parts = csv.split(",") if csv else []
    if len(parts) > 1024 or len(parts) % 2:
        raise ValueError("unpaired aliases")
    result = {}
    for index, entry in enumerate(parts):
        key, sep, value = entry.partition("=")
        url = urllib.parse.urlsplit(value)
        if not sep or key in result or url.scheme != "https" or url.username or url.password or url.port or url.path or url.query or url.fragment or value != "https://" + url.hostname:
            raise ValueError("noncanonical or duplicate candidate alias")
        pattern = r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*" if index % 2 == 0 else r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        if not re.fullmatch(pattern, key) or (index % 2 and value != parts[index - 1].partition("=")[2]):
            raise ValueError("invalid slug/UUID pair")
        result[key] = value
    return result


def preserve(current, authority, copied):
    selected = patch(current)[1].get(NS)
    retained = aliases(selected or "")
    allowed = aliases(patch(authority)[1].get(NS, ""))
    if any(allowed.get(key) != value for key, value in retained.items()):
        raise ValueError("selected candidate alias conflicts with protected main")
    raw, values, line, member = patch(copied)
    if values.get(NS) == selected:
        return copied
    if member:
        if selected is None:
            begin, end = member.span()
            following = re.match(r"\s*,", raw[end:])
            preceding = re.search(r",\s*$", raw[:begin])
            if following:
                end += following.end()
            elif preceding:
                begin = preceding.start()
            raw = raw[:begin] + raw[end:]
        else:
            begin, end = member.span(2)
            raw = raw[:begin] + json.dumps(selected) + raw[end:]
    elif selected is not None:
        at = raw.rindex("}")
        raw = raw[:at] + ("," if values else "") + json.dumps(NS) + ":" + json.dumps(selected) + raw[at:]
    result = copied[:line.start()] + "  " + FIELD + ": '" + raw.replace("'", "''") + "'" + copied[line.end():]
    if patch(result)[1].get(NS) != selected:
        raise ValueError("selection preservation failed")
    return result


def main():
    platform, deploy = sys.argv[1:]
    subprocess.run(["git", "-C", platform, "fetch", "--no-tags", "--depth=1", "origin", "main"], check=True)
    pinned = subprocess.check_output(["git", "-C", platform, "rev-parse", "FETCH_HEAD"], text=True).strip()
    authority = subprocess.check_output(["git", "-C", platform, "show", pinned + ":" + PATH]).decode("utf8")
    current = subprocess.check_output(["git", "-C", deploy, "show", "HEAD:" + PATH]).decode("utf8")
    target = pathlib.Path(deploy) / PATH
    result = preserve(current, authority, target.read_bytes().decode("utf8"))
    target.write_bytes(result.encode("utf8"))
    print("Preserved current worker candidate selection; protected authority " + pinned)


if __name__ == "__main__":
    main()
