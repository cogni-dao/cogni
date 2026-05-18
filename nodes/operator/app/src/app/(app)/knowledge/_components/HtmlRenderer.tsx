// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel (cf. Anthropic Artifacts: HTML-as-default for human-facing content).
 * Scope: Pure presentation. `sandbox=""` disables scripts, popups, form submission,
 *   and same-origin access — untrusted content cannot reach parent cookies or DOM.
 *   Authoring contract: `html` is a self-contained HTML document (or fragment);
 *   author owns its styles. Renderer adds no wrap.
 * @internal
 */

"use client";

import type { ReactElement } from "react";

interface HtmlRendererProps {
  readonly html: string;
  readonly title: string;
}

export function HtmlRenderer({
  html,
  title,
}: HtmlRendererProps): ReactElement {
  return (
    <iframe
      title={title}
      srcDoc={html}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-[var(--height-artifact-canvas)] w-full rounded-md border border-border bg-[var(--bg-artifact-canvas)]"
    />
  );
}
