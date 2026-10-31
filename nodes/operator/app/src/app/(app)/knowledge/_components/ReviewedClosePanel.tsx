// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ReviewedClosePanel`
 * Purpose: Preview exact reviewed heads and close eligible proposals with one explicit action.
 * Scope: Operator session UI; serial existing close requests, never a new auth system.
 * Invariants: NO_WRITE_BEFORE_CLICK, FREEZE_RUN_SELECTION, READBACK_BEFORE_SUCCESS.
 * Side-effects: IO (authenticated contribution reads and explicit guarded closes)
 * @internal
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components";
import {
  closeContribution,
  ReviewedCloseError,
} from "../_api/closeContribution";
import {
  isReviewedCloseEligible,
  loadReviewedClose,
  parseReviewedClose,
  type ReviewedCloseRow,
} from "../_api/reviewedClose";

type CloseAttempt =
  | { phase: "waiting" | "closing" | "complete" }
  | { phase: "failed"; message: string };

/** Server observations own current status; an attempt is only local history. */
function currentStatus(row: ReviewedCloseRow, attempt?: CloseAttempt): string {
  if (row.error) return row.error;
  if (row.record?.state === "closed")
    return attempt && attempt.phase !== "waiting"
      ? "Verified closed"
      : "Already closed; excluded";
  if (row.record?.state === "merged") return "Already merged; excluded";
  if (!isReviewedCloseEligible(row)) return "Changed since review; excluded";
  if (attempt?.phase === "closing") return "Closing…";
  if (attempt?.phase === "waiting") return "Not attempted";
  return "Ready to close";
}

export function ReviewedClosePanel({ value }: { readonly value: string }) {
  const queryClient = useQueryClient();
  const [selection] = useState(() => {
    try {
      return parseReviewedClose(value);
    } catch {
      return null;
    }
  });
  const [rows, setRows] = useState<ReviewedCloseRow[]>([]);
  const [attempts, setAttempts] = useState<Record<string, CloseAttempt>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readRequest, setReadRequest] = useState({ selection });
  const mounted = useRef(true);
  // The ref closes the same-event double-click window before React rerenders.
  const running = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!readRequest.selection) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadReviewedClose(readRequest.selection, () => !cancelled).then(
      (next) => {
        if (!cancelled) {
          setRows(next);
          setLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [readRequest]);

  if (!selection)
    return (
      <section role="alert" className="rounded-lg border p-4">
        Invalid review link. No proposals will be closed.
      </section>
    );
  const eligible = rows.filter(isReviewedCloseEligible);

  const refreshResults = () => {
    // Refresh the shared dashboard table/count as well as this private preview.
    // Partial and unmounted runs must reconcile the same cache as single-close.
    void queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    if (mounted.current) {
      setLoading(true);
      setReadRequest({ selection });
    }
  };

  const run = async () => {
    if (running.current || loading) return;
    running.current = true;
    setBusy(true);
    // Freeze the clicked preview. A new URL remounts this panel and stops future calls.
    const pending = [...eligible];
    setAttempts((prior) => ({
      ...prior,
      ...Object.fromEntries(
        pending.map((row) => [
          row.item.contributionId,
          { phase: "waiting" as const },
        ])
      ),
    }));
    try {
      for (const row of pending) {
        if (!mounted.current) break;
        try {
          setAttempts((prior) => ({
            ...prior,
            [row.item.contributionId]: { phase: "closing" },
          }));
          const result = await closeContribution(
            row.item.contributionId,
            selection.reason,
            {
              expectedHeadCommit: row.item.expectedHeadCommit,
              stillActive: () => mounted.current,
            }
          );
          if (mounted.current) {
            // Use the helper's actual GET record, never synthesize a closed state.
            const record = result.record;
            if (record)
              setRows((prior) =>
                prior.map((current) =>
                  current.item.contributionId === row.item.contributionId
                    ? { item: current.item, record }
                    : current
                )
              );
            setAttempts((prior) => ({
              ...prior,
              [row.item.contributionId]: { phase: "complete" },
            }));
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Close could not be verified.";
          if (mounted.current)
            setAttempts((prior) => ({
              ...prior,
              [row.item.contributionId]: { phase: "failed", message },
            }));
          if (!(error instanceof ReviewedCloseError) || error.stopBatch) break;
        }
      }
    } finally {
      running.current = false;
      refreshResults();
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section
      aria-label="Reviewed proposal cleanup"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 className="font-semibold">Close reviewed proposals</h2>
      <p className="text-sm">
        Only open proposals with the reviewed head can close. Changed proposals
        are excluded.
      </p>
      <p className="text-sm">
        <strong>Reason:</strong> {selection.reason}
      </p>
      {loading && <output>Reading selected proposals…</output>}
      <ul className="flex flex-col gap-2 text-sm">
        {rows.map((row) => {
          const attempt = attempts[row.item.contributionId];
          // Retain relevant failure detail without letting history mask a newer
          // closed/merged/changed observation. Refresh itself never writes.
          const diagnostic =
            attempt?.phase === "failed" &&
            (isReviewedCloseEligible(row) || row.error)
              ? attempt.message
              : null;
          return (
            <li key={row.item.contributionId} className="flex flex-col gap-1">
              <Link
                className="underline"
                href={`/knowledge/inbox/${encodeURIComponent(row.item.contributionId)}`}
              >
                {row.record?.message ?? row.item.contributionId}
              </Link>
              <span>{currentStatus(row, attempt)}</span>
              {diagnostic && (
                <p className="text-muted-foreground">
                  Last attempt: <span>{diagnostic}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={loading || busy || eligible.length === 0}
          onClick={() => void run()}
        >
          {busy
            ? "Closing reviewed proposals…"
            : `Close ${eligible.length} reviewed proposals`}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={loading || busy}
          onClick={refreshResults}
        >
          Refresh results
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Each close is checked against server state. Refresh or reopen this link
        to recover; unresolved requests stop the remaining batch.
      </p>
    </section>
  );
}
