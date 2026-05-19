// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/htmlShell`
 * Purpose: Build the sandboxed iframe `srcDoc` shell for `entryType=html` knowledge entries.
 *   Inlines operator app tokens + the small `.cogni-*` utility class set so authored content
 *   inherits app chrome without per-artifact palettes.
 * Scope: Pure string builders — no I/O, no React. Renderer consumes via `buildHtmlShell()`.
 * Invariants:
 *   - TOKEN_BLOCK is a snapshot of `nodes/operator/app/src/styles/tailwind.css .dark { … }`.
 *     Drift = visual regressions. Bump both in the same commit per spec TOKEN_BLOCK_PAIRED.
 *   - UTILITY_CSS is ≤15 classes per spec UTILITY_LIB_IS_CAPPED.
 *   - Shell never references external `<link>` or `<script>` per spec SHELL_IS_INLINE.
 * Links: docs/spec/knowledge-html-style.md
 * @internal
 */

// SOURCE: nodes/operator/app/src/styles/tailwind.css `.dark { ... }` block.
// When tokens change there, mirror here in the same commit.
const TOKEN_BLOCK = `:root {
  --background: 0 0% 0%;
  --foreground: 210 40% 98%;
  --card: 0 0% 0%;
  --card-foreground: 210 40% 98%;
  --popover: 217.2 32.6% 9%;
  --popover-foreground: 215 20.2% 76.1%;
  --primary: 217 71% 40%;
  --primary-foreground: 0 0% 100%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 9%;
  --muted-foreground: 215 20.2% 76.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 217 71% 40%;
  --chart-1: 220 70% 50%;
  --chart-2: 160 60% 45%;
  --chart-3: 30 80% 55%;
  --chart-4: 280 65% 60%;
  --chart-5: 340 75% 55%;
  --color-success: 142 71% 45%;
  --color-warning: 43 74% 66%;
  --color-danger: 0 84.2% 60.2%;
  --radius: 0.75rem;
  --font-sans: "Manrope", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}`;

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  padding: 24px;
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
}
h1, h2, h3, h4 { margin: 0 0 12px; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 20px; }
h2 { font-size: 16px; }
h3 { font-size: 14px; }
p { margin: 0 0 8px; }
a { color: hsl(var(--primary)); text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: 0; border-top: 1px solid hsl(var(--border)); margin: 16px 0; }
svg { max-width: 100%; height: auto; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid hsl(var(--border)); }
th { color: hsl(var(--muted-foreground)); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; }
code { font-family: var(--font-mono); font-size: 0.9em; padding: 1px 4px; border-radius: 4px; background: hsl(var(--muted)); }`;

// ≤15 utility classes. Adding one = spec amendment per UTILITY_LIB_IS_CAPPED.
const UTILITY_CSS = `.cogni-card {
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  padding: 16px;
}
.cogni-panel-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
  margin: 0 0 12px;
}
.cogni-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.cogni-divider {
  border: 0;
  border-top: 1px solid hsl(var(--border));
  margin: 16px 0;
}
.cogni-kv {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.cogni-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: calc(var(--radius) - 4px);
  font-size: 11px;
  font-weight: 500;
  background: hsl(var(--secondary));
  color: hsl(var(--secondary-foreground));
  white-space: nowrap;
}
.cogni-pill-success {
  background: hsl(var(--color-success) / 0.15);
  color: hsl(var(--color-success));
}
.cogni-pill-warning {
  background: hsl(var(--color-warning) / 0.15);
  color: hsl(var(--color-warning));
}
.cogni-pill-destructive {
  background: hsl(var(--destructive) / 0.7);
  color: hsl(0 0% 100%);
}
.cogni-mono {
  font-family: var(--font-mono);
}
.cogni-muted {
  color: hsl(var(--muted-foreground));
}`;

const SHELL_STYLE = `${TOKEN_BLOCK}\n${BASE_CSS}\n${UTILITY_CSS}`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap author content in the shell. If the content already declares its own
 * `<!doctype>` or `<html>`, it's treated as a full document and rendered verbatim
 * (backward compat with hand-authored artifacts like delta-analyzer.html that
 * pre-date this spec). Otherwise the content is treated as a body fragment and
 * inserted into the shell.
 */
export function buildHtmlShell(content: string, title: string): string {
  const looksLikeFullDoc = /^\s*<!doctype|^\s*<html/i.test(content);
  if (looksLikeFullDoc) return content;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
${content}
</body>
</html>`;
}
