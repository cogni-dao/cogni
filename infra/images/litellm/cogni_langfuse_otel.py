# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

"""Cogni LiteLLM -> Langfuse trace emitter over OpenTelemetry (bug.5643).

Langfuse Cloud shut down the v3 ingestion API on 2026-11-16, which the legacy
`langfuse` callback used. Traces now travel as OTLP to /api/public/otel.

LiteLLM's stock `langfuse_otel` callback writes the standard-logging metadata as one
opaque attribute and drops the provider response id. The operator trace reader
(nodes/operator/app/src/adapters/server/observability/langfuse-*.adapter.ts) authorizes a
GENERATION from fields the legacy callback wrote: `metadata.user_api_key*`,
`metadata.requester_metadata`, `metadata.nodeId`, the provider response id, the call's own
start/end instants and the Langfuse `environment`. This subclass emits those fields in the
same shape, so rows stay attributable and foreign-node rows stay hidden.

Invariants:
- METADATA_SHAPE_PARITY: every key of litellm_params.metadata (except the four the legacy
  callback dropped) becomes `langfuse.observation.metadata.<key>`; objects are JSON strings,
  which the reader already expands (`expandMetadata`).
- RESPONSE_ID_IN_OUTPUT: the output JSON carries the provider response `id`, the join key
  for the gateway receipt. The id is written by the gateway, never taken from caller input.
- LIVE_V2_READS: `x-langfuse-ingestion-version: 4` makes rows readable on the v2 API in
  real time. Without it Langfuse may delay them by up to 15 minutes.
- NEVER_BREAK_THE_GATEWAY: missing credentials disable tracing; they never stop LiteLLM.
"""

import json
import os
from typing import Any

from litellm._logging import verbose_logger
from litellm.integrations.custom_logger import CustomLogger

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
