// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/gates/types`
 * Purpose: Type contract for the knowledge write gate chain — the Dolt-side equivalent of CI/CD gates that decide whether a write may merge to trunk.
 * Scope: Pure type declarations + structured error class. Does not perform I/O, side effects, or any actual validation logic.
 * Invariants:
 *   - GATES_FAIL_CLOSED: a gate returns ok:false → write rejected at API/tool boundary.
 *   - CONFIDENCE_OUTSIDE_GATES: gates decide accept/reject only; they do not promote.
 * Side-effects: none
 * Links: work/projects/proj.knowledge-syntropy.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type { KnowledgeEntryInput } from "../contribution-schemas.js";

/**
 * Input to every gate — what the writer is asking the hub to accept.
 *
 * Mirrors `KnowledgeEntryInput` with the additional `sourceType` / `sourceRef`
 * fields that internal-tool writes carry. External contribution writes set
 * these via the adapter when materializing rows.
 */
export interface KnowledgeWriteCandidate extends KnowledgeEntryInput {
  readonly sourceType?: string;
  readonly sourceRef?: string;
}

/**
 * Why a gate rejected a candidate. Structured so HTTP layers can map to 400
 * field-by-field and tool layers can echo per-field guidance.
 */
export interface GateError {
  /** Gate identifier, e.g. "shape", "provenance". */
  readonly gate: string;
  /** Optional field name when the error is scoped to one field. */
  readonly field?: string;
  /** Machine-readable code, e.g. "slug_too_long". */
  readonly code: string;
  /** Human-readable message. */
  readonly message: string;
}

export type GateResult =
  | { readonly ok: true; readonly candidate: KnowledgeWriteCandidate }
  | { readonly ok: false; readonly errors: readonly GateError[] };

/**
 * Optional dependencies a gate may need. v0 gates are pure; v1+ AI gates will
 * receive an LLM + graph runner; later gates may receive a recall port.
 */
export interface GateContext {
  readonly _phantom?: never;
}

/**
 * A gate is a pure check: candidate in → result out. Side-effect-free.
 *
 * Gates may sanitize / normalize the candidate by returning a different
 * candidate in the `ok: true` branch (e.g. trimming whitespace) — downstream
 * gates and the store both see the sanitized form.
 */
export interface KnowledgeGate {
  readonly name: string;
  readonly tier: "v0" | "v1" | "v2";
  check(
    candidate: KnowledgeWriteCandidate,
    ctx: GateContext
  ): Promise<GateResult>;
}

/**
 * Thrown when a gate chain rejects a write. Carries the structured error list
 * so HTTP and tool layers can format their own responses.
 */
export class KnowledgeGateError extends Error {
  readonly errors: readonly GateError[];
  constructor(errors: readonly GateError[]) {
    super(
      `knowledge write rejected by ${errors.length} gate error(s): ${errors
        .map((e) => `${e.gate}.${e.field ?? "_"}=${e.code}`)
        .join(", ")}`
    );
    this.name = "KnowledgeGateError";
    this.errors = errors;
  }
}
