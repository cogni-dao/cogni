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
  type GoalView,
  renderBundleMarkdown,
  resolveGoals,
  resolveOrientation,
  SESSION_BOOTSTRAP_INVARIANTS,
  SESSION_WATCH_GATE,
  WHOLE_BUNDLE_BUDGET_BYTES,
} from "@/app/api/v1/cognition/_bundle";

const baseInput = {
  node: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  name: "operator",
  mission: "Coordinate code, deploys, and validation for Cogni nodes.",
  generatedAt: "2026-06-16T19:31:02.838Z",
  origin: "https://test.cognidao.org",
  buildSha: "f52036b33ffecdf5244662e673a0d6d174c50150",
  toolingInvariants: ["Adopt one production work item."],
  governingIndex: [
    {
      id: "node-launch-handoff",
      entryType: "guide",
      domain: "infrastructure",
      useWhen: "handing a launched node to its first agent",
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
  goals: { status: "ok", goals: [] },
} as const;

const RULE_ROW = {
  id: "shelf-one-axis",
  useWhen: "designing or reviewing a knowledge domain set",
  entryType: "rule",
  domain: "method",
};

/** `n` governing rows of ~184 bytes each once rendered, like the prod hub. */
function governingRows(n: number, domain = "build-compute") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${domain}-entry-${i}`,
    entryType: i % 3 === 0 ? "rule" : "guide",
    domain,
    useWhen: `a situation number ${i} that this entry governs, stated as the reader would meet it in a task description`,
  }));
}

const bytesOf = (md: string) => new TextEncoder().encode(md).byteLength;

describe("governing index — the session index routes skills, guides, rules, designs, decisions and references", () => {
  it("renders every governing row with id, type, domain and use-when, rules included", () => {
    const md = renderBundleMarkdown({
      ...baseInput,
      governingIndex: [RULE_ROW, ...baseInput.governingIndex],
    });
    expect(md).toContain("## Governing index");
    expect(md).toContain("| entry | type | domain | use when |");
    expect(md).toContain(
      "| `shelf-one-axis` | rule | method | designing or reviewing a knowledge domain set |"
    );
    expect(md).toContain(
      "| `node-launch-handoff` | guide | infrastructure | handing a launched node to its first agent |"
    );
    // SELECT_THEN_LOAD: the section tells the agent to read the bodies it picks.
    expect(md).toContain("read each chosen entry");
    // The old skills-only section is gone.
    expect(md).not.toContain("## Skills index");
  });

  it("renders a placeholder row when the hub has no governing entries", () => {
    const md = renderBundleMarkdown({ ...baseInput, governingIndex: [] });
    expect(md).toContain("| _(none merged yet)_ | | | |");
  });
});

describe("whole-bundle budget (WHOLE_BUNDLE_BUDGET_64KIB)", () => {
  it("is 64 KiB", () => {
    expect(WHOLE_BUNDLE_BUDGET_BYTES).toBe(64 * 1024);
  });

  it("renders the whole governing index inline at today's prod size (118 rows)", () => {
    const rows = governingRows(118);
    const md = renderBundleMarkdown({ ...baseInput, governingIndex: rows });
    expect(bytesOf(md)).toBeLessThanOrEqual(WHOLE_BUNDLE_BUDGET_BYTES);
    expect(md).toContain("build-compute-entry-117");
    expect(md).not.toContain("exceeds the 64 KiB bundle budget");
  });

  it("past the budget, carries only the method shelf inline plus the shelf-pull pointer, and stays under 64 KiB", () => {
    const rows = [...governingRows(400), ...governingRows(5, "method")];
    const md = renderBundleMarkdown({ ...baseInput, governingIndex: rows });
    expect(bytesOf(md)).toBeLessThanOrEqual(WHOLE_BUNDLE_BUDGET_BYTES);
    expect(md).toContain("exceeds the 64 KiB bundle budget");
    expect(md).toContain(
      `GET ${baseInput.origin}/api/v1/knowledge/index?domain=<shelf>`
    );
    expect(md).toContain("method-entry-4");
    expect(md).not.toContain("build-compute-entry-0 ");
    expect(md).not.toContain("`build-compute-entry-0`");
    // The domain pointers the agent pulls from still render.
    expect(md).toContain("## Knowledge domains");
  });
});

describe("renderBundleMarkdown", () => {
  it("renders name, mission, counts, and load time while demoting build SHA", () => {
    const markdown = renderBundleMarkdown(baseInput);

    const [heading, blank, subtitle, spacer, delivered] = markdown.split("\n");

    expect(heading).toBe("# operator — Cogni Session Cognition");
    expect(blank).toBe("");
    expect(subtitle).toBe(
      "> Coordinate code, deploys, and validation for Cogni nodes. · 1 governing entries · 1 domains · loaded 2026-06-16 19:31"
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

  it("orders the CICD loop as fresh review, flight, validate, then operator merge", () => {
    const cicd =
      SESSION_BOOTSTRAP_INVARIANTS.find((line) =>
        line.startsWith("Follow the CICD checklist")
      ) ?? "";
    const review = cicd.indexOf("/review-implementation");
    const flight = cicd.indexOf("/api/v1/vcs/flight");
    const validate = cicd.indexOf("/validate-candidate");
    const merge = cicd.indexOf("/api/v1/vcs/merge");

    expect(review).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(flight);
    expect(flight).toBeLessThan(validate);
    expect(validate).toBeLessThan(merge);
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

describe("Goals section — approved DAO goals right after the mission (task.5287)", () => {
  const goal = (n: number): GoalView => ({
    id: `goal-g${n}`,
    title: `Goal: outcome ${n}`,
    // Content deliberately states a DIFFERENT date: the rendered deadline must
    // come from the evaluate_at column, never from parsing the body.
    content: `Statement: s${n}.\nKPI: \`gh pr list\` | count\nTarget: ${n}\nBy: someday`,
    evaluateAt: new Date(`2026-12-0${n}T00:00:00.000Z`),
  });
  const port = (goals: GoalView[] | Error) => ({
    listActiveGoals: async () => {
      if (goals instanceof Error) throw goals;
      return goals;
    },
  });

  it("renders exactly `no approved goals` with zero goals", async () => {
    const goals = await resolveGoals(port([]));
    const md = renderBundleMarkdown({ ...baseInput, goals });
    expect(md).toContain("## Goals\n\nno approved goals\n");
  });

  it("renders 1–3 goals' title and content verbatim, after orientation and before the invariants", async () => {
    const three = [goal(1), goal(2), goal(3)];
    const md = renderBundleMarkdown({
      ...baseInput,
      orientation: { id: "operator-agent-orientation", content: "the map" },
      goals: await resolveGoals(port(three)),
    });
    for (const g of three) {
      expect(md).toContain(
        `### ${g.title}\n\nBy: 2026-12-0${g.id.slice(-1)} · \`${g.id}\`\n\n${g.content}`
      );
    }
    expect(md).not.toContain("no approved goals");
    const at = (needle: string) => md.indexOf(needle);
    expect(at("## Orientation")).toBeLessThan(at("## Goals"));
    expect(at("the map")).toBeLessThan(at("## Goals"));
    expect(at("## Goals")).toBeLessThan(at("## Tooling invariants"));
  });

  it("renders a visible `goals unavailable` line when the read fails (e.g. >3 goals)", async () => {
    const goals = await resolveGoals(
      port(new Error("4 active DAO goals exceed the max of 3: goal-a, goal-b"))
    );
    expect(goals.status).toBe("unavailable");
    const md = renderBundleMarkdown({ ...baseInput, goals });
    expect(md).toContain("## Goals");
    expect(md).toContain(
      "goals unavailable: 4 active DAO goals exceed the max of 3: goal-a, goal-b"
    );
    expect(md).not.toContain("no approved goals");
  });

  it("marks a goal with no evaluate_at instead of inventing a deadline", async () => {
    const md = renderBundleMarkdown({
      ...baseInput,
      goals: await resolveGoals(port([{ ...goal(1), evaluateAt: null }])),
    });
    expect(md).toContain("By: no deadline set · `goal-g1`");
  });

  it("renders `goals unavailable` when the hub is not configured", async () => {
    const md = renderBundleMarkdown({
      ...baseInput,
      goals: await resolveGoals(undefined),
    });
    expect(md).toContain("goals unavailable: knowledge hub not configured");
  });
});
