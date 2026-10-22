#!/usr/bin/env python3
"""Read-only native identity guard for finite, restart-free substrate maintenance.

This guard never invokes a lifecycle command and never prints Compose/inspect
payloads (which contain secrets). The caller must ALSO skip native lifecycle
commands and use --no-deps for one-off provisioners. A snapshot is not authority
to start, recreate or restart an engine.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


class Refused(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Refused(code)


def read(*command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        raise Refused("native_preservation_read_unavailable") from None
    need(result.returncode == 0, "native_preservation_read_unavailable")
    return result.stdout


def capture(compose, runtime, files=(), services=("postgres", "doltgres")):
    runtime = Path(runtime)
    need(runtime.is_dir(), "native_preservation_runtime_missing")
    config = ["docker", "compose", "--project-name", "cogni-runtime",
              "--project-directory", str(runtime), "--env-file", str(runtime / ".env"),
              "-f", str(compose), "--profile", "*"]
    compose_version = read("docker", "compose", "version", "--short").strip()
    need(bool(re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", compose_version)),
         "native_preservation_compose_unproven")
    # Check installed native-mounted executable bytes before any shared writes.
    file_hashes = {}
    for pair in files:
        installed, staged = pair.split("=", 1)
        before, desired = Path(installed), Path(staged)
        need(before.is_file() and desired.is_file() and not before.is_symlink()
             and not desired.is_symlink(), "native_preservation_file_unproven")
        digest = hashlib.sha256(before.read_bytes()).hexdigest()
        need(digest == hashlib.sha256(desired.read_bytes()).hexdigest(),
             "native_preservation_file_drift")
        file_hashes[installed] = digest
    need(bool(services) and len(set(services)) == len(services)
         and set(services) <= {"postgres", "doltgres"}, "native_preservation_scope_unproven")
    rendered = json.loads(read(*config, "config", "--format", "json"))
    engines = {}
    for service in services:
        lines = read(*config, "config", "--hash", service).splitlines()
        need(len(lines) == 1, "native_preservation_config_unproven")
        fields = lines[0].split()
        need(len(fields) == 2 and fields[0] == service
             and re.fullmatch(r"[a-f0-9]{64}", fields[1]),
             "native_preservation_config_unproven")
        ids = read("docker", "ps", "-aq", "--no-trunc", "--filter",
                   "label=com.docker.compose.project=cogni-runtime", "--filter",
                   "label=com.docker.compose.service=" + service).split()
        need(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{64}", ids[0]),
             "native_preservation_engine_ambiguous")
        payload = json.loads(read("docker", "inspect", ids[0]))
        need(isinstance(payload, list) and len(payload) == 1,
             "native_preservation_engine_unproven")
        engine = payload[0]
        labels = engine.get("Config", {}).get("Labels", {})
        state = engine.get("State", {})
        desired = rendered.get("services", {}).get(service, {})
        desired_image = desired.get("image")
        need(isinstance(desired_image, str) and desired_image,
             "native_preservation_config_unproven")
        image_payload = json.loads(read("docker", "image", "inspect", desired_image))
        need(isinstance(image_payload, list) and len(image_payload) == 1
             and image_payload[0].get("Id") == engine.get("Image"),
             "native_preservation_image_drift")
        environment = {}
        for value in engine.get("Config", {}).get("Env", []):
            key, separator, item = value.partition("=")
            need(separator and key not in environment,
                 "native_preservation_environment_unproven")
            environment[key] = item
        need(all(environment.get(key) == str(value)
                 for key, value in desired.get("environment", {}).items()),
             "native_preservation_environment_drift")
        need(engine.get("Id") == ids[0] and state.get("Running") is True
             and not state.get("Paused") and not state.get("Restarting")
             and state.get("Health", {}).get("Status") == "healthy"
             and labels.get("com.docker.compose.project") == "cogni-runtime"
             and labels.get("com.docker.compose.service") == service
             and labels.get("com.docker.compose.project.working_dir") == str(runtime)
             and labels.get("com.docker.compose.config-hash") == fields[1]
             and labels.get("com.docker.compose.version") == compose_version.removeprefix("v")
             and engine.get("Config", {}).get("Image") == desired_image
             and isinstance(state.get("StartedAt"), str) and state["StartedAt"]
             and type(engine.get("RestartCount")) is int and engine["RestartCount"] >= 0
             and re.fullmatch(r"sha256:[a-f0-9]{64}", engine.get("Image", "")),
             "native_preservation_engine_drift")
        engines[service] = {"id": ids[0], "image": engine["Image"],
                            "startedAt": state["StartedAt"],
                            "restartCount": engine["RestartCount"],
                            "configHash": fields[1]}
    return {"version": 1, "composeVersion": compose_version, "runtime": str(runtime),
            "engines": engines, "files": file_hashes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("capture", "verify"))
    parser.add_argument("--compose", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--service", action="append", choices=("postgres", "doltgres"))
    args = parser.parse_args()
    actual = capture(args.compose, args.runtime, args.file, args.service or ("postgres", "doltgres"))
    if args.action == "verify":
        expected_bytes = sys.stdin.read(65537)
        need(len(expected_bytes) <= 65536, "native_preservation_snapshot_unproven")
        expected = json.loads(expected_bytes)
        need(actual == expected, "native_preservation_identity_changed")
    print(json.dumps(actual, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("native_preservation_evidence_unavailable", file=sys.stderr)
        sys.exit(1)
