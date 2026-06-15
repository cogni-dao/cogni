// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/confidence-policy`
 * Purpose: Central confidence policy for knowledge writes and recomputes.
 * Scope: Pure domain policy. Does not perform I/O or own persistence.
 * Invariants:
 *   - CONFIDENCE_IS_POLICY: application writes initialize confidence explicitly.
 *   - DB_DEFAULT_IS_GUARDRAIL: database defaults are not normal write semantics.
 *   - DERIVED_CONFIDENCE_REQUIRES_BASIS: derived rows fail closed without cited confidence.
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import type { CitationType, NewKnowledge, SourceType } from "./schemas.js";

export const CONFIDENCE_POLICY_VERSION = "confidence-policy.v1.baseline";

export const BASELINE_CONFIDENCE_BY_SOURCE: Readonly<
  Record<Exclude<SourceType, "derived">, number>
> = {
  agent: 30,
  analysis_signal: 40,
  external: 50,
  human: 70,
};

const SUPPORT_BUMP = 10;
const SUPPORT_CAP = 50;
const CONTRADICT_PENALTY = 15;
const AGENT_PRINCIPAL_CAP = 30;
const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 100;

// Recompute operates on an already-persisted entry whose derivation basis is
// not re-presented as incoming citations, so derived rows recompute from a
// conservative base rather than re-deriving (initialize is where derived fails
// closed). Matches the pre-policy edo-resolver base.
const RECOMPUTE_DERIVED_BASE = 40;

export interface ConfidenceCitationBasis {
  readonly citationType: CitationType | string;
  readonly citedConfidencePct?: number | null;
}

export interface InitializeConfidenceContext {
  readonly principalKind?: "agent" | "user";
  readonly citations?: readonly ConfidenceCitationBasis[];
}

export interface ConfidenceDecision {
  readonly confidencePct: number;
  readonly policyVersion: string;
  readonly basis: string;
}

export class ConfidencePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfidencePolicyError";
  }
}

export function explainConfidence(decision: ConfidenceDecision): string {
  return `${decision.policyVersion}:${decision.basis}:${decision.confidencePct}`;
}

export function initializeConfidence(
  entry: Pick<NewKnowledge, "confidencePct" | "sourceType">,
  context: InitializeConfidenceContext = {}
): ConfidenceDecision {
  const explicit = explicitConfidence(entry.confidencePct);
  const raw =
    explicit ??
    (entry.sourceType === "derived"
      ? derivedConfidence(context.citations ?? [])
      : BASELINE_CONFIDENCE_BY_SOURCE[entry.sourceType]);

  return decision(applyPrincipalCap(raw, context), basisFor(entry, explicit));
}

export function recomputeConfidence(
  entry: Pick<NewKnowledge, "sourceType">,
  citations: readonly ConfidenceCitationBasis[]
): ConfidenceDecision {
  const initial =
    entry.sourceType === "derived"
      ? RECOMPUTE_DERIVED_BASE
      : BASELINE_CONFIDENCE_BY_SOURCE[entry.sourceType];

  let supportCount = 0;
  let contradictCount = 0;
  for (const c of citations) {
    if (isSupporting(c.citationType)) supportCount++;
    else if (isContradicting(c.citationType)) contradictCount++;
  }

  const supportBump = Math.min(SUPPORT_CAP, SUPPORT_BUMP * supportCount);
  const penalty = CONTRADICT_PENALTY * contradictCount;
  return decision(
    clampConfidence(initial + supportBump - penalty),
    `recompute:${entry.sourceType}:support=${supportCount}:contradict=${contradictCount}`
  );
}

export function assertWritableConfidence(
  value: unknown
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_CONFIDENCE ||
    value > MAX_CONFIDENCE
  ) {
    throw new ConfidencePolicyError(
      "confidencePct must be an integer from 0 to 100"
    );
  }
}

export function clampConfidence(value: number): number {
  return Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, value));
}

function explicitConfidence(value: number | null | undefined): number | null {
  if (value == null) return null;
  assertWritableConfidence(value);
  return value;
}

function derivedConfidence(
  citations: readonly ConfidenceCitationBasis[]
): number {
  if (citations.length === 0) {
    throw new ConfidencePolicyError(
      "derived confidence requires at least one cited confidence basis"
    );
  }
  const cited = citations.map((c) => c.citedConfidencePct);
  if (cited.some((v) => v == null)) {
    throw new ConfidencePolicyError(
      "derived confidence requires citedConfidencePct for every citation"
    );
  }
  const values = cited.map((v) => {
    assertWritableConfidence(v);
    return v;
  });
  return Math.min(...values);
}

function applyPrincipalCap(
  value: number,
  context: InitializeConfidenceContext
): number {
  return context.principalKind === "agent"
    ? Math.min(value, AGENT_PRINCIPAL_CAP)
    : value;
}

function basisFor(
  entry: Pick<NewKnowledge, "confidencePct" | "sourceType">,
  explicit: number | null
): string {
  if (explicit != null) return `explicit:${entry.sourceType}`;
  return entry.sourceType === "derived"
    ? "derived:min-cited-confidence"
    : `baseline:${entry.sourceType}`;
}

function decision(confidencePct: number, basis: string): ConfidenceDecision {
  return {
    confidencePct: clampConfidence(confidencePct),
    policyVersion: CONFIDENCE_POLICY_VERSION,
    basis,
  };
}

function isSupporting(citationType: string): boolean {
  return (
    citationType === "supports" ||
    citationType === "validates" ||
    citationType === "evidence_for" ||
    citationType === "extends"
  );
}

function isContradicting(citationType: string): boolean {
  return citationType === "contradicts" || citationType === "invalidates";
}
