# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

"""Exercise the real router; --upstream uses the pinned image's full request setup.

Hermetic mode needs only Python's standard library and records all HTTP calls.
In the selected LiteLLM image: python3 <this-file> --upstream /app/cogni_callbacks.py
Both modes use dummy credentials and recording transport, never live receipts.
"""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest

UPSTREAM = "--upstream" in sys.argv
if UPSTREAM:
    sys.argv.remove("--upstream")
CALLBACK = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else (
    Path(__file__).resolve().parents[3] / "infra/images/litellm/cogni_callbacks.py"
)
NODE = "66666666-7777-8888-9999-aaaaaaaaaaaa"
OPERATOR = "11111111-2222-3333-4444-555555555555"
MASTER = "sk-cogni-test-master-not-a-real-credential"
VIRTUAL = "sk-cogni-test-virtual-not-a-real-credential"
MASTER_HASH = hashlib.sha256(MASTER.encode()).hexdigest()
VIRTUAL_HASH = hashlib.sha256(VIRTUAL.encode()).hexdigest()
CANDIDATE = f"cogni:candidate-a:{NODE}:app:v1"
PRODUCTION = f"cogni:production:{NODE}:app:v1"
ROUTES = (
    f"{OPERATOR}=http://operator:3000,operator=http://operator:3000,"
    f"{NODE}=https://node.example.test,"
    f"{CANDIDATE}=https://node-test.example.test,"
    f"{PRODUCTION}=https://node.example.test"
)


class RecordingClient:
    def __init__(self, **_):
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return types.SimpleNamespace(status_code=200, text="ok")

    async def aclose(self):
        pass


os.environ.update(
    COGNI_NODE_ENDPOINTS=ROUTES,
    COGNI_DEFAULT_NODE_ID=OPERATOR,
    BILLING_INGEST_TOKEN="test-ingest-token",
    LITELLM_MASTER_KEY=MASTER,
)
if not UPSTREAM:
    logger_module = types.ModuleType("litellm.integrations.custom_logger")
    logger_module.CustomLogger = object
    sys.modules[logger_module.__name__] = logger_module
    httpx_module = types.ModuleType("httpx")
    httpx_module.AsyncClient = RecordingClient
    sys.modules["httpx"] = httpx_module
else:
    from litellm.proxy._types import UserAPIKeyAuth
    from litellm.proxy.litellm_pre_call_utils import add_litellm_data_to_request
    from litellm.proxy.proxy_server import ProxyConfig
    from starlette.requests import Request

spec = importlib.util.spec_from_file_location("router_under_test", CALLBACK)
router_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router_module)


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ["COGNI_NODE_ENDPOINTS"] = ROUTES
        self.router = router_module.CogniNodeRouter()
        await self.router._client.aclose()
        self.router._client = RecordingClient()

    async def asyncTearDown(self):
        await self.router._client.aclose()

    async def metadata(self, alias=CANDIDATE, key=VIRTUAL, node=NODE, **forged):
        data = {"metadata": {"spend_logs_metadata": {"node_id": node}, **forged}}
        if node is None:
            data["metadata"]["spend_logs_metadata"] = {}
        if UPSTREAM:
            # Execute the full upstream merge order, including body/header and
            # litellm_metadata handling, not a reproduction of the stamp function.
            request = Request({
                "type": "http", "method": "POST", "scheme": "http",
                "server": ("test.invalid", 80), "path": "/v1/chat/completions",
                "query_string": b"", "headers": [
                    (b"x-litellm-spend-logs-metadata", json.dumps(
                        data["metadata"]["spend_logs_metadata"]
                    ).encode()),
                    (b"x-litellm-user-api-key-alias", PRODUCTION.encode()),
                ],
            })
            data["litellm_metadata"] = {
                "user_api_key_alias": PRODUCTION, "user_api_key_hash": MASTER_HASH,
            }
            data = await add_litellm_data_to_request(
                data=data, request=request,
                user_api_key_dict=UserAPIKeyAuth(api_key=key, key_alias=alias),
                proxy_config=ProxyConfig(), general_settings={},
            )
        else:
            data["metadata"].update(
                user_api_key_alias=alias,
                user_api_key_hash=hashlib.sha256(key.encode()).hexdigest(),
            )
        self.assertEqual(data["metadata"]["user_api_key_alias"], alias)
        self.assertEqual(data["metadata"]["user_api_key_hash"], hashlib.sha256(key.encode()).hexdigest())
        return data["metadata"]

    async def route(self, metadata):
        payload = {"id": "provider-call-fixture", "response_cost": 0,
                   "prompt_tokens": 7429, "completion_tokens": 2998,
                   "total_tokens": 10427, "metadata": {"run_id": "test-run"}}
        before = copy.deepcopy(payload)
        await self.router.async_log_success_event({
            "litellm_params": {"metadata": metadata},
            "standard_logging_object": payload, "litellm_call_id": "proxy-call-fixture",
        }, None, None, None)
        self.assertEqual(payload, before)
        for _, call in self.router._client.calls:
            self.assertEqual(json.loads(call["content"]), [before])
            self.assertEqual(call["headers"]["Authorization"], "Bearer test-ingest-token")
        return [url for url, _ in self.router._client.calls]

    async def test_same_node_different_authenticated_lanes(self):
        for alias, target in [(CANDIDATE, "https://node-test.example.test"),
                              (PRODUCTION, "https://node.example.test")]:
            self.router._client.calls.clear()
            self.assertEqual(await self.route(await self.metadata(alias=alias)),
                             [target + "/api/internal/billing/ingest"])

    async def test_requester_alias_and_hash_cannot_override_authentication(self):
        metadata = await self.metadata(user_api_key_alias=PRODUCTION,
                                       user_api_key_hash=MASTER_HASH,
                                       requester_metadata={"user_api_key_alias": PRODUCTION})
        self.assertEqual(await self.route(metadata),
                         ["https://node-test.example.test/api/internal/billing/ingest"])

    async def test_foreign_node_claim_is_rejected(self):
        self.assertEqual(await self.route(await self.metadata(node=OPERATOR)), [])

    async def test_missing_node_uses_authenticated_alias_without_payload_rewrite(self):
        self.assertEqual(await self.route(await self.metadata(node=None)),
                         ["https://node-test.example.test/api/internal/billing/ingest"])

    async def test_invalid_or_unconfigured_alias_never_uses_default(self):
        for alias in [None, "", "garbage", CANDIDATE.replace(":v1", ":v2"),
                      CANDIDATE.replace("candidate-a", "preview"),
                      CANDIDATE.replace(NODE, OPERATOR)]:
            with self.subTest(alias=alias):
                self.assertEqual(await self.route(await self.metadata(alias=alias)), [])

    async def test_missing_hash_never_routes(self):
        metadata = await self.metadata()
        metadata.pop("user_api_key_hash")
        self.assertEqual(await self.route(metadata), [])

    async def test_virtual_key_cannot_claim_master_role(self):
        self.assertEqual(await self.route(await self.metadata(
            alias=None, node=OPERATOR, user_api_key_hash=MASTER_HASH,
            user_role="proxy_admin", is_master_key=True)), [])

    async def test_master_compatibility_is_local_and_unknown_node_fails(self):
        for node in [OPERATOR, None]:
            self.router._client.calls.clear()
            self.assertEqual(await self.route(await self.metadata(alias=None, key=MASTER, node=node)),
                             ["http://operator:3000/api/internal/billing/ingest"])
        self.router._client.calls.clear()
        for node in ["unknown-node", CANDIDATE]:
            self.assertEqual(await self.route(await self.metadata(
                alias=None, key=MASTER, node=node)), [])

    async def test_malformed_node_metadata_fails(self):
        for value in [[], "not-an-object", {"node_id": []}, {"node_id": ""}]:
            metadata = await self.metadata()
            metadata["spend_logs_metadata"] = value
            self.assertEqual(await self.route(metadata), [])

    @unittest.skipUnless(os.environ.get("RENDERED_BILLING_ENDPOINTS"), "renderer fixture not supplied")
    async def test_catalog_rendered_map_routes_exact_workload(self):
        os.environ["COGNI_NODE_ENDPOINTS"] = os.environ["RENDERED_BILLING_ENDPOINTS"]
        await self.router._client.aclose()
        self.router = router_module.CogniNodeRouter()
        await self.router._client.aclose()
        self.router._client = RecordingClient()
        for alias, target in [
            (CANDIDATE, "https://za-test.isolated-workload.test"),
            (PRODUCTION, "https://za.isolated-workload.test"),
            (CANDIDATE.replace("candidate-a", "preview"), "https://za-preview.isolated-workload.test"),
        ]:
            self.router._client.calls.clear()
            self.assertEqual(await self.route(await self.metadata(alias=alias)),
                             [target + "/api/internal/billing/ingest"])
        self.router._client.calls.clear()
        self.assertEqual(await self.route(await self.metadata(
            alias=CANDIDATE.replace("candidate-a", "candidate-other"))), [])

    def test_conflicting_routes_and_bad_alias_fail_at_startup(self):
        for suffix in [f",{CANDIDATE}=https://other.invalid", ",cogni:bad=url"]:
            with self.subTest(suffix=suffix):
                os.environ["COGNI_NODE_ENDPOINTS"] = ROUTES + suffix
                with self.assertRaises(RuntimeError):
                    router_module._parse_node_endpoints()


if __name__ == "__main__":
    unittest.main(verbosity=2)
