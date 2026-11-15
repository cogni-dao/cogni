// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/stop-plan`
 * Purpose: The pure decision behind `DELETE /api/v1/deploy/workloads` (task.5491): may this workload be
 *   stopped now, and with which destroy? The route reads the rows and records the answer; the sequencer
 *   closes the leases.
 * Scope: Pure. No IO. The route passes the workload's release kind, its attempts and its consumers.
 * Invariants:
 *   - RETAINED_STATE_NEEDS_A_DESTROY: a `state` workload with an open lease is stopped only by a
 *     destroy: `destroyRetainedData` plus a `dseq` that equals one of its open leases.
 *   - OPEN_MEANS_NOT_TERMINAL: terminal phases are `failed`, `retired` and `lost`; every other phase is
 *     open. A `lost` lease is confirmed closed by `reconcile` before the phase is written.
 *   - NO_HANDLE_MEANS_WAIT: a `state` attempt with no lease id yet may own a lease the sequencer has not
 *     bound; a stop waits (409) until the handle exists.
 *   - APP_NEEDS_NO_CONFIRMATION: an app lease holds no retained data; the flag on an app is refused.
 * Side-effects: none
 * @public
 */

import type { AttemptPhase } from "@/ports";

/** Phases that own no open lease. */
export const TERMINAL_ATTEMPT_PHASES: readonly AttemptPhase[] = [
  "failed",
  "retired",
  "lost",
];

export type StopRefusal =
  | "workload_not_retained"
  | "retained_state_requires_destroy"
  | "dseq_mismatch"
  | "state_create_in_flight"
  | "state_in_use";

export type StopPlan =
  | { readonly ok: true; readonly destroyDseq?: string | undefined }
  | { readonly ok: false; readonly refusal: StopRefusal };

export function planStop(input: {
  readonly kind: "app" | "state";
  readonly attempts: readonly {
    readonly phase: AttemptPhase;
    readonly externalName?: string | undefined;
  }[];
  readonly consumers: readonly string[];
  readonly destroyRetainedData?: true | undefined;
  readonly dseq?: string | undefined;
}): StopPlan {
  const confirmed = input.destroyRetainedData === true;
  if (input.kind === "app")
    return confirmed
      ? { ok: false, refusal: "workload_not_retained" }
      : { ok: true };
  const open = input.attempts.filter(
    (a) => !TERMINAL_ATTEMPT_PHASES.includes(a.phase)
  );
  if (open.some((a) => !a.externalName))
    return { ok: false, refusal: "state_create_in_flight" };
  if (open.length === 0)
    return confirmed ? { ok: false, refusal: "dseq_mismatch" } : { ok: true };
  if (!confirmed)
    return { ok: false, refusal: "retained_state_requires_destroy" };
  if (!open.some((a) => a.externalName === input.dseq))
    return { ok: false, refusal: "dseq_mismatch" };
  if (input.consumers.length > 0) return { ok: false, refusal: "state_in_use" };
  return { ok: true, destroyDseq: input.dseq };
}
