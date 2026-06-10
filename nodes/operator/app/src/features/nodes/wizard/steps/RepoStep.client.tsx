// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/RepoStep.client`
 * Purpose: "Create node repo PR" step with first-class async feedback.
 * Scope: POSTs the unchanged publish endpoint; while pending, shows a single labeled phase
 *   checklist (the only progress signal) that advances optimistically and reconciles to the real
 *   PR on completion. No separate elapsed counter.
 * Side-effects: IO (POST /api/v1/nodes/:id/publish), React state, router.refresh
 * Links: src/app/api/v1/nodes/[id]/publish/route.ts, src/features/nodes/wizard/PhaseList.tsx
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useState } from "react";

import { Button } from "@/components";

import { type Phase, PhaseList } from "../PhaseList";
import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

const PUBLISH_PHASES: readonly string[] = [
  "Forking node-template",
  "Committing repo-spec identity",
  "Opening deployment PR",
];

/** Optimistic advance cadence (ms) — the checklist walks forward while the POST is in flight. */
const PHASE_TICK_MS = 7000;

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

  // Walk the checklist forward while the publish POST is in flight.
  useEffect(() => {
    if (!submitting) return;
    const tick = window.setInterval(() => {
      setPhaseIdx((i) => Math.min(i + 1, PUBLISH_PHASES.length - 1));
    }, PHASE_TICK_MS);
    return () => window.clearInterval(tick);
  }, [submitting]);

  const handlePublish = async () => {
    setError(null);
    setSubmitting(true);
    setPhaseIdx(0);
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
      <StepSection title="Creating node repo PR">
        <PhaseList phases={phases} />
      </StepSection>
    );
  }

  return (
    <StepSection title="Create node repo">
      <p className="text-muted-foreground text-sm">
        Fork <code>node-template</code>, commit this node's identity, and open
        the operator deployment PR.
      </p>
      <Button onClick={handlePublish}>Create node repo PR</Button>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </StepSection>
  );
}
