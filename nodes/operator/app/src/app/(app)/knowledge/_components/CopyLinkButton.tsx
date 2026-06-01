// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/CopyLinkButton`
 * Purpose: Tiny icon-only affordance that copies a knowledge block's absolute
 *   permalink — the single artifact humans hand to the AI and the AI hands back.
 *   Resolves the given path against the live origin so the copied URL is clickable
 *   anywhere. Hover tooltip via `title`; stops propagation so it can live inside a
 *   clickable list row without triggering row navigation.
 * Scope: Pure presentation + clipboard write.
 * @internal
 */

"use client";

import { Check, Link2 } from "lucide-react";
import { type MouseEvent, useState } from "react";

export function CopyLinkButton({
  path,
  label = "Copy link",
}: {
  /** App-relative path to the block, e.g. `/knowledge/<id>`. */
  readonly path: string;
  readonly label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
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
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied!" : label}
      aria-label={label}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Link2 className="size-3.5" />
      )}
    </button>
  );
}
