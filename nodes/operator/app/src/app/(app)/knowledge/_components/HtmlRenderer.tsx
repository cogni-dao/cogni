// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel. Reads theme via next-themes (the sanctioned ThemeProvider path)
 *   and passes the result into the shell so the artifact matches the parent.
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
  const { resolvedTheme, theme: themePref, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // next-themes priority: resolvedTheme (final answer) → theme (user choice,
  // may be "system") → systemTheme (OS preference). Before mount everything is
  // undefined; default to "dark" to avoid a light-on-dark flash on the operator's
  // dark canvas page. After mount, anything other than explicit "dark" wins as light.
  let theme: RenderTheme = "dark";
  if (mounted) {
    const effective = resolvedTheme ?? themePref ?? systemTheme;
    theme = effective === "dark" ? "dark" : "light";
  }

  return (
    <iframe
      key={theme}
      title={title}
      srcDoc={buildHtmlShell(html, title, theme)}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-[var(--height-artifact-canvas)] w-full rounded-md border border-border bg-background"
    />
  );
}
