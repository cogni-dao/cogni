// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/[id]/LaunchPackCopyButton.client`
 * Purpose: Icon-only launch prompt copy affordance for the node wizard after
 *   publish. Fetches the canonical launch pack at click time.
 * Scope: Client clipboard action only.
 * Links: src/features/nodes/launch-pack.ts
 * @public
 */

"use client";

import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "@/components";

interface LaunchPackResponse {
  readonly prompt: string;
}

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
      const pack = (await res.json()) as LaunchPackResponse;
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
      className="h-9 w-9 px-0"
      disabled={busy}
      aria-label="Copy launch prompt"
      title="Copy launch prompt"
      onClick={copyLaunchPrompt}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}
