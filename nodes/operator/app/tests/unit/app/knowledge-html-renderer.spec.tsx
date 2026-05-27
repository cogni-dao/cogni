// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-html-renderer.spec`
 * Purpose: Covers HtmlRenderer theme handoff into the sandboxed knowledge iframe shell.
 * Scope: React component unit test with next-themes mocked. No network or auth.
 * Invariants: HTML_RENDERER_THEME_MATCHES_PARENT, SANDBOX_IS_THE_BOUNDARY.
 * Side-effects: none
 * Links: src/app/(app)/knowledge/_components/HtmlRenderer.tsx, docs/spec/knowledge-html-style.md
 * @vitest-environment jsdom
 * @internal
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { HtmlRenderer } from "@/app/(app)/knowledge/_components/HtmlRenderer";

const mockUseTheme = vi.fn();

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

describe("HtmlRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a sandboxed light-theme iframe after mount", async () => {
    mockUseTheme.mockReturnValue({
      resolvedTheme: "light",
      theme: "system",
      systemTheme: "dark",
    });

    render(
      <HtmlRenderer
        html='<section class="cogni-card">visual</section>'
        title="Visual"
      />
    );

    const iframe = screen.getByTitle("Visual");
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");

    await waitFor(() => expect(iframe).toHaveAttribute("aria-busy", "false"));
    const srcDoc = iframe.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain('<html lang="en">');
    expect(srcDoc).toContain('<section class="cogni-card">visual</section>');
    expect(srcDoc).toContain(".cogni-svg-node");
  });

  it("falls back from system preference to systemTheme", async () => {
    mockUseTheme.mockReturnValue({
      resolvedTheme: undefined,
      theme: "system",
      systemTheme: "dark",
    });

    render(<HtmlRenderer html="<p>visual</p>" title="Dark Visual" />);

    const iframe = screen.getByTitle("Dark Visual");
    await waitFor(() => expect(iframe).toHaveAttribute("aria-busy", "false"));
    expect(iframe.getAttribute("srcdoc")).toContain(
      '<html lang="en" class="dark">'
    );
  });
});
