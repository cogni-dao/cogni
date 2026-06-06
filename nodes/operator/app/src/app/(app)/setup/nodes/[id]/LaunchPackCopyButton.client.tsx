// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/[id]/LaunchPackCopyButton.client`
 * Purpose: Launch prompt copy affordance for the node wizard after publish.
 *   Fetches the canonical launch pack at click time.
 * Scope: Client clipboard action only.
 * Links: src/features/nodes/launch-pack.ts
 * @public
 */

"use client";

import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "@/components";
import type { NodeLaunchPackOutput } from "@/contracts/nodes.launch-pack.v1.contract";

interface Props {
  readonly nodeId: string;
}

export function LaunchPackCopyButton({ nodeId }: Props): ReactElement {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copyLaunchPrompt = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/nodes/${nodeId}/launch-pack`);
      if (!res.ok) return;
      const pack = (await res.json()) as NodeLaunchPackOutput;
      await navigator.clipboard.writeText(pack.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-2"
      disabled={busy}
      aria-label="Copy launch prompt"
      title="Copy launch prompt"
      onClick={copyLaunchPrompt}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? "Copied" : "Copy agent prompt"}
    </Button>
  );
}
