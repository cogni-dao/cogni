// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/RepoStep.client`
 * Purpose: "Create your app" step — the single friendly confirm that spawns the node's codebase,
 *   knowledge hub, and deploy request. User-facing language (no fork/repo-spec/PR jargon).
 * Scope: POSTs the unchanged publish endpoint; while pending, shows one labeled phase checklist
 *   that advances optimistically and reconciles to the real result on completion.
 * Side-effects: IO (POST /api/v1/nodes/:id/publish), React state, router.refresh
 * Links: src/app/api/v1/nodes/[id]/publish/route.ts, src/features/nodes/wizard/PhaseList.tsx
 * @public
 */

"use client";

import { BookOpen, Package, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useState } from "react";

import { Button } from "@/components";

import { type Phase, PhaseList } from "../PhaseList";
import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

const WHAT_YOU_GET: ReadonlyArray<{
  Icon: typeof Package;
  title: string;
  detail: string;
}> = [
  {
    Icon: Package,
    title: "Your codebase",
    detail: "forked from our template, ready to run",
  },
  {
    Icon: BookOpen,
    title: "Your knowledge hub",
    detail: "a Dolt database your node learns into",
  },
  {
    Icon: Rocket,
    title: "A deploy request",
    detail: "so Cogni can take it live when you're ready",
  },
];

/** User-facing checklist labels — advance optimistically while the POST is in flight. */
const SPAWN_PHASES: readonly string[] = [
  "Creating your codebase",
  "Setting up your knowledge hub",
  "Preparing your deploy request",
];

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

  useEffect(() => {
    if (!submitting) return;
    const tick = window.setInterval(() => {
      setPhaseIdx((i) => Math.min(i + 1, SPAWN_PHASES.length - 1));
    }, PHASE_TICK_MS);
    return () => window.clearInterval(tick);
  }, [submitting]);

  const handleSpawn = async () => {
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
    const phases: Phase[] = SPAWN_PHASES.map((label, i) => ({
      label,
      state: i < phaseIdx ? "done" : i === phaseIdx ? "active" : "pending",
    }));
    return (
      <StepSection title="Spawning your node">
        <PhaseList phases={phases} />
      </StepSection>
    );
  }

  return (
    <StepSection title="Create your app">
      <p className="text-muted-foreground text-sm">
        This sets up everything your node needs:
      </p>
      <ul className="space-y-3">
        {WHAT_YOU_GET.map(({ Icon, title, detail }) => (
          <li key={title} className="flex items-start gap-3">
            <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
            <span className="text-sm">
              <span className="font-medium text-foreground">{title}</span>{" "}
              <span className="text-muted-foreground">— {detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        Less than a minute. Nothing's public yet — just click the button.
      </p>
      <Button onClick={handleSpawn} size="lg">
        Spawn node
      </Button>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </StepSection>
  );
}
