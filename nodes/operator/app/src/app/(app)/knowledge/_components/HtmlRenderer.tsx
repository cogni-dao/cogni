// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel. Reads the parent app's resolved theme (next-themes) and passes it
 *   into the iframe shell so the artifact tracks light/dark.
 * Scope: Pure presentation. `sandbox=""` disables scripts, popups, form submission,
 *   and same-origin access — untrusted content cannot reach parent cookies or DOM.
 * Links: docs/spec/knowledge-html-style.md
 * @internal
 */

"use client";

import { useTheme } from "next-themes";
import { type ReactElement, useEffect, useState } from "react";
import { buildHtmlShell, type RenderTheme } from "./htmlShell";

interface HtmlRendererProps {
  readonly html: string;
  readonly title: string;
}

export function HtmlRenderer({ html, title }: HtmlRendererProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Pre-hydration the parent theme is unknown; default to dark to avoid a
  // light-bg flash on the typical dark-canvas /knowledge page.
  const theme: RenderTheme =
    mounted && resolvedTheme === "light" ? "light" : "dark";

  return (
    <iframe
      title={title}
      srcDoc={buildHtmlShell(html, title, theme)}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-[var(--height-artifact-canvas)] w-full rounded-md border border-border bg-[var(--bg-artifact-canvas)]"
    />
  );
}
