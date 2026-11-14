// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts/allocator`
 * Purpose: Allocator plugin contracts and dispatch logic.
 * Scope: Types and pure dispatch function. Does not perform I/O or hold state.
 * Invariants:
 * - ALLOCATOR_NEEDS_DECLARED: requiredEvaluationRefs validated before compute().
 * - ALLOCATION_CONTEXT_EXTENSIBLE: context grows by adding optional fields, never by changing compute() signature.
 * - FRAMEWORK_NO_IO: this module contains zero I/O.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import type {
  ReceiptForWeighting,
  ReceiptUnitWeight,
} from "@cogni/attribution-ledger";
import type { ZodType } from "zod";

/**
 * Descriptor for an allocation algorithm plugin.
 */
export interface AllocatorDescriptor {
  /** Algorithm ref (matches what gets pinned on epoch at closeIngestion). */
  readonly algoRef: string;

  /**
   * Evaluation refs this allocator requires. Empty = no evaluations needed.
   * dispatchAllocator() validates all required refs are present before calling compute().
   */
  readonly requiredEvaluationRefs: readonly string[];

  /**
   * Compute per-receipt weight allocations.
   * Async to support future allocators that may need I/O (e.g., LLM-scored).
   * Deterministic allocators simply return a resolved promise.
   */
  readonly compute: (
    context: AllocationContext
  ) => Promise<ReceiptUnitWeight[]>;

  /** Runtime schema for allocator output. */
  readonly outputSchema: ZodType<ReceiptUnitWeight[]>;
}

/**
 * Context passed to allocator compute().
 * Receipt-scoped input — no userId, no claimant awareness.
 */
export interface AllocationContext {
  readonly receipts: readonly ReceiptForWeighting[];
  readonly weightConfig: Record<string, number>;
  /**
   * Locked evaluation payloads keyed by evaluationRef.
   * weight-sum-v0 ignores this; future allocators consume it.
   */
  readonly evaluations: ReadonlyMap<string, Record<string, unknown>>;
  /** User-provided config, or null if profile has no configSchema. */
  readonly profileConfig: Record<string, unknown> | null;
}

/** Registry mapping algoRef → AllocatorDescriptor. */
export type AllocatorRegistry = ReadonlyMap<string, AllocatorDescriptor>;

/**
 * Dispatch to an allocator by ref, validating required evaluations first.
 * Throws if allocator is unknown, required evaluations are missing,
 * or the allocator returns output that does not match its declared schema.
 */
export async function dispatchAllocator(
  registry: AllocatorRegistry,
  allocatorRef: string,
  context: AllocationContext
): Promise<ReceiptUnitWeight[]> {
  const descriptor = registry.get(allocatorRef);
  if (!descriptor) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown allocator: "${allocatorRef}". Available: [${available}]`
    );
  }

  // ALLOCATOR_NEEDS_DECLARED: validate required evaluations are present
  const missing = descriptor.requiredEvaluationRefs.filter(
    (ref) => !context.evaluations.has(ref)
  );
  if (missing.length > 0) {
    throw new Error(
      `Allocator "${allocatorRef}" requires evaluations [${missing.join(", ")}] but they are missing from context`
    );
  }

  return descriptor.outputSchema.parse(await descriptor.compute(context));
}
