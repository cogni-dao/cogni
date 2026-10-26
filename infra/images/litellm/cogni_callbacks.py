# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
Module: infra/images/litellm/cogni_callbacks.py
Purpose: Route unchanged billing callbacks to the authenticated node/workload lane.
Scope: Adapter glue only — runs inside LiteLLM process. No pricing logic,
  no policy logic, no reconciliation logic (CALLBACK_IS_ADAPTER_GLUE).
Invariants:
  REPO_SPEC_IS_IDENTITY_SSOT: no hardcoded node_id. The default node is injected
    via COGNI_DEFAULT_NODE_ID, sourced from the primary-host node's
    .cogni/repo-spec.yaml by deploy-infra.sh (image-tags.sh:default_node_id).
  NO_SILENT_MISATTRIBUTION: virtual keys require an exact registered alias route;
    only a proven master key may use local legacy routes or the missing-node default.
  CALLBACK_AUTHENTICATED: forwards BILLING_INGEST_TOKEN as Bearer header
  NODE_LOCAL_METERING_PRIMARY: routes to node-local endpoint
Side-effects: IO (HTTP POST to node ingest endpoints)
"""

import hashlib
import hmac
import json
import logging
import os
import re
from typing import Any

import httpx
from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger("cogni.callbacks")

# Default node for missing attribution on authenticated master-key traffic only.
# Injected from the primary-host node's
# .cogni/repo-spec.yaml (REPO_SPEC_IS_IDENTITY_SSOT) — no hardcoded identity.
# When unset, missing/unknown node_id is logged + skipped (NO_SILENT_MISATTRIBUTION).
DEFAULT_NODE = os.environ.get("COGNI_DEFAULT_NODE_ID")
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_WORKLOAD_ALIAS = re.compile(rf"cogni:([a-z0-9]+(?:-[a-z0-9]+)*):({_UUID}):app:v1")
_KEY_HASH = re.compile(r"[0-9a-f]{64}")


def _parse_node_endpoints() -> dict[str, str]:
    """Parse exact authenticated aliases and local legacy node IDs into URLs.

    Values are base URLs; keys are exact workload aliases or local legacy node IDs.
    Required — fails loudly if not set.
    """
    raw = os.environ.get("COGNI_NODE_ENDPOINTS", "")
    if not raw:
        raise RuntimeError(
            "COGNI_NODE_ENDPOINTS is required. "
            "Format: node_id=endpoint_url,node_id=endpoint_url,..."
        )

    endpoints: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" not in pair:
            raise RuntimeError("Malformed COGNI_NODE_ENDPOINTS entry")
        route_key, url = (part.strip() for part in pair.split("=", 1))
        if not route_key or not url:
            raise RuntimeError("Empty COGNI_NODE_ENDPOINTS key or URL")
        if route_key.startswith("cogni:") and not _WORKLOAD_ALIAS.fullmatch(route_key):
            raise RuntimeError("Malformed workload alias in COGNI_NODE_ENDPOINTS")
        if route_key in endpoints and endpoints[route_key] != url:
            raise RuntimeError("Conflicting COGNI_NODE_ENDPOINTS entries")
        endpoints[route_key] = url

    if not endpoints:
        raise RuntimeError(
            "COGNI_NODE_ENDPOINTS parsed to empty map. "
            "Format: node_id=endpoint_url,node_id=endpoint_url,..."
        )

    return endpoints


def _get_billing_token() -> str:
    return os.environ.get("BILLING_INGEST_TOKEN", "")


class CogniNodeRouter(CustomLogger):
    """Routes LiteLLM success callbacks to per-node billing ingest endpoints.

    LiteLLM overwrites user_api_key_alias/hash from authenticated UserAPIKeyAuth
    after request/header metadata. Never read requester_metadata for authority.
    Virtual keys use exact lane-qualified aliases; the existing master key alone
    may use the gateway's local legacy map. Unknown identities never fall back.
    """

    def __init__(self) -> None:
        super().__init__()
        self.node_endpoints = _parse_node_endpoints()
        self.billing_token = _get_billing_token()
        master = os.environ.get("LITELLM_MASTER_KEY", "")
        self._master_hash = hashlib.sha256(master.encode()).hexdigest() if master else None
        self._client = httpx.AsyncClient(timeout=10.0)
        logger.info(
            "CogniNodeRouter initialized — endpoints: %s", self.node_endpoints
        )

    def _resolve_route(self, metadata: dict[str, Any]) -> str | None:
        """Resolve server-authenticated identity without changing receipt contents."""
        key_hash = metadata.get("user_api_key_hash")
        if not isinstance(key_hash, str) or not _KEY_HASH.fullmatch(key_hash):
            return None
        spend_logs = metadata.get("spend_logs_metadata", {})
        if not isinstance(spend_logs, dict):
            return None
        node_id = spend_logs.get("node_id")
        if "node_id" in spend_logs and (not isinstance(node_id, str) or not node_id):
            return None
        alias = metadata.get("user_api_key_alias")
        if alias is not None and alias != "":
            match = _WORKLOAD_ALIAS.fullmatch(alias) if isinstance(alias, str) else None
            if not match or (node_id is not None and node_id != match.group(2)):
                return None
            route_key = alias
        else:
            if not self._master_hash or not hmac.compare_digest(key_hash, self._master_hash):
                return None
            route_key = node_id if node_id is not None else DEFAULT_NODE
            # A caller must not smuggle a foreign-lane alias through legacy node_id.
            if not route_key or route_key.startswith("cogni:"):
                return None
        return self.node_endpoints.get(route_key)

    async def async_log_success_event(
        self, kwargs: dict[str, Any], response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        """Called by LiteLLM after each successful completion. Routes to correct node."""
        try:
            # These fields are stamped by the pinned LiteLLM authentication path.
            litellm_params = kwargs.get("litellm_params", {})
            metadata = litellm_params.get("metadata", {})
            endpoint = self._resolve_route(metadata) if isinstance(metadata, dict) else None
            if endpoint is None:
                logger.warning(
                    "Billing callback rejected — unconfigured or conflicting authenticated "
                    "workload identity. call_id=%s",
                    kwargs.get("litellm_call_id", "unknown"),
                )
                return

            # Build the StandardLoggingPayload-shaped object
            # LiteLLM provides standard_logging_object in kwargs
            payload = kwargs.get("standard_logging_object")
            if not payload:
                logger.warning(
                    "No standard_logging_object in kwargs — skipping. call_id=%s",
                    kwargs.get("litellm_call_id", "unknown"),
                )
                return

            # POST to node's ingest endpoint (same format as generic_api: array of entries)
            headers: dict[str, str] = {"Content-Type": "application/json"}
            if self.billing_token:
                headers["Authorization"] = f"Bearer {self.billing_token}"

            ingest_url = endpoint.rstrip("/") + "/api/internal/billing/ingest"
            response = await self._client.post(
                ingest_url,
                content=json.dumps([payload]),
                headers=headers,
            )

            if response.status_code != 200:
                logger.error(
                    "Billing ingest failed — status=%d body=%s call_id=%s",
                    response.status_code,
                    response.text[:200],
                    kwargs.get("litellm_call_id", "unknown"),
                )
            else:
                logger.debug(
                    "Billing callback routed — call_id=%s",
                    kwargs.get("litellm_call_id", "unknown"),
                )

        except Exception:
            logger.exception(
                "CogniNodeRouter.async_log_success_event failed — call_id=%s",
                kwargs.get("litellm_call_id", "unknown"),
            )


# Module-level instance — LiteLLM `callbacks` config expects an instance, not a class.
# Config: `callbacks: cogni_callbacks.cogni_node_router`
cogni_node_router = CogniNodeRouter()
