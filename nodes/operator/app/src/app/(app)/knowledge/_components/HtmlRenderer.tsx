// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel (cf. Anthropic Artifacts: HTML-as-default for human-facing content).
 *   Wraps content in the shell from `htmlShell.ts` so author fragments inherit
 *   operator-app tokens + `.cogni-*` utilities. Full-document content
 *   (`<!doctype>` / `<html>`) passes through verbatim for backward compat.
 * Scope: Pure presentation. `sandbox=""` disables scripts, popups, form submission,
 *   and same-origin access — untrusted content cannot reach parent cookies or DOM.
 * Links: docs/spec/knowledge-html-style.md
 * @internal
 */

"use client";

import type { ReactElement } from "react";
import { buildHtmlShell } from "./htmlShell";

interface HtmlRendererProps {
  readonly html: string;
  readonly title: string;
}

export function HtmlRenderer({ html, title }: HtmlRendererProps): ReactElement {
  return (
    <iframe
      title={title}
      srcDoc={buildHtmlShell(html, title)}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-[var(--height-artifact-canvas)] w-full rounded-md border border-border bg-[var(--bg-artifact-canvas)]"
    />
  );
}
