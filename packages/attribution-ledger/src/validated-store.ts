// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/validated-store`
 * Purpose: Thin wrapper around AttributionStore that enforces validateEvaluationEnvelope at write time.
 * Scope: Wraps store methods. Does not contain business logic beyond validation.
 * Invariants:
 * - ENVELOPE_VALIDATED_ON_WRITE: All evaluation writes pass through validateEvaluationEnvelope.
 * Side-effects: none (delegates to inner store)
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import { validateEvaluationEnvelope } from "./artifact-envelope";
import type {
  AttributionStore,
  CloseIngestionWithEvaluationsParams,
  UpsertEvaluationParams,
} from "./store";

/**
 * Wrap an AttributionStore with envelope validation on evaluation writes.
 * Uses Proxy to properly delegate all method calls — object spread drops
 * prototype methods on class instances (e.g. DrizzleAttributionAdapter).
 */
export function createValidatedAttributionStore(
  inner: AttributionStore
): AttributionStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "upsertDraftEvaluation") {
        return async (params: UpsertEvaluationParams) => {
          validateEvaluationEnvelope(params);
          return target.upsertDraftEvaluation(params);
        };
      }
      if (prop === "closeIngestionWithEvaluations") {
        return async (params: CloseIngestionWithEvaluationsParams) => {
          for (const e of params.evaluations) {
            validateEvaluationEnvelope(e);
          }
          return target.closeIngestionWithEvaluations(params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
