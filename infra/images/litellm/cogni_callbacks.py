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
  GATEWAY_RECEIPT_PER_CALL: every success and failure prints one
    `ai.gateway.receipt` JSON line to stdout, before and independent of billing
    routing. The env VM collector labels it {env=<lane>, service=litellm}; the
    operator trace reader verifies cross-lane generations against it (bug.5625).
Side-effects: IO (HTTP POST to node ingest endpoints; one stdout line per call)
"""

import hashlib
import hmac
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

import httpx
from litellm._logging import verbose_logger
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


def _utc(value: Any) -> str | None:
    """LiteLLM passes naive UTC datetimes; Langfuse records the same instants."""
    if not isinstance(value, datetime):
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return aware.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _str(value: Any, limit: int = 512) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def emit_gateway_receipt(
    kwargs: dict[str, Any], response_obj: Any, start_time: Any, end_time: Any, status: str
) -> None:
    """Print one structured receipt per call. Never raises.

    Authority is the server-stamped key hash and alias; runId and spendNodeId are
    request metadata the reader must also find on the same Langfuse row.

    Keys avoid `nodeId`/`svcNode` so the collector adds no node label: the gateway,
    not a node, writes this stream. No content, cost, key or key hash is logged:
    LiteLLM accepts a stored key hash as a bearer token. The authenticated alias
    names the node and lane.
    """
    try:
        litellm_params = kwargs.get("litellm_params") or {}
        metadata = litellm_params.get("metadata") if isinstance(litellm_params, dict) else None
        metadata = metadata if isinstance(metadata, dict) else {}
        spend = metadata.get("spend_logs_metadata")
        spend = spend if isinstance(spend, dict) else {}
        response_id = None
        if status == "success" and response_obj is not None:
            try:
                response_id = response_obj.get("id")
            except Exception:
                response_id = getattr(response_obj, "id", None)
        line = {
            "event": "ai.gateway.receipt",
            "status": status,
            "callId": _str(kwargs.get("litellm_call_id")),
            "responseId": _str(response_id),
            "keyAlias": _str(metadata.get("user_api_key_alias"), 128),
            "runId": _str(spend.get("run_id"), 256),
            "spendNodeId": _str(spend.get("node_id"), 64),
            "startTime": _utc(start_time),
            "endTime": _utc(end_time),
        }
        sys.stdout.write(json.dumps(line, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except Exception:
        logger.exception("Gateway receipt emission failed")


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
        emit_gateway_receipt(kwargs, response_obj, start_time, end_time, "success")
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

    async def async_log_failure_event(
        self, kwargs: dict[str, Any], response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        """Failures bill nothing; they still leave the per-call gateway receipt."""
        emit_gateway_receipt(kwargs, response_obj, start_time, end_time, "failure")


# Module-level instance — LiteLLM `callbacks` config expects an instance, not a class.
# Config: `callbacks: cogni_callbacks.cogni_node_router`
cogni_node_router = CogniNodeRouter()


# ---------------------------------------------------------------------------
# Langfuse trace emitter over OTLP (bug.5643)
# ---------------------------------------------------------------------------
# Cogni LiteLLM -> Langfuse trace emitter over OpenTelemetry (bug.5643).
# 
# Langfuse Cloud shut down the v3 ingestion API on 2026-11-16, which the legacy
# `langfuse` callback used. Traces now travel as OTLP to /api/public/otel.
# 
# LiteLLM's stock `langfuse_otel` callback writes the standard-logging metadata as one
# opaque attribute and drops the provider response id. The operator trace reader
# (nodes/operator/app/src/adapters/server/observability/langfuse-*.adapter.ts) authorizes a
# GENERATION from fields the legacy callback wrote: `metadata.user_api_key*`,
# `metadata.requester_metadata`, `metadata.nodeId`, the provider response id, the call's own
# start/end instants and the Langfuse `environment`. This subclass emits those fields in the
# same shape, so rows stay attributable and foreign-node rows stay hidden.
# 
# Invariants:
# - METADATA_SHAPE_PARITY: every key of litellm_params.metadata (except the four the legacy
#   callback dropped) becomes `langfuse.observation.metadata.<key>`; objects are JSON strings,
#   which the reader already expands (`expandMetadata`).
# - RESPONSE_ID_IN_OUTPUT: the output JSON carries the provider response `id`, the join key
#   for the gateway receipt. The id is written by the gateway, never taken from caller input.
# - LIVE_V2_READS: `x-langfuse-ingestion-version: 4` makes rows readable on the v2 API in
#   real time. Without it Langfuse may delay them by up to 15 minutes.
# - NEVER_BREAK_THE_GATEWAY: missing credentials disable tracing; they never stop LiteLLM.

# Keys the legacy callback removed from metadata before logging.
_DROPPED_METADATA_KEYS = frozenset(
    {
        "headers",
        "endpoint",
        "caching_groups",
        "previous_models",
        # Live span object; its repr is noise.
        "litellm_parent_otel_span",
    }
)
_METADATA_PREFIX = "langfuse.observation.metadata."
_MAX_ATTRIBUTE_CHARS = 200_000


def _plain(value: Any) -> Any:
    """json.dumps fallback: pydantic models (UserAPIKeyAuth) become dicts, never a repr string."""
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            # UserAPIKeyAuth carries the live OTel parent span; it has no JSON form.
            return dump(mode="json", exclude={"parent_otel_span"})
        except Exception:
            return dump(exclude={"parent_otel_span"})
    return str(value)


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=_plain)
    except Exception:
        return str(value)


def _build() -> CustomLogger:
    if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
        verbose_logger.warning("Langfuse credentials unset; Langfuse tracing disabled")
        return CustomLogger()

    from litellm.integrations.langfuse.langfuse_otel import LangfuseOtelLogger
    from litellm.integrations.opentelemetry import OpenTelemetryConfig

    class CogniLangfuseOtel(LangfuseOtelLogger):
        def __init__(self) -> None:
            # Also exports OTEL_EXPORTER_OTLP_ENDPOINT from LANGFUSE_OTEL_HOST / LANGFUSE_HOST.
            base = LangfuseOtelLogger.get_langfuse_otel_config()
            headers = f"{base.otlp_auth_headers},x-langfuse-ingestion-version=4"
            super().__init__(
                config=OpenTelemetryConfig(exporter=base.protocol, headers=headers),
                callback_name="langfuse_otel",
            )

        def _get_span_name(self, kwargs: dict) -> str:
            return CogniLangfuseOtel._span_name(kwargs)

        @staticmethod
        def _span_name(kwargs: dict) -> str:
            params = kwargs.get("litellm_params") or {}
            metadata = params.get("metadata") or {}
            name = metadata.get("generation_name")
            if name:
                return str(name)
            alias = metadata.get("user_api_key_alias")
            if alias is not None:
                return f"litellm:{alias}"
            return f"litellm-{kwargs.get('call_type', 'completion')}"

        @staticmethod
        def set_langfuse_otel_attributes(span: Any, kwargs: dict, response_obj: Any) -> None:
            # The stock logger copies `langfuse_<key>` request headers into the live
            # litellm_params.metadata dict. Give it a copy so a caller header can never
            # overwrite the gateway-stamped identity read below or by the billing router.
            stock_params = dict(kwargs.get("litellm_params") or {})
            stock_params["metadata"] = dict(stock_params.get("metadata") or {})
            LangfuseOtelLogger.set_langfuse_otel_attributes(
                span, {**kwargs, "litellm_params": stock_params}, response_obj
            )
            try:
                CogniLangfuseOtel._set_gateway_identity(span, kwargs, response_obj)
            except Exception:
                verbose_logger.exception("Cogni Langfuse OTel identity attributes failed")

        def set_attributes(self, span: Any, kwargs: dict, response_obj: Any) -> None:
            CogniLangfuseOtel.set_langfuse_otel_attributes(span, kwargs, response_obj)

        @staticmethod
        def _set_gateway_identity(span: Any, kwargs: dict, response_obj: Any) -> None:
            params = kwargs.get("litellm_params") or {}
            metadata = params.get("metadata")
            # A proxy request reuses its parent span as the primary span; name it like the
            # legacy callback did (`litellm:<key alias>`) instead of the proxy span's name.
            try:
                span.update_name(
                    CogniLangfuseOtel._span_name(kwargs)
                )
            except Exception:
                pass
            if isinstance(metadata, dict):
                for key, value in metadata.items():
                    if key in _DROPPED_METADATA_KEYS or value is None:
                        continue
                    span.set_attribute(
                        _METADATA_PREFIX + str(key), _text(value)[:_MAX_ATTRIBUTE_CHARS]
                    )

            release = os.environ.get("LANGFUSE_RELEASE")
            if release:
                span.set_attribute("langfuse.release", release)

            # Provider response id: the receipt join key. Stock output omits it.
            if response_obj is not None and hasattr(response_obj, "get"):
                response_id = response_obj.get("id")
                choices = response_obj.get("choices") or []
                if response_id and choices:
                    message = choices[0].get("message") or {}
                    if hasattr(message, "model_dump"):
                        message = message.model_dump(exclude_none=True)
                    output = {**dict(message), "id": str(response_id)}
                    span.set_attribute(
                        "langfuse.observation.output", _text(output)[:_MAX_ATTRIBUTE_CHARS]
                    )

    return CogniLangfuseOtel()


cogni_langfuse_otel = _build()
