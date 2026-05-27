// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-html-shell.spec`
 * Purpose: Locks the sandboxed knowledge HTML shell primitives that human-facing artifacts compose from.
 * Scope: Pure string assertions for renderer shell CSS. No DOM, network, or auth.
 * Invariants: UTILITY_LIB_IS_CAPPED, DIAGRAMS_USE_SVG.
 * Side-effects: none
 * Links: src/app/(app)/knowledge/_components/htmlShell.ts, docs/spec/knowledge-html-style.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import { buildHtmlShell } from "@/app/(app)/knowledge/_components/htmlShell";

describe("knowledge html shell", () => {
  it("keeps the utility class set capped at 15", () => {
    const shell = buildHtmlShell("<p>body</p>", "title", "dark");
    const style = shell.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const classes = [...style.matchAll(/^\.([a-z0-9-]+)/gm)]
      .map((m) => m[1])
      .filter((name) => name.startsWith("cogni-"));

    expect(classes).toHaveLength(15);
    expect(classes).toEqual([
      "cogni-card",
      "cogni-panel-title",
      "cogni-grid",
      "cogni-divider",
      "cogni-kv",
      "cogni-pill",
      "cogni-pill-success",
      "cogni-pill-warning",
      "cogni-pill-destructive",
      "cogni-mono",
      "cogni-muted",
      "cogni-svg-container",
      "cogni-svg-node",
      "cogni-svg-label",
      "cogni-svg-arrow",
    ]);
  });

  it("uses browser-stable tone CSS for SVG rect primitives", () => {
    const shell = buildHtmlShell(
      '<svg><rect class="cogni-svg-node" style="--cogni-tone: var(--chart-1)"/></svg>',
      "title",
      "dark"
    );

    expect(shell).toContain("--cogni-tone: var(--muted);");
    expect(shell).toContain("fill: hsl(var(--cogni-tone) / 0.18);");
    expect(shell).toContain("stroke: hsl(var(--cogni-tone) / 0.7);");
    expect(shell).not.toContain("hsl(var(--cogni-tone,");
  });
});
