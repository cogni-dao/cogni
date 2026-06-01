# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
Module: infra/images/litellm/cogni_callbacks.py
Purpose: Custom LiteLLM callback that routes billing callbacks to the correct
  node's /api/internal/billing/ingest endpoint based on node_id metadata.
Scope: Adapter glue only — runs inside LiteLLM process. No pricing logic,
  no policy logic, no reconciliation logic (CALLBACK_IS_ADAPTER_GLUE).
Invariants:
  REPO_SPEC_IS_IDENTITY_SSOT: no hardcoded node_id. The default node is injected
    via COGNI_DEFAULT_NODE_ID, sourced from the primary-host node's
    .cogni/repo-spec.yaml by deploy-infra.sh (image-tags.sh:default_node_id).
  NO_SILENT_MISATTRIBUTION: missing/unknown node_id falls back to the configured
    default only if one is set; otherwise the event is logged + skipped — never
    silently billed to a fabricated identity.
  CALLBACK_AUTHENTICATED: forwards BILLING_INGEST_TOKEN as Bearer header
  NODE_LOCAL_METERING_PRIMARY: routes to node-local endpoint
Side-effects: IO (HTTP POST to node ingest endpoints)
"""

import json
import logging
import os
from typing import Any

import httpx
from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger("cogni.callbacks")

# Default node for unattributed spend. Injected from the primary-host node's
# .cogni/repo-spec.yaml (REPO_SPEC_IS_IDENTITY_SSOT) — no hardcoded identity.
# When unset, missing/unknown node_id is logged + skipped (NO_SILENT_MISATTRIBUTION).
DEFAULT_NODE = os.environ.get("COGNI_DEFAULT_NODE_ID")


def _parse_node_endpoints() -> dict[str, str]:
    """Parse COGNI_NODE_ENDPOINTS env var into {node_id: url} map.

    Format: "operator=http://app:3000/api/internal/billing/ingest,poly=http://poly:3100/api/internal/billing/ingest"
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
            continue
        node_id, url = pair.split("=", 1)
        endpoints[node_id.strip()] = url.strip()

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

    Reads node_id (UUID) from spend_logs_metadata (set by each node's LLM adapter
    via x-litellm-spend-logs-metadata header). Routes to the matching node's
    /api/internal/billing/ingest endpoint. Defaults to operator UUID if node_id
    is missing (MISSING_NODE_ID_DEFAULTS_OPERATOR).
    """

    def __init__(self) -> None:
        super().__init__()
        self.node_endpoints = _parse_node_endpoints()
        self.billing_token = _get_billing_token()
        self._client = httpx.AsyncClient(timeout=10.0)
        logger.info(
            "CogniNodeRouter initialized — endpoints: %s", self.node_endpoints
        )

    async def async_log_success_event(
        self, kwargs: dict[str, Any], response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        """Called by LiteLLM after each successful completion. Routes to correct node."""
        try:
            # Extract node_id from metadata
            litellm_params = kwargs.get("litellm_params", {})
            metadata = litellm_params.get("metadata", {})
            spend_logs = metadata.get("spend_logs_metadata", {})

            node_id = spend_logs.get("node_id") if isinstance(spend_logs, dict) else None

            if not node_id:
                if not DEFAULT_NODE:
                    logger.error(
                        "No node_id in spend_logs_metadata and COGNI_DEFAULT_NODE_ID "
                        "unset — skipping callback (NO_SILENT_MISATTRIBUTION). "
                        "call_id=%s model=%s",
                        kwargs.get("litellm_call_id", "unknown"),
                        kwargs.get("model", "unknown"),
                    )
                    return
                node_id = DEFAULT_NODE
                logger.warning(
                    "No node_id in spend_logs_metadata — defaulting to '%s'. "
                    "call_id=%s model=%s",
                    DEFAULT_NODE,
                    kwargs.get("litellm_call_id", "unknown"),
                    kwargs.get("model", "unknown"),
                )

            # Resolve endpoint
            endpoint = self.node_endpoints.get(node_id)
            if not endpoint:
                if DEFAULT_NODE:
                    logger.warning(
                        "Unknown node_id '%s' — falling back to '%s'. call_id=%s",
                        node_id,
                        DEFAULT_NODE,
                        kwargs.get("litellm_call_id", "unknown"),
                    )
                    endpoint = self.node_endpoints.get(DEFAULT_NODE)
                if not endpoint:
                    logger.error(
                        "No endpoint for node_id '%s' (default '%s') — skipping "
                        "callback (NO_SILENT_MISATTRIBUTION). call_id=%s",
                        node_id,
                        DEFAULT_NODE,
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
                    "Billing ingest failed — node=%s status=%d body=%s call_id=%s",
                    node_id,
                    response.status_code,
                    response.text[:200],
                    kwargs.get("litellm_call_id", "unknown"),
                )
            else:
                logger.debug(
                    "Billing callback routed — node=%s call_id=%s",
                    node_id,
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
