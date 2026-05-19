// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel. Detects the parent app's theme by observing `<html class="dark">`
 *   directly (single source of truth, works through Sheet/Dialog portals where
 *   useTheme context can be unreliable) and passes the result into the shell.
 * Scope: Pure presentation. `sandbox=""` disables scripts, popups, form submission,
 *   and same-origin access — untrusted content cannot reach parent cookies or DOM.
 * Links: docs/spec/knowledge-html-style.md
 * @internal
 */

"use client";

import { type ReactElement, useEffect, useState } from "react";
import { buildHtmlShell, type RenderTheme } from "./htmlShell";

interface HtmlRendererProps {
  readonly html: string;
  readonly title: string;
}

function detectTheme(): RenderTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function HtmlRenderer({ html, title }: HtmlRendererProps): ReactElement {
  const [theme, setTheme] = useState<RenderTheme>("dark");

  useEffect(() => {
    setTheme(detectTheme());
    const obs = new MutationObserver(() => setTheme(detectTheme()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

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
