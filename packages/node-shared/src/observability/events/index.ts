// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/logging/events`
 * Purpose: Event name registry for structured logging - prevents ad-hoc strings and schema drift.
 * Scope: Define valid event names as const registry. Does not define full payload schemas (for now).
 * Invariants: All event names registered here; logEvent() enforces base fields (reqId always).
 * Side-effects: none
 * Notes: Use EVENT_NAMES.* constants when logging. Later: add strict payload types if needed.
 * Links: Used by logEvent() in logger.ts; consumed by all logging callsites.
 * @public
 */

// ============================================================================
// Event Name Registry (as const)
// ============================================================================

export const EVENT_NAMES = {
  // AI Domain - Server
  AI_COMPLETION: "ai.completion",
  AI_LLM_CALL: "ai.llm_call",
  AI_LLM_CALL_COMPLETED: "ai.llm_call_completed",
  AI_TOOL_CALL_ERROR: "ai.tool_call.error",
  AI_CHAT_RECEIVED: "ai.chat_received",
  AI_CHAT_RESPONSE_STARTED: "ai.chat_response_started",
  AI_CHAT_STREAM_CLOSED: "ai.chat_stream_closed",
  AI_CHAT_CLIENT_ABORTED: "ai.chat_client_aborted",
  AI_MODELS_LIST_SUCCESS: "ai.models_list_success",
  AI_ACTIVITY_QUERY_COMPLETED: "ai.activity.query_completed",
  AI_BILLING_COMMIT_COMPLETE: "ai.billing.commit_complete",
  AI_RELAY_PUMP_ERROR: "ai.relay.pump_error",

  // AI Domain - Client
  CLIENT_CHAT_MODEL_INVALID_RETRY: "client.chat.model_invalid_retry",
  CLIENT_CHAT_STREAM_ERROR: "client.chat.stream_error",
  CLIENT_CHAT_STREAM_CHUNK_PARSE_FAIL: "client.chat.stream_chunk_parse_fail",
  CLIENT_AI_MODEL_PREF_READ_FAIL: "client.ai.model_pref_read_fail",
  CLIENT_AI_MODEL_PREF_WRITE_FAIL: "client.ai.model_pref_write_fail",
  CLIENT_AI_MODEL_PREF_CLEAR_FAIL: "client.ai.model_pref_clear_fail",
  CLIENT_AI_MODEL_PREF_INVALID: "client.ai.model_pref_invalid",

  // Payments Domain - Server
  PAYMENTS_INTENT_CREATED: "payments.intent_created",
  PAYMENTS_STATE_TRANSITION: "payments.state_transition",
  PAYMENTS_VERIFIED: "payments.verified",
  PAYMENTS_CONFIRMED: "payments.confirmed",
  PAYMENTS_STATUS_READ: "payments.status_read",
  PAYMENTS_FUNDING_COMPLETE: "payments.funding_complete",

  // Payments Domain - Client
  CLIENT_PAYMENTS_CREDITS_SUMMARY_HTTP_ERROR:
    "client.payments.credits_summary_http_error",
  CLIENT_PAYMENTS_CREDITS_SUMMARY_NETWORK_ERROR:
    "client.payments.credits_summary_network_error",
  CLIENT_PAYMENTS_HTTP_ERROR: "client.payments.http_error",
  CLIENT_PAYMENTS_FLOW_WALLET_WRITE_ERROR:
    "client.payments.flow_wallet_write_error",
  CLIENT_PAYMENTS_FLOW_SIMULATION_FAILED:
    "client.payments.flow_simulation_failed",
  CLIENT_PAYMENTS_FLOW_RECEIPT_ERROR: "client.payments.flow_receipt_error",

  // Setup Domain - Server
  SETUP_DAO_VERIFY_COMPLETE: "setup.dao_verify_complete",

  // Node Formation Domain - Server (wizard)
  NODE_FORMATION_CREATE_COMPLETE: "feature.node_formation.create_complete",
  NODE_PUBLISH_COMPLETE: "feature.node_publish.complete",

  // Adapter Events
  ADAPTER_LITELLM_COMPLETION_RESULT: "adapter.litellm.completion_result",
  ADAPTER_LITELLM_STREAM_RESULT: "adapter.litellm.stream_result",
  ADAPTER_LITELLM_USAGE_ERROR: "adapter.litellm.usage_error",
  ADAPTER_MIMIR_ERROR: "adapter.mimir.error",
  ADAPTER_TAVILY_ERROR: "adapter.tavily.error",
  ADAPTER_LANGGRAPH_INPROC_ERROR: "adapter.langgraph_inproc.error",
  ADAPTER_GIT_LS_FILES_ERROR: "adapter.git_ls_files.error",
  ADAPTER_GIT_LS_FILES_LIST: "adapter.git_ls_files.list",
  ADAPTER_RIPGREP_ERROR: "adapter.ripgrep.error",
  ADAPTER_RIPGREP_SEARCH: "adapter.ripgrep.search",
  ADAPTER_RIPGREP_OPEN: "adapter.ripgrep.open",
  // TODO: remove once all node openclaw-gateway-clients are deleted (per-node PRs)
  ADAPTER_OPENCLAW_GATEWAY_ERROR: "adapter.openclaw_gateway.error",
  ADAPTER_TIGERBEETLE_ERROR: "adapter.tigerbeetle.error",

  // Ledger Domain
  LEDGER_ALLOCATIONS_UPDATED: "ledger.allocations_updated",
  LEDGER_REVIEW_SUBJECT_OVERRIDES_UPDATED:
    "ledger.review_subject_overrides_updated",
  LEDGER_POOL_COMPONENT_RECORDED: "ledger.pool_component_recorded",
  LEDGER_IDENTITY_RESOLVED_AT_READ: "ledger.identity_resolved_at_read",
  LEDGER_FINALIZE_SUBMITTED: "ledger.finalize_submitted",
  LEDGER_FINALIZE_NO_POLLERS: "ledger.finalize_no_pollers",
  LEDGER_COLLECT_TRIGGERED: "ledger.collect_triggered",

  // BYO-AI Auth Domain
  BYO_AUTH_DEVICE_CODE_COMPLETE: "byo_auth.device_code.complete",
  BYO_AUTH_EXCHANGE_COMPLETE: "byo_auth.exchange.complete",
  ADAPTER_OPENAI_DEVICE_AUTH_ERROR: "adapter.openai_device_auth.error",

  // Scheduling Domain
  SCHEDULE_CREDIT_GATE_REJECTED: "schedules.credit_gate_rejected",

  // Governance Domain
  GOVERNANCE_SYNC_COMPLETE: "governance.sync.complete",

  // Sandbox Execution Events
  SANDBOX_EXECUTION_STARTED: "sandbox.execution.started",
  SANDBOX_EXECUTION_COMPLETE: "sandbox.execution.complete",

  // Treasury Domain
  TREASURY_SNAPSHOT_COMPLETE: "feature.treasury_snapshot.complete",
  TREASURY_CONFIG_MISSING: "feature.treasury_snapshot.config_missing",

  // Signal Execution Domain
  SIGNAL_EXECUTION_COMPLETE: "feature.signal_execution.complete",
  SIGNAL_DISPATCH_SKIPPED: "feature.signal_dispatch.skipped",
  ADAPTER_EVM_RPC_ERROR: "adapter.evm_rpc.error",

  // Review Domain
  REVIEW_COMPLETE: "feature.review.complete",
  ADAPTER_GITHUB_REVIEW_ERROR: "adapter.github_review.error",

  // Invariant Warnings
  INV_PROVIDER_META_MODEL_MISSING: "inv_provider_meta_model_missing",
  INV_MODELS_CONTRACT_VALIDATION_FAILED:
    "inv_models_contract_validation_failed",

  // Error Codes
  AI_MODELS_CACHE_FETCH_FAILED: "ai.models_cache_fetch_failed",
  AI_CHAT_STREAM_FINALIZATION_LOST: "ai.chat_stream_finalization_lost",
  MODEL_VALIDATION_FAILED: "model_validation_failed",

  // Test Events
  TEST_EVENT: "TEST_EVENT",

  // Langfuse Lifecycle (per OBSERVABILITY.md#langfuse-integration)
  LANGFUSE_TRACE_CREATED: "langfuse.trace_created",
  LANGFUSE_TRACE_COMPLETED: "langfuse.trace_completed",

  // Poly trade capability lifecycle (shipped PR #900 CP4.25, pre-existing
  // inline strings migrated to the registry in CP4.3e observability pass)
  POLY_TRADE_CAPABILITY_TEST_MODE: "poly.trade.capability.test_mode",
  POLY_TRADE_CAPABILITY_UNAVAILABLE: "poly.trade.capability.unavailable",
  POLY_TRADE_CAPABILITY_ENV_OK: "poly.trade.capability.env_ok",
  POLY_TRADE_CAPABILITY_READY: "poly.trade.capability.ready",
  POLY_COPY_TRADE_EXECUTE: "poly.copy_trade.execute",

  // Poly copy-trade mirror (task.0315 Phase 1 — emitted only on poly node)
  POLY_MIRROR_POLL_SINGLETON_CLAIM: "poly.mirror.poll.singleton_claim",
  POLY_MIRROR_POLL_STOPPED: "poly.mirror.poll.stopped",
  POLY_MIRROR_POLL_TICK_ERROR: "poly.mirror.poll.tick_error",
  POLY_MIRROR_POLL_SKIPPED: "poly.mirror.poll.skipped",
  POLY_MIRROR_POLL_BOOT_FAILED: "poly.mirror.poll.boot_failed",
  // Target-set reconciler (bug.0338 fix — separate from the ledger reconciler
  // below which walks CLOB order status). Ticks every 30s, diffs the active
  // target set against running per-target polls, starts/stops as needed.
  POLY_MIRROR_TARGETS_RECONCILE_TICK: "poly.mirror.targets.reconcile.tick",
  POLY_MIRROR_TARGETS_RECONCILE_TICK_ERROR:
    "poly.mirror.targets.reconcile.tick_error",
  POLY_MIRROR_TARGETS_RECONCILE_STOPPED:
    "poly.mirror.targets.reconcile.stopped",
  // Ledger reconciler (task.0323 §2)
  POLY_MIRROR_RECONCILE_SINGLETON_CLAIM:
    "poly.mirror.reconcile.singleton_claim",
  POLY_MIRROR_RECONCILE_STOPPED: "poly.mirror.reconcile.stopped",
  POLY_MIRROR_RECONCILE_TICK_ERROR: "poly.mirror.reconcile.tick_error",
  POLY_MIRROR_SOURCE_ERROR: "poly.mirror.source_error",
  POLY_MIRROR_DECISION: "poly.mirror.decision",
  POLY_WALLET_WATCH_FETCH: "poly.wallet_watch.fetch",
  POLY_WALLET_WATCH_NORMALIZE_ERROR: "poly.wallet_watch.normalize_error",
  POLY_WALLET_WATCH_WS_HEARTBEAT: "poly.wallet_watch.ws.heartbeat",
  POLY_WALLET_BALANCE_POLYGON_READ_FAILED:
    "poly.wallet.balance.polygon_read_failed",
  POLY_WALLET_BALANCE_OPEN_ORDERS_FAILED:
    "poly.wallet.balance.open_orders_failed",
  POLY_WALLET_OVERVIEW_COMPLETE: "feature.poly_wallet_overview.complete",
  POLY_WALLET_EXECUTION_COMPLETE: "feature.poly_wallet_execution.complete",
  POLY_WALLET_ROTATE_CLOB_CREDS_COMPLETE:
    "poly.wallet.rotate_clob_creds.complete",
  ADAPTER_ORDER_LEDGER_SNAPSHOT_ERROR: "adapter.order_ledger.snapshot_error",

  // Poly reconciler not-found branch (task.0328 CP2)
  // Emitted at debug when a row is within the grace window.
  POLY_RECONCILER_NOT_FOUND: "poly.reconciler.not_found",
  // Emitted at info when a stale row is promoted to canceled.
  POLY_RECONCILER_NOT_FOUND_UPGRADE: "poly.reconciler.not_found_upgrade",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// ============================================================================
// Base Field Enforcement (for logEvent() helper)
// ============================================================================

/**
 * Required base fields for all events.
 * reqId is ALWAYS required; routeId required for HTTP request events.
 */
export interface EventBase {
  reqId: string;
  routeId?: string;
}
