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
import { renderBundleMarkdown } from "@/app/api/v1/cognition/_bundle";

describe("renderBundleMarkdown", () => {
  it("renders name, mission, counts, and load time while demoting build SHA", () => {
    const markdown = renderBundleMarkdown({
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
    });

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
});
