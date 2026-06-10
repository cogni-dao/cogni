// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/RepoStep.client`
 * Purpose: "Create node repo PR" step with first-class async feedback.
 * Scope: POSTs the unchanged publish endpoint; while pending, shows a labeled phase checklist,
 *   an elapsed timer, and an up-front time expectation — replacing the silent disabled button.
 *   Optimistic phases advance on a timer and reconcile to the real PR on completion.
 * Side-effects: IO (POST /api/v1/nodes/:id/publish), React state, router.refresh
 * Links: src/app/api/v1/nodes/[id]/publish/route.ts, src/features/nodes/wizard/PhaseList.tsx
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { Button, SectionCard } from "@/components";

import { type Phase, PhaseList } from "../PhaseList";
import type { WizardStepProps } from "../types";

const PUBLISH_PHASES: readonly string[] = [
  "Forking node-template",
  "Committing repo-spec identity",
  "Opening deployment PR",
];

/** Optimistic advance cadence (ms) — phases light up over the expected ~30–60s window. */
const PHASE_TICK_MS = 9000;

interface NodeActionErrorBody {
  readonly reason?: unknown;
  readonly error?: unknown;
  readonly errorCode?: unknown;
  readonly step?: unknown;
  readonly reqId?: unknown;
}

function formatActionError(body: NodeActionErrorBody, status: number): string {
  const reason = typeof body.reason === "string" ? body.reason : null;
  const error = typeof body.error === "string" ? body.error : null;
  const errorCode =
    typeof body.errorCode === "string" ? `errorCode=${body.errorCode}` : null;
  const step = typeof body.step === "string" ? `step=${body.step}` : null;
  const reqId = typeof body.reqId === "string" ? `reqId=${body.reqId}` : null;
  const fields = [errorCode, step, reqId].filter(Boolean).join(" ");
  const prefix = reason ?? error ?? `HTTP ${status}`;
  return fields ? `${prefix} (${fields})` : prefix;
}

export function RepoStep({ node }: WizardStepProps): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  // Drive the optimistic phase + elapsed timer while the publish POST is in flight.
  useEffect(() => {
    if (!submitting) return;
    const tickPhase = window.setInterval(() => {
      setPhaseIdx((i) => Math.min(i + 1, PUBLISH_PHASES.length - 1));
    }, PHASE_TICK_MS);
    const tickClock = window.setInterval(() => {
      if (startedAt.current !== null) {
        setElapsed(Math.floor((performance.now() - startedAt.current) / 1000));
      }
    }, 1000);
    return () => {
      window.clearInterval(tickPhase);
      window.clearInterval(tickClock);
    };
  }, [submitting]);

  const handlePublish = async () => {
    setError(null);
    setSubmitting(true);
    setPhaseIdx(0);
    setElapsed(0);
    startedAt.current = performance.now();
    try {
      const res = await fetch(`/api/v1/nodes/${node.id}/publish`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(formatActionError(body, res.status));
        setSubmitting(false);
        return;
      }
      // Success: the row is now `published`; refresh morphs the shell to Handoff.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      setSubmitting(false);
    }
  };

  if (submitting) {
    const phases: Phase[] = PUBLISH_PHASES.map((label, i) => ({
      label,
      state: i < phaseIdx ? "done" : i === phaseIdx ? "active" : "pending",
    }));
    return (
      <SectionCard title="Creating node repo PR">
        <div className="space-y-5 py-2">
          <PhaseList phases={phases} />
          <p className="text-muted-foreground text-xs">
            This usually takes 30–60s. Elapsed {elapsed}s.
          </p>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Create node repo">
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Fork <code>node-template</code>, commit this node's identity, and open
          the operator deployment PR.
        </p>
        <Button onClick={handlePublish}>Create node repo PR</Button>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>
    </SectionCard>
  );
}
