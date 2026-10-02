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
  assertBundleWithinBudget,
  renderBundleMarkdown,
  resolveOrientation,
  SESSION_BOOTSTRAP_INVARIANTS,
  SESSION_COGNITION_MAX_BYTES,
  SESSION_WATCH_GATE,
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

  it("surfaces the derived candidate (flight + validate) URL for the node", () => {
    // operator is the primary test apex...
    expect(renderBundleMarkdown(baseInput)).toContain(
      "https://test.cognidao.org"
    );
    // ...every other node is a slugged test host.
    expect(renderBundleMarkdown({ ...baseInput, name: "poly" })).toContain(
      "https://poly-test.cognidao.org"
    );
  });

  it("renders the node-relative knowledge-domain control plane", () => {
    const markdown = renderBundleMarkdown(baseInput);

    expect(markdown).toContain("## Knowledge domain control plane");
    expect(markdown).toContain(
      "GET https://test.cognidao.org/api/v1/knowledge/domains"
    );
    expect(markdown).toContain(
      "POST https://test.cognidao.org/api/v1/knowledge/domains"
    );
    expect(markdown).toContain(
      "DELETE https://test.cognidao.org/api/v1/knowledge/domains/{id}"
    );
    expect(markdown).toContain("409 domain_in_use");
  });

  it("renders the current-node orientation entry IN FULL above the tooling invariants", () => {
    const fullOrientation = [
      "**USE WHEN:** first read of every operator session.",
      "",
      "## Mission",
      "Operator is the agentic git-manager. Edit nodes/operator/app.",
      "",
      "## Principles",
      "- Recall before write, refine over extend.",
    ].join("\n");
    const markdown = renderBundleMarkdown({
      ...baseInput,
      orientation: {
        id: "operator-agent-orientation",
        content: fullOrientation,
      },
    });

    expect(markdown).toContain("## Orientation — recall this first");
    // The whole entry body is inlined, not a truncated excerpt — every section
    // survives, including ones past the old 480-char first-paragraph cut.
    expect(markdown).toContain(fullOrientation);
    expect(markdown).toContain("## Mission");
    expect(markdown).toContain("- Recall before write, refine over extend.");
    // No second-recall footer: the bootstrap IS the orientation.
    expect(markdown).not.toContain("for the full context");
    // ONE VOICE (task.5155): a served orientation IS the constitution — the
    // code-owned invariants + watch-gate must NOT render alongside it.
    expect(markdown).not.toContain("## Tooling invariants");
    expect(markdown).not.toContain("<watch-gate");
  });

  // The bundle is served to every harness (Claude Code, Codex, OpenAI, plain
  // shell) and auto-injected into a fresh session. So the "how to watch an async
  // gate" contract must be (a) portable — one blocking shell command, no
  // Claude-only Monitor/background primitive — and (b) XML-tagged so any model
  // parses + recalls the exact command without prose parsing. Pin both here.
  it("exposes a portable, XML-tagged watch-gate the render inlines", () => {
    const g = SESSION_WATCH_GATE;
    // Tag-structured: five parseable atoms, not a prose run-on.
    expect(g).toContain("<watch-gate");
    expect(g).toContain("</watch-gate>");
    expect(g).toContain("<ci-green>");
    expect(g).toContain("<flight-landed>");
    expect(g).toContain("<deploy-landed>");
    expect(g).toContain("<truth>");
    // Portable, harness-neutral rule lives on the opening tag.
    expect(g).toContain("ONE blocking command");
    expect(g).toContain("no harness-specific monitor/background");
    // (1) CI: exact one-liner + the --required trap.
    expect(g).toContain("gh pr checks {PR} --watch --fail-fast");
    expect(g).toContain("NOT --required");
    // Verified against PR #2075: `static` IS a required check, so the reason to
    // avoid --required is the gates it OMITS (e.g. build), not static. Don't let
    // the stale "build/static live outside required" claim creep back.
    expect(g).not.toMatch(/build\/static/);
    // --watch blocks to a terminal state and never returns 8; exit 8 (pending)
    // belongs only to the one-shot re-read. Guard against re-mislabeling it.
    expect(g).toMatch(/one-shot 8=pending/);
    // Poll must be bounded + fail loud — never an unbounded/​silent hang.
    expect(g).toMatch(/[Bb]ound/);
    expect(g).toContain("FAILED");
    // Placeholders are brace-form so the ONLY angle brackets are real tags —
    // an angle-bracket placeholder (<PR>) would collide with the tag grammar.
    expect(g).not.toMatch(/<(PR|candidate|target|node)>/);
    // (2)/(3) flight + deploy: /version.buildSha is the ground-truth verdict.
    expect(g).toContain(".buildSha");
    expect(g).toContain("only ground truth");
    // Terse by contract: the whole block must stay short enough to recall.
    expect(g.length).toBeLessThan(1000);
    // The render actually inlines it under a discoverable header.
    const markdown = renderBundleMarkdown(baseInput);
    expect(markdown).toContain("## Watch an async gate — CI · flight · deploy");
    expect(markdown).toContain(SESSION_WATCH_GATE);
  });

  it("keeps the CICD-sequence invariant free of the watch mechanics it delegates", () => {
    const cicd = SESSION_BOOTSTRAP_INVARIANTS.find((line) =>
      line.startsWith("Follow the CICD checklist")
    );
    // The step order lives in the invariant; the *how to watch* lives in the
    // <watch-gate> block. The invariant points at it, never duplicates the cmd.
    expect(cicd).toBeDefined();
    expect(cicd).not.toContain("--fail-fast");
    expect(cicd).toContain("<watch-gate>");
  });

  it("prompts seeding an orientation entry when none exists", () => {
    const markdown = renderBundleMarkdown(baseInput);

    expect(markdown).toContain("## Orientation — recall this first");
    expect(markdown).toContain("No `operator-agent-orientation` entry yet");
    // Fallback constitution: with no orientation the code-owned invariants +
    // watch-gate DO render — a session on an empty hub still gets the rules.
    expect(markdown).toContain("## Tooling invariants");
    expect(markdown).toContain("<watch-gate");
  });

  it("fails closed before a SessionStart bundle can exceed its strict byte budget", () => {
    // The presenter appends one final newline to the body.
    const atBudget = "x".repeat(SESSION_COGNITION_MAX_BYTES - 1);
    const overBudget = `${atBudget}x`;

    expect(() => assertBundleWithinBudget(atBudget)).not.toThrow();
    expect(() => assertBundleWithinBudget(overBudget)).toThrow(
      `maximum is ${SESSION_COGNITION_MAX_BYTES}`
    );
  });
});

describe("resolveOrientation", () => {
  const port = (rows: Record<string, string>) => ({
    getKnowledge: async (id: string) =>
      id in rows ? { id, content: rows[id] } : null,
  });

  it("finds the exact-id entry even when the domain scan missed it (bug.5280)", async () => {
    // Repro: domain outgrew PER_DOMAIN_LIMIT, so the scan never saw the old
    // orientation row and passed scannedOrientationId=null. Direct lookup
    // must still resolve it.
    const result = await resolveOrientation(
      port({ "operator-agent-orientation": "the map" }),
      "operator-agent-orientation",
      null
    );
    expect(result).toEqual({
      id: "operator-agent-orientation",
      content: "the map",
    });
  });

  it("falls back to the scan-found suffix entry when the exact id is absent", async () => {
    const result = await resolveOrientation(
      port({ "legacy-agent-orientation": "older map" }),
      "operator-agent-orientation",
      "legacy-agent-orientation"
    );
    expect(result?.id).toBe("legacy-agent-orientation");
  });

  it("falls back to the generic starter seed last, else null", async () => {
    const seeded = await resolveOrientation(
      port({ "cogni-agent-orientation": "starter" }),
      "operator-agent-orientation",
      null
    );
    expect(seeded?.id).toBe("cogni-agent-orientation");

    const empty = await resolveOrientation(
      port({}),
      "operator-agent-orientation",
      null
    );
    expect(empty).toBeNull();
  });
});
