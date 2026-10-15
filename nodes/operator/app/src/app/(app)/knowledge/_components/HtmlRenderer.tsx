// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel. Reads theme via next-themes (the sanctioned ThemeProvider path)
 *   and passes the result into the shell so the artifact matches the parent.
 * Scope: Pure presentation. The sandbox disables scripts, popups, form submission,
 *   and same-origin access. Its sole capability is explicit-user top navigation for
 *   normalized HTTP(S) anchors, so a link cannot replace the iframe itself.
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

/**
 * Make authored anchors safe and predictable before they enter the sandbox.
 *
 * `srcDoc` anchors default to `_self`, which replaces the visual iframe with the
 * linked page. Authored `<base>` and `target` values are not trusted: resolve
 * relative URLs against the parent page, keep only HTTP(S), and force a
 * user-activated top-level navigation.
 */
export function normalizeHtmlNavigation(
  documentHtml: string,
  parentUrl: string
): string {
  const document = new DOMParser().parseFromString(documentHtml, "text/html");

  document.querySelectorAll("base").forEach((base) => {
    base.remove();
  });
  document.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    const authoredHref = anchor.getAttribute("href");
    if (!authoredHref) return;

    let resolved: URL;
    try {
      resolved = new URL(authoredHref, parentUrl);
    } catch {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      return;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      return;
    }

    anchor.href = resolved.href;
    anchor.target = "_top";
    anchor.rel = "noopener noreferrer";
  });

  const doctype = document.doctype
    ? `<!doctype ${document.doctype.name}>\n`
    : "";
  return `${doctype}${document.documentElement.outerHTML}`;
}

export function HtmlRenderer({ html, title }: HtmlRendererProps): ReactElement {
  const { resolvedTheme, theme: themePref, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const effective =
    resolvedTheme ??
    (themePref === "system" ? systemTheme : themePref) ??
    systemTheme;
  const theme: RenderTheme = effective === "dark" ? "dark" : "light";
  const srcDoc = mounted
    ? normalizeHtmlNavigation(
        buildHtmlShell(html, title, theme),
        window.location.href
      )
    : "";

  return (
    <iframe
      key={mounted ? theme : "pending"}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-top-navigation-by-user-activation"
      referrerPolicy="no-referrer"
      aria-busy={!mounted}
      className="h-[var(--height-artifact-canvas)] w-full rounded-md border border-border bg-background"
    />
  );
}
