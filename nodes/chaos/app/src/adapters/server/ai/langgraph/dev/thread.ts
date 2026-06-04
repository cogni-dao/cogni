// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/dev/thread`
 * Purpose: UUIDv5 thread ID derivation for LangGraph dev server.
 * Scope: Derives deterministic thread UUIDs from billing account + thread key. Does NOT manage thread lifecycle or persistence.
 * Invariants:
 *   - THREAD_ID_IS_UUID: LangGraph API requires UUID format
 *   - THREAD_ID_TENANT_SCOPED: Thread ID derived from billingAccountId + key
 *   - DETERMINISTIC: Same inputs always produce same UUID
 * Side-effects: none
 * Links: LANGGRAPH_SERVER.md (MVP section)
 * @internal
 */

import { v5 as uuidv5 } from "uuid";

/**
 * Stable namespace UUID for Cogni thread derivation.
 * Per RFC 4122: namespace UUID for generating v5 UUIDs.
 * This is a fixed value that should never change.
 */
const COGNI_THREAD_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

/**
 * Thread metadata stored with the thread.
 * Preserves original identifiers for traceability.
 */
export interface ThreadMetadata {
  readonly billingAccountId: string;
  readonly stateKey: string;
}

/**
 * Derive deterministic thread UUID from billing account and thread key.
 *
 * Per THREAD_ID_IS_UUID: LangGraph API requires `thread_id` as UUID format.
 * Per THREAD_ID_TENANT_SCOPED: Uses billingAccountId as tenant isolation.
 *
 * @param billingAccountId - Tenant identifier
 * @param stateKey - Thread identifier within tenant (or runId for ephemeral)
 * @returns UUIDv5 derived from inputs
 */
export function deriveThreadUuid(
  billingAccountId: string,
  stateKey: string
): string {
  const input = `${billingAccountId}:${stateKey}`;
  return uuidv5(input, COGNI_THREAD_NAMESPACE);
}

/**
 * Build thread metadata for storage with thread.
 *
 * @param billingAccountId - Tenant identifier
 * @param stateKey - Thread identifier
 * @returns Metadata object for thread creation
 */
export function buildThreadMetadata(
  billingAccountId: string,
  stateKey: string
): ThreadMetadata {
  return {
    billingAccountId,
    stateKey,
  };
}
