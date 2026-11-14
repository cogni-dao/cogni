// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts/enricher`
 * Purpose: Enricher plugin contracts — descriptor (pure data) and adapter (port interface).
 * Scope: Types and interfaces only. Does not perform I/O or contain side effects.
 * Invariants:
 * - ENRICHER_DESCRIPTOR_PURE: descriptors contain only constants and pure functions.
 * - EVALUATION_WRITE_VALIDATED: every evaluation write includes evaluationRef, algoRef, inputsHash, schemaRef, payloadHash.
 * - FRAMEWORK_NO_IO: this module contains zero I/O.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import type {
  EvaluationStore,
  SelectionReader,
} from "@cogni/attribution-ledger";
import type { ZodType } from "zod";

/**
 * Pure data describing an enricher plugin.
 * Contains only constants — no I/O, no methods.
 * Payload builder functions are exported alongside as named exports in the plugin module.
 */
export interface EnricherDescriptor {
  /** Namespaced evaluation ref (e.g., "cogni.echo.v0"). */
  readonly evaluationRef: string;

  /** Algorithm ref for this enricher (e.g., "echo-v0"). */
  readonly algoRef: string;

  /**
   * Schema ref identifying the payload shape version.
   * Stored on every evaluation write for forward compatibility.
   * Format: "<evaluationRef>/<semver>" (e.g., "cogni.echo.v0/1.0.0").
   */
  readonly schemaRef: string;

  /** Runtime schema for payloadJson emitted by this enricher. */
  readonly outputSchema: ZodType<Record<string, unknown>>;
}

/**
 * Minimal logger interface for enricher adapters.
 * Matches Pino's core API shape without importing it.
 */
export interface EnricherLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Dependency-injection context passed to enricher adapters.
 * All I/O dependencies are injected — adapters never reach for globals.
 */
export interface EnricherContext {
  readonly epochId: bigint;
  readonly nodeId: string;
  /** Scoped store view for enrichers: evaluation reads/writes + read-only selection queries. */
  readonly attributionStore: EvaluationStore & SelectionReader;
  readonly logger: EnricherLogger;
  /** User-provided config parsed from .cogni/attribution/<profileId>.yaml, or null. */
  readonly profileConfig: Record<string, unknown> | null;
}

/**
 * Result returned by an enricher adapter's evaluateDraft() or buildLocked().
 * Contains all fields needed to write an evaluation row.
 */
export interface EnricherEvaluationResult {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly evaluationRef: string;
  readonly status: "draft" | "locked";
  readonly algoRef: string;
  readonly schemaRef: string;
  readonly inputsHash: string;
  readonly payloadHash: string;
  readonly payloadJson: Record<string, unknown>;
}

/**
 * Port interface for enricher plugin implementations.
 * Defined in the framework package; implemented in the plugins package.
 */
export interface EnricherAdapter {
  /** Descriptor and schema for this enricher. */
  readonly descriptor: EnricherDescriptor;

  /**
   * Produce a draft evaluation for the given epoch.
   * Called during the enrichment phase (epoch is open).
   * May perform I/O: read from the scoped store view, call external APIs, invoke LLMs.
   */
  evaluateDraft(ctx: EnricherContext): Promise<EnricherEvaluationResult>;

  /**
   * Produce a locked (final) evaluation for epoch close.
   * Called during closeIngestion. Same contract as evaluateDraft but
   * returns status='locked'. The caller writes atomically.
   */
  buildLocked(ctx: EnricherContext): Promise<EnricherEvaluationResult>;
}

/** Registry mapping evaluationRef → EnricherAdapter. */
export type EnricherAdapterRegistry = ReadonlyMap<string, EnricherAdapter>;
