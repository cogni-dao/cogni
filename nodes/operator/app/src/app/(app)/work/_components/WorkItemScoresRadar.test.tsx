// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemScoresRadar.test`
 * Purpose: Proves absent axes render as absent (not 0), `ev` renders only as a safe https link, and the rank/queue readout.
 * Scope: WorkItemScoresRadar rendering only.
 * Side-effects: DOM rendering in happy-dom
 * Links: story.5111, ./WorkItemScoresRadar.tsx
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkItemScoresRadar } from "./WorkItemScoresRadar";

function legendRow(container: HTMLElement, axis: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`li[data-axis="${axis}"]`);
  if (!row) throw new Error(`no legend row for ${axis}`);
  return row;
}

describe("WorkItemScoresRadar", () => {
  it("renders a missing axis as absent, never as 0, and leaves rank unknown", () => {
    const { container } = render(
      <WorkItemScoresRadar
        scores={{
          goal: { v: 5, ev: "https://cognidao.org/work/items/story.5111" },
          time: { v: 2 },
          unblocks: { v: 0 },
          confidence: { v: 3 },
        }}
      />
    );

    // Absent axes show "—" and a dashed spoke; a real 0 shows "0".
    expect(legendRow(container, "ease")).toHaveTextContent("Ease—");
    expect(legendRow(container, "agent")).toHaveTextContent("Agent-ready—");
    expect(legendRow(container, "unblocks")).toHaveTextContent("Unblocks0");
    expect(
      container.querySelector('g[data-axis="ease"][data-absent="true"]')
    ).not.toBeNull();
    expect(
      container.querySelector('g[data-axis="goal"][data-absent]')
    ).toBeNull();

    // Shape has one vertex per PRESENT axis only (4), not 6.
    const shape = screen.getByTestId("score-shape");
    expect(shape.getAttribute("points")?.split(" ")).toHaveLength(4);

    // User-facing copy says "Evaluation", never "do-it-now".
    expect(
      screen.getByRole("img", { name: /^Evaluation radar/ })
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/do-it-now/i);

    // Missing ease → rank undefined; missing agent → human queue.
    expect(screen.getByTestId("rank-score")).toHaveTextContent("—");
    expect(screen.getByTestId("score-queue")).toHaveTextContent("Human queue");
  });

  it("renders https ev as a nofollow justification link and drops non-https ev", () => {
    const { container } = render(
      <WorkItemScoresRadar
        scores={{
          goal: { v: 5, ev: "https://cognidao.org/work/items/story.5111" },
          time: { v: 4, ev: "javascript:alert(1)" },
          unblocks: { v: 4, ev: "<img src=x onerror=alert(1)>" },
          ease: { v: 5 },
          confidence: { v: 5 },
          agent: { v: 4 },
        }}
      />
    );

    const links = screen.getAllByRole("link", { name: /justification$/ });
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link).toHaveAccessibleName("Goal value justification");
    expect(link).toHaveTextContent("Justification");
    expect(link).toHaveAttribute(
      "href",
      "https://cognidao.org/work/items/story.5111"
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(legendRow(container, "goal")).toContainElement(link ?? null);
    expect(container.querySelector("img")).toBeNull();
    expect(container).not.toHaveTextContent(/evidence/i);

    // (5+4+4) / iterations(5)=1 × 5/5 = 13.0; agent 4 → agent queue.
    expect(screen.getByTestId("rank-score")).toHaveTextContent("13.0");
    expect(screen.getByTestId("score-queue")).toHaveTextContent("Agent queue");
  });
});
