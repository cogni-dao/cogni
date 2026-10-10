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
  renderBundleMarkdown,
  resolveOrientation,
  SESSION_BOOTSTRAP_INVARIANTS,
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

const SKILL_WITH_TRIGGER = {
  id: "shelf-one-axis",
  title: "A shelf sorts on one axis or regrows a catch-all",
  useWhen: "designing or reviewing a knowledge domain set",
  entryType: "rule",
  domain: "method",
};

describe("bundle growth — large indexes render whole, no serve-side ceiling (story.5070)", () => {
  // The hub is designed to accumulate: every new skill/guide/playbook adds a row.
  // Delivery is now uncapped on both runtimes (Codex raw stdout with spill off;
  // Claude Code structured additionalContext), so the producer no longer enforces
  // a byte ceiling. The former 16 KB cap (bug.5284) would have rejected this shape
  // at the source and 500'd /api/v1/cognition; growth must now render whole.
  function indexOf(rows: number, triggerLen: number) {
    return Array.from({ length: rows }, (_, i) => ({
      id: `build-compute-entry-${i}`,
      title: `Claim sentence number ${i} stating what the entry concludes`,
      useWhen: "x".repeat(triggerLen),
      entryType: "guide",
      domain: "build-compute",
    }));
  }

  it("renders a bundle well past the former 16 KB cap, whole and untruncated", () => {
    const md = renderBundleMarkdown({
      ...baseInput,
      skillsIndex: indexOf(80, 314),
    });
    const bytes = new TextEncoder().encode(
      `${md.replace(/\n+$/, "")}\n`
    ).byteLength;
    // Past the old ceiling — which would have thrown here.
    expect(bytes).toBeGreaterThan(16 * 1024);
    // The last row is present ⇒ nothing was dropped.
    expect(md).toContain("build-compute-entry-79");
  });
});

describe("skills index — the 'use when' column shows the trigger", () => {
  it("renders use_when, not the title, when the entry has one", () => {
    const md = renderBundleMarkdown({
      ...baseInput,
      skillsIndex: [SKILL_WITH_TRIGGER],
    });
    // The header has always claimed "use when"; it must now be true.
    expect(md).toContain("| entry | type | use when |");
    expect(md).toContain("designing or reviewing a knowledge domain set");
    // The claim belongs in the entry body, not this column.
    expect(md).not.toContain(
      "A shelf sorts on one axis or regrows a catch-all"
    );
  });

  it("falls back to the title when use_when is null", () => {
    // A node that has not backfilled must still show a usable line rather
    // than an empty cell.
    const md = renderBundleMarkdown({
      ...baseInput,
      skillsIndex: [{ ...SKILL_WITH_TRIGGER, useWhen: null }],
    });
    expect(md).toContain("A shelf sorts on one axis or regrows a catch-all");
  });

  it("falls back to the title when use_when is absent entirely", () => {
    const { useWhen: _omitted, ...withoutField } = SKILL_WITH_TRIGGER;
    const md = renderBundleMarkdown({
      ...baseInput,
      skillsIndex: [withoutField],
    });
    expect(md).toContain("A shelf sorts on one axis or regrows a catch-all");
  });
});

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

  it("renders the current-node orientation entry IN FULL alongside the tooling invariants", () => {
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
    // INVARIANT FLOOR (story.5070): the code-owned invariants + watch-gate are
    // the always-present contract spine. They render ALONGSIDE a served
    // orientation (the node map), never suppressed by it — reversing the earlier
    // ONE_VOICE suppression (task.5155) whose defect was that a served
    // orientation dropped the contract.
    expect(markdown).toContain("## Tooling invariants");
    expect(markdown).toContain("<watch-gate");
  });

  // The work-item write seam is the one thing agents could NOT discover from a
  // node: `endpoints.workItems` is a bare URL, so agents fell back to
  // harness-local slash commands that hardcode the operator apex and filed every
  // node's work onto operator. The section must render regardless of whether an
  // orientation is served, and must be origin-relative, which a hub-served
  // orientation entry structurally cannot be.
  it("always renders the node-relative work-item write seam, even with an orientation served", () => {
    const withOrientation = renderBundleMarkdown({
      ...baseInput,
      orientation: {
        id: "operator-agent-orientation",
        content: "**USE WHEN:** first read of every operator session.",
      },
    });

    for (const markdown of [renderBundleMarkdown(baseInput), withOrientation]) {
      expect(markdown).toContain("## Work items — this node's own ledger");
      // Origin-relative, so each node advertises its OWN hub.
      expect(markdown).toContain(`POST ${baseInput.origin}/api/v1/work/items`);
      expect(markdown).toContain(
        `PATCH ${baseInput.origin}/api/v1/work/items/{id}`
      );
      // The two contract details agents most often get wrong.
      expect(markdown).toContain('{"set":{...}}');
      expect(markdown).toContain("There is no `in_progress`");
    }

    // The invariant floor is now unconditional (story.5070): a served
    // orientation augments it, it does not suppress it.
    expect(withOrientation).toContain("## Tooling invariants");
  });

  // The common fresh-node case: the hub serves a map-only orientation (what this
  // node is, where authority lives, what to recall next) that carries NO
  // agent-contract / axiom prose. Under the old ONE_VOICE suppression this
  // silently shipped a session with no contract at all — the real story.5070
  // defect. The invariant floor must still render.
  it("renders the invariant floor even when a map-only orientation is served (story.5070)", () => {
    const mapOnlyOrientation = [
      "## What this node is",
      "Operator coordinates code, deploys, and validation for Cogni nodes.",
      "",
      "## Where authority lives",
      "RBAC via OpenFGA; promotes run as the operator principal.",
      "",
      "## What to recall next",
      "Start with the cicd + validate-candidate skills.",
    ].join("\n");
    const markdown = renderBundleMarkdown({
      ...baseInput,
      orientation: {
        id: "operator-agent-orientation",
        content: mapOnlyOrientation,
      },
    });

    // The map renders...
    expect(markdown).toContain("## Orientation — recall this first");
    expect(markdown).toContain(mapOnlyOrientation);
    // ...and the code-owned contract floor renders ALONGSIDE it, not instead.
    expect(markdown).toContain("## Tooling invariants");
    expect(markdown).toContain(SESSION_WATCH_GATE);
    // First invariant line, numbered — proof the full list, not a stub, is in.
    expect(markdown).toContain(`1. ${baseInput.toolingInvariants[0]}`);
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
