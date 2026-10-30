// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/LaunchPackCopyButton.client`
 * Purpose: Launch prompt copy affordance for the node wizard handoff. Fetches the canonical
 *   v2 launch pack at click time, validates it, and copies the prompt to the clipboard.
 * Scope: Client clipboard action only.
 * Links: src/features/nodes/launch-pack.ts, src/features/nodes/wizard/steps/HandoffStep.client.tsx
 * @public
 */

"use client";

import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "@/components";
import type { ButtonProps } from "@/components/kit/inputs/Button";
import { nodeLaunchPackV2Operation } from "@/contracts/nodes.launch-pack.v2.contract";

interface Props {
  readonly nodeId: string;
  readonly variant?: ButtonProps["variant"];
  readonly size?: ButtonProps["size"];
  readonly className?: string;
  readonly label?: string;
}

export function LaunchPackCopyButton({
  nodeId,
  variant = "outline",
  size = "sm",
  className,
  label = "Copy agent prompt",
}: Props): ReactElement {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copyLaunchPrompt = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/nodes/${nodeId}/launch-pack/v2`);
      if (!res.ok) return;
      const pack = nodeLaunchPackV2Operation.output.safeParse(await res.json());
      if (!pack.success) return;
      await navigator.clipboard.writeText(pack.data.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className ?? "gap-2"}
      disabled={busy}
      aria-label="Copy launch prompt"
      title="Copy launch prompt"
      onClick={copyLaunchPrompt}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}
