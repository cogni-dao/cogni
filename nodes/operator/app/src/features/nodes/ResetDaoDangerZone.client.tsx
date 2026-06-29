// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/ResetDaoDangerZone.client`
 * Purpose: Owner-only destructive control to reset a node's DAO record so a fresh DAO can be re-formed.
 * Scope: Renders a "Danger zone" card with a typed confirmation guard; POSTs to the owner-only
 *   reset-dao route and refreshes the server page on success so the wizard returns to the DAO step.
 * Side-effects: IO (POST reset-dao route, router.refresh)
 * Links: src/app/api/v1/nodes/[id]/reset-dao/route.ts, src/app/(app)/nodes/[id]/page.tsx
 * @public
 */

"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@/components";

interface Props {
  readonly nodeId: string;
  readonly slug: string;
}

export function ResetDaoDangerZone({ nodeId, slug }: Props): ReactElement {
  const router = useRouter();
  const expected = `clear ${slug} dao`;
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = confirm === expected;

  const handleReset = async () => {
    if (!matches || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/nodes/${nodeId}/reset-dao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      if (!response.ok) {
        const text = await response.text();
        let reason = `HTTP ${response.status}`;
        try {
          const parsed: unknown = JSON.parse(text);
          if (
            parsed &&
            typeof parsed === "object" &&
            "error" in parsed &&
            typeof (parsed as { error: unknown }).error === "string"
          ) {
            reason = (parsed as { error: string }).error;
          }
        } catch {
          if (text.trim() !== "") {
            reason = text;
          }
        }
        throw new Error(reason);
      }
      setConfirm("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-5" />
          Danger zone — reset DAO
        </CardTitle>
        <CardDescription>
          Resetting clears this node's DAO record so you can re-form a fresh
          DAO. It does not touch the deployment repo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder={expected}
          aria-label="Reset DAO confirmation"
          spellCheck={false}
          autoComplete="off"
        />
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <Button
          type="button"
          variant="destructive"
          onClick={handleReset}
          disabled={!matches || submitting}
          className="gap-2"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          Reset DAO
        </Button>
      </CardContent>
    </Card>
  );
}
