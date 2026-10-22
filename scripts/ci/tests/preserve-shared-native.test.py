#!/usr/bin/env python3
"""Hermetic transport/guard tests; never contact Docker or a native database."""
import base64
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "preservation", ROOT / "scripts/ci/preserve-shared-native.remote.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class NativeGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name)
        self.ids = {"postgres": "a" * 64, "doltgres": "b" * 64}
        self.hashes = {"postgres": "c" * 64, "doltgres": "d" * 64}
        self.engines = {}
        for service, identity in self.ids.items():
            self.engines[service] = {
                "Id": identity, "Image": "sha256:" + "e" * 64, "RestartCount": 0,
                "Config": {"Image": service + ":pinned", "Env": ["PASSWORD=never-print"],
                           "Labels": {"com.docker.compose.project": "cogni-runtime",
                                      "com.docker.compose.service": service,
                                      "com.docker.compose.project.working_dir": str(self.runtime),
                                      "com.docker.compose.config-hash": self.hashes[service],
                                      "com.docker.compose.version": "2.39.1"}},
                "State": {"Running": True, "Paused": False, "Restarting": False,
                          "StartedAt": "2026-10-22T00:00:00Z", "Health": {"Status": "healthy"}}}
        self.commands = []

    def read(self, *command):
        self.commands.append(command)
        if command[:3] == ("docker", "compose", "version"):
            return "2.39.1\n"
        if command[-3:] == ("config", "--format", "json"):
            return json.dumps({"services": {service: {"image": service + ":pinned",
                               "environment": {"PASSWORD": "never-print"}}
                               for service in self.ids}})
        if "--hash" in command:
            service = command[-1]
            return service + " " + self.hashes[service] + "\n"
        if command[:2] == ("docker", "ps"):
            return self.ids[command[-1].split("=")[-1]] + "\n"
        if command[:3] == ("docker", "image", "inspect"):
            return json.dumps([{"Id": "sha256:" + "e" * 64}])
        if command[:2] == ("docker", "inspect"):
            service = next(service for service, value in self.ids.items() if value == command[-1])
            return json.dumps([self.engines[service]])
        raise AssertionError("Unexpected Docker authority: " + str(command))

    def capture(self, files=(), services=("postgres", "doltgres")):
        with patch.object(guard, "read", self.read):
            return guard.capture(self.runtime / "reviewed-compose.yml", self.runtime, files, services)

    def test_exact_engines_and_postgres_only_host(self):
        result = self.capture()
        self.assertEqual(set(result["engines"]), set(self.ids))
        self.assertNotIn("never-print", json.dumps(result))
        self.commands.clear()
        self.assertEqual(set(self.capture(services=("postgres",))["engines"]), {"postgres"})
        self.assertFalse(any("service=doltgres" in " ".join(command) for command in self.commands))

    def test_missing_or_stopped_twin_refuses(self):
        original = self.read
        for output in ("", "a" * 64 + "\n" + "f" * 64 + "\n"):
            def read(*command):
                return output if command[:2] == ("docker", "ps") else original(*command)
            with patch.object(guard, "read", read), self.assertRaisesRegex(
                    guard.Refused, "native_preservation_engine_ambiguous"):
                guard.capture("source", self.runtime)

    def test_state_config_and_effective_env_drift_refuse(self):
        pristine = deepcopy(self.engines)
        for mutate in (
            lambda row: row["State"].update(Running=False),
            lambda row: row["State"].update(Restarting=True),
            lambda row: row["State"]["Health"].update(Status="starting"),
            lambda row: row["Config"]["Labels"].update({"com.docker.compose.config-hash": "f" * 64}),
            lambda row: row["Config"].update(Env=["PASSWORD=different"]),
            lambda row: row.update(Image="sha256:" + "f" * 64),
        ):
            self.engines = deepcopy(pristine)
            mutate(self.engines["postgres"])
            with self.assertRaises(guard.Refused):
                self.capture()

    def test_native_file_and_identity_changes_are_visible(self):
        installed, staged = self.runtime / "installed", self.runtime / "staged"
        installed.write_text("exact")
        staged.write_text("different")
        with self.assertRaisesRegex(guard.Refused, "native_preservation_file_drift"):
            self.capture([str(installed) + "=" + str(staged)])
        staged.write_text("exact")
        before = self.capture([str(installed) + "=" + str(staged)])
        self.engines["doltgres"]["RestartCount"] = 1
        self.assertNotEqual(before, self.capture([str(installed) + "=" + str(staged)]))


class MirrorPreservationTest(unittest.TestCase):
    def test_preservation_never_writes_or_calls_lifecycle(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            runtime = directory / "runtime.env"
            marker = directory / "dolt-mirror-creds.hash"
            fixture_marker = "fixture-public-marker"
            runtime.write_text("UNRELATED=retain\nDOLT_CREDS_JWK=" + fixture_marker + "\nDOLT_CREDS_KEYID=id\n")
            marker.write_text("id:" + hashlib.sha256(fixture_marker.encode()).hexdigest())
            initial = (runtime.read_bytes(), marker.read_bytes())
            env = {**os.environ, "PRESERVE_SHARED_NATIVE": "1", "RUNTIME_ENV": str(runtime),
                   "HASH_DIR": temp, "RUNTIME_COMPOSE_BIN": "/nonexistent/lifecycle-forbidden",
                   "DOLT_CREDS_JWK_B64": base64.b64encode(fixture_marker.encode()).decode(),
                   "DOLT_CREDS_KEYID_B64": base64.b64encode(b"id").decode()}
            script = ROOT / "scripts/ci/reconcile-dolt-mirror-creds.remote.sh"
            result = subprocess.run(["bash", str(script)], env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(fixture_marker.encode(), result.stdout + result.stderr)
            for change in ({"MODE": "purge"}, {"DOLT_CREDS_KEYID_B64": "bmV3"},
                           {"PRESERVE_SHARED_NATIVE": "true"}):
                result = subprocess.run(["bash", str(script)], env={**env, **change},
                                        capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(initial, (runtime.read_bytes(), marker.read_bytes()))
                self.assertNotIn(fixture_marker.encode(), result.stdout + result.stderr)
            runtime.write_text("UNRELATED=retain\n")
            marker.unlink()
            result = subprocess.run(["bash", str(script)], env={**env, "MODE": "purge"},
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())
            self.assertEqual(runtime.read_text(), "UNRELATED=retain\n")


if __name__ == "__main__":
    unittest.main()
