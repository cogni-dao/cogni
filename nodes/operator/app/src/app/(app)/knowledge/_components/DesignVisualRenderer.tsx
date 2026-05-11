// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/DesignVisualRenderer`
 * Purpose: Renders a knowledge entry's `content` body as a sandboxed HTML/SVG document
 *   when `entryType === 'design-visual'`. Used to surface hand-authored design diagrams
 *   (cf. delta-analyzer.html) directly inside the operator's /knowledge surface.
 * Scope: Pure presentation. The iframe `sandbox=""` attribute disables scripts, popups,
 *   form submission, same-origin access — the strongest isolation the platform offers,
 *   so untrusted content cannot reach the parent page or cookies.
 *
 *   Content authoring contract: `content` is a self-contained HTML document (or fragment).
 *   The renderer does NOT inject styles, so the document defines its own theme (mirrors the
 *   delta-analyzer.html pattern — full <style> block + SVG body). For bare SVG fragments,
 *   the browser falls back to user-agent defaults.
 * @internal
 */

"use client";

import type { ReactElement } from "react";

interface DesignVisualRendererProps {
  readonly content: string;
  readonly title: string;
}

export function DesignVisualRenderer({
  content,
  title,
}: DesignVisualRendererProps): ReactElement {
  return (
    <iframe
      title={title}
      srcDoc={content}
      sandbox=""
      className="h-[var(--height-design-visual)] w-full rounded-md border border-border bg-[var(--bg-design-visual-canvas)]"
    />
  );
}
