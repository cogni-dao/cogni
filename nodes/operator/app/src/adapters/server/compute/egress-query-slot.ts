// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `egress-query-slot`
 * Purpose: One nonwaiting feature slot on an EXISTING client. Cancel is a request, never settlement.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: None at import; explicit callers own lifecycle.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
import type postgres from "postgres";

export class EgressQuerySlot {
  private owned = false;
  private stopped = false;
  private cancelCurrent: (() => void) | undefined;
  get busy(): boolean {
    return this.owned;
  }

  stop(): void {
    this.stopped = true;
    this.cancelCurrent?.();
  }

  run<T extends readonly postgres.MaybeRow[]>(
    create: (deadlineAt: number) => postgres.PendingQuery<T>
  ): Promise<postgres.RowList<T>> {
    if (this.stopped) return Promise.reject(new Error("egress_query_stopped"));
    if (this.owned) return Promise.reject(new Error("egress_query_busy"));
    this.owned = true;
    const deadlineAt = Date.now() + 100;
    let query: postgres.PendingQuery<T>;
    try {
      query = create(deadlineAt);
    } catch (error) {
      this.owned = false;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const cancel = () => {
        if (timedOut) return;
        timedOut = true;
        reject(
          new Error(
            this.stopped ? "egress_query_stopped" : "egress_query_deadline"
          )
        );
        try {
          query.cancel();
        } catch {
          /* Keep the slot until the original promise settles. */
        }
      };
      this.cancelCurrent = cancel;
      const timer = setTimeout(cancel, Math.max(0, deadlineAt - Date.now()));
      // .then submits postgres' lazy query. No reserve/onexecute/alternate promise owns cleanup.
      void query
        .then(
          (value) => {
            if (!timedOut && Date.now() >= deadlineAt)
              reject(new Error("egress_query_deadline"));
            else if (!timedOut) resolve(value);
          },
          (error) => {
            if (!timedOut) reject(error);
          }
        )
        .finally(() => {
          clearTimeout(timer);
          this.cancelCurrent = undefined;
          this.owned = false;
        });
    });
  }
}
