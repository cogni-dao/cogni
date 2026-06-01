// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/CopyLinkButton`
 * Purpose: One-click copy of a knowledge block's absolute permalink — the single
 *   artifact humans hand to the AI and the AI hands back. Resolves the given path
 *   against the live origin so the copied URL is clickable anywhere.
 * Scope: Pure presentation + clipboard write.
 * @internal
 */

"use client";

import { Check, Link2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components";

export function CopyLinkButton({
  path,
  label = "Copy link",
}: {
  /** App-relative path to the block, e.g. `/knowledge/<id>`. */
  readonly path: string;
  readonly label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const url =
      typeof window !== "undefined"
        ? new URL(path, window.location.origin).toString()
        : path;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context / denied) — no-op
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 gap-1.5"
      onClick={onCopy}
      aria-label={label}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Link2 className="size-3.5" />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}
