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
 * @internal
 */

"use client";

import type { ReactElement } from "react";

interface DesignVisualRendererProps {
  readonly content: string;
  readonly title: string;
}

function wrap(body: string, title: string): string {
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapedTitle}</title>
<style>
  :root {
    --bg: #0a0e0c;
    --fg: #d8e0db;
    --dim: #6b7770;
    --line: #2a3530;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 16px;
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  }
  svg { max-width: 100%; height: auto; display: block; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function DesignVisualRenderer({
  content,
  title,
}: DesignVisualRendererProps): ReactElement {
  return (
    <iframe
      title={title}
      srcDoc={wrap(content, title)}
      sandbox=""
      className="h-[640px] w-full rounded-md border border-border bg-[#0a0e0c]"
    />
  );
}
