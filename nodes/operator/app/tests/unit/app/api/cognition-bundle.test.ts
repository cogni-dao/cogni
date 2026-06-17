// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/cognition-bundle`
 * Purpose: Unit tests for the cognition bundle markdown renderer.
 * Scope: Pure rendering only; route IO and hub reads are validated separately.
 * Invariants: Session-start heading is human node identity first, deploy SHA as metadata.
 * Side-effects: none
 * Links: src/app/api/v1/cognition/_bundle.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import {
  excerptFromContent,
  ORIENTATION_EXCERPT_MAX,
  renderBundleMarkdown,
} from "@/app/api/v1/cognition/_bundle";

const baseInput = {
  node: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  name: "operator",
  mission: "Coordinate code, deploys, and validation for Cogni nodes.",
  generatedAt: "2026-06-16T19:31:02.838Z",
  origin: "https://test.cognidao.org",
  buildSha: "f52036b33ffecdf5244662e673a0d6d174c50150",
  toolingInvariants: ["Adopt one production work item."],
  skillsIndex: [
    {
      id: "node-launch-handoff",
      title: "Node launch handoff",
      entryType: "guide",
      domain: "infrastructure",
    },
  ],
  domainPointers: [
    {
      domain: "infrastructure",
      entryCount: 7,
      description: "Runtime and deploy knowledge.",
    },
  ],
  orientation: null,
} as const;

describe("renderBundleMarkdown", () => {
  it("renders name, mission, counts, and load time while demoting build SHA", () => {
    const markdown = renderBundleMarkdown(baseInput);

    const [heading, blank, subtitle, spacer, delivered] = markdown.split("\n");

    expect(heading).toBe("# operator — Cogni Session Cognition");
    expect(blank).toBe("");
    expect(subtitle).toBe(
      "> Coordinate code, deploys, and validation for Cogni nodes. · 1 skills · 1 domains · loaded 2026-06-16 19:31"
    );
    expect(spacer).toBe(">");
    expect(delivered).toContain("node `4ff8eac1-4eba-4ed0-931b-b1fe4f64713d`");
    expect(delivered).toContain(
      "build `f52036b33ffecdf5244662e673a0d6d174c50150`"
    );
    expect(heading).not.toContain("f52036b3");
  });

  it("surfaces a current-node orientation excerpt above the tooling invariants", () => {
    const markdown = renderBundleMarkdown({
      ...baseInput,
      orientation: {
        id: "operator-agent-orientation",
        excerpt:
          "Operator is the agentic git-manager. Edit nodes/operator/app.",
      },
    });

    expect(markdown).toContain("## Orientation — recall this first");
    expect(markdown).toContain(
      "Operator is the agentic git-manager. Edit nodes/operator/app."
    );
    expect(markdown).toContain("Recall `operator-agent-orientation`");
    // Map comes before the constitution.
    expect(markdown.indexOf("## Orientation — recall this first")).toBeLessThan(
      markdown.indexOf("## Tooling invariants")
    );
  });

  it("prompts seeding an orientation entry when none exists", () => {
    const markdown = renderBundleMarkdown(baseInput);

    expect(markdown).toContain("## Orientation — recall this first");
    expect(markdown).toContain("No `operator-agent-orientation` entry yet");
  });
});

describe("excerptFromContent", () => {
  it("takes the leading paragraph and flattens whitespace", () => {
    const excerpt = excerptFromContent(
      "**Use when:** starting a session.\nLine two.\n\nSecond block ignored."
    );
    expect(excerpt).toBe("**Use when:** starting a session. Line two.");
    expect(excerpt).not.toContain("Second block");
  });

  it("caps length with an ellipsis", () => {
    const excerpt = excerptFromContent(
      "x".repeat(ORIENTATION_EXCERPT_MAX + 50)
    );
    expect(excerpt.length).toBeLessThanOrEqual(ORIENTATION_EXCERPT_MAX + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
