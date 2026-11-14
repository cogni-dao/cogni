// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts/validation`
 * Purpose: Evaluation write validation — asserts required fields, descriptor parity, and payload schema validity.
 * Scope: Pure functions. Does not perform I/O or hold state.
 * Invariants:
 * - EVALUATION_WRITE_VALIDATED: every evaluation write must include required refs and parse against the descriptor output schema.
 * - FRAMEWORK_NO_IO: this module contains zero I/O.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import type { EnricherDescriptor, EnricherEvaluationResult } from "./enricher";

/**
 * Validate that an evaluation result has all required fields populated,
 * matches the descriptor refs, and parses against the descriptor schema.
 * Throws on first mismatch.
 *
 * EVALUATION_WRITE_VALIDATED: every evaluation write includes
 * evaluationRef, algoRef, inputsHash, schemaRef, payloadHash, and schema-valid payloadJson.
 */
export function validateEvaluationWrite(
  descriptor: EnricherDescriptor,
  result: EnricherEvaluationResult
): void {
  const requiredStringFields: ReadonlyArray<
    keyof Pick<
      EnricherEvaluationResult,
      | "evaluationRef"
      | "algoRef"
      | "schemaRef"
      | "inputsHash"
      | "payloadHash"
      | "nodeId"
    >
  > = [
    "evaluationRef",
    "algoRef",
    "schemaRef",
    "inputsHash",
    "payloadHash",
    "nodeId",
  ];

  for (const field of requiredStringFields) {
    const value = result[field];
    if (!value || value.length === 0) {
      throw new Error(
        `Evaluation write validation failed: "${field}" is required but was ${value === "" ? "empty" : "missing"}`
      );
    }
  }

  if (result.status !== "draft" && result.status !== "locked") {
    throw new Error(
      `Evaluation write validation failed: "status" must be "draft" or "locked", got "${String(result.status)}"`
    );
  }

  if (result.evaluationRef !== descriptor.evaluationRef) {
    throw new Error(
      `Evaluation write validation failed: evaluationRef "${result.evaluationRef}" does not match descriptor "${descriptor.evaluationRef}"`
    );
  }

  if (result.algoRef !== descriptor.algoRef) {
    throw new Error(
      `Evaluation write validation failed: algoRef "${result.algoRef}" does not match descriptor "${descriptor.algoRef}"`
    );
  }

  if (result.schemaRef !== descriptor.schemaRef) {
    throw new Error(
      `Evaluation write validation failed: schemaRef "${result.schemaRef}" does not match descriptor "${descriptor.schemaRef}"`
    );
  }

  descriptor.outputSchema.parse(result.payloadJson);
}
