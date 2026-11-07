// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base/seeds/base`
 * Purpose: Base knowledge seeds inherited by all nodes.
 * Scope: Seed data definitions only. Does not perform I/O — the provisioning script applies these.
 * Invariants: Append-only catalogue; IDs are stable. Per-node domain seeds live in their own packages, not here.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type { NewKnowledge } from "@cogni/knowledge-store";

/**
 * Base knowledge seeds — generic domain knowledge that every node inherits.
 * Nodes extend this with domain-specific seeds in their own seeds/ directory.
 */
export const BASE_KNOWLEDGE_SEEDS: NewKnowledge[] = [
  {
    id: "cogni-meta-001",
    domain: "meta",
    title: "Knowledge store overview",
    content:
      "This node uses a Doltgres-backed knowledge store with git-like versioning. " +
      "Knowledge is separated from hot operational data (awareness plane). " +
      "Use commit() after writes to create versioned snapshots.",
    sourceType: "human",
    confidencePct: 80,
    tags: ["meta", "knowledge-store", "onboarding"],
  },
  {
    id: "cogni-agent-orientation",
    domain: "meta",
    title: "Agent orientation starter for this node",
    entryType: "guide",
    content:
      "**Use when:** any agent starts a session on this node (coding, launch, research, governance, validation, or ops). This is the node's agent operating map: recall it first, then refine it for THIS node and keep it current as the node grows.\n\n" +
      "This is the starter orientation every Cogni node inherits from the base seed set. Replace the placeholders below with this node's specifics, and write the node's own living map as a sibling `<slug>-agent-orientation` entry (a re-seed may overwrite this starter, so node-owned context belongs in the slug-specific entry).\n\n" +
      "## Where to edit\n" +
      "- App code, node-owned packages, and `.cogni/repo-spec.yaml` (the running app reads its OWN node spec, not the monorepo root). Fill in the real paths for this node.\n\n" +
      "## What NOT to run\n" +
      "- No broad local suites; push a feature branch and let CI verify.\n" +
      "- Don't modify `.github/workflows/*` in a feature commit (can quarantine CI).\n\n" +
      "## What can break prod / candidate\n" +
      "- DB creds come from ESO/OpenBao on every env; never write plaintext DB passwords.\n" +
      "- Deploys ship prebuilt images by SHA; verify the live build before validating.\n\n" +
      "## What to recall next\n" +
      "- `cognition-substrate-bootstrap` (why the session bundle exists) and the skills index in the session bundle. Then create this node's `<slug>-agent-orientation` and cite this entry.\n" +
      "- Create this node's `<slug>-architect` from the `cogni-architect` starter, then route every design or code change through it. The architect is required reading for nearly any design or code change; skip it only for wording-only edits. It is a foundational atom: every node has one.\n\n" +
      "## Work items belong to this node\n" +
      "- Resolve this node's base URL from `.cogni/repo-spec.yaml` and `/.well-known/agent.json`; never default writes to the operator apex.\n" +
      '- Discover the typed write contracts at `actions.createWorkItem` and `actions.updateWorkItem`. Create with `POST /api/v1/work/items`; progress or close with `PATCH /api/v1/work/items/{id}` using `{"set":{...}}`.\n' +
      "- Adopt before creating. One work item + one node per session; close only after the linked PR merges and live behavior is proven.\n\n" +
      "Refine whenever repo layout, scripts, CI, deploy, auth, or validation behavior changes.",
    sourceType: "human",
    confidencePct: 60,
    tags: ["agent-orientation", "operating-map", "onboarding", "session-start"],
  },
  {
    id: "cogni-architect",
    domain: "meta",
    title: "Node architect starter — route design and code through it",
    entryType: "skill",
    content:
      "**Use when:** before any research, design, or code review on this node. Skip only for wording-only edits.\n\n" +
      "This is the starter architect every Cogni node inherits from the base seed set. Rename it to this node's own `<slug>-architect`, then grow it as the node builds its mission. A re-seed may overwrite this starter, so node-owned content belongs in the slug-specific entry. It is a foundational atom: every node keeps one and routes design through it.\n\n" +
      "Keep every change on the shortest safe path to THIS node's mission. You build on the node-template foundation; you do not rebuild it.\n\n" +
      "## You inherited a working baseline\n" +
      "- The node-template foundation gives you CI/CD, governance, payments, cognition, work items, knowledge, and delivery. Treat these as given.\n" +
      "- For any change to that shared plumbing, the owner is node-template, not this node. Read [node-template-architect](https://node-template.cognidao.org/knowledge/node-template-architect) in full and route the change upstream. Do not fork or re-derive baseline behavior here.\n\n" +
      "## Stay aligned to receive updates\n" +
      "- This node keeps receiving node-template package and fork-sync updates. Keep your mission code and mission knowledge separate from inherited baseline files so those updates merge cleanly.\n" +
      "- A shared fix authored here instead of upstream blocks the next update. Treat it as a design finding, not a shortcut.\n\n" +
      "## Build this node's mission\n" +
      "- Name the node's north-star goal and the mission-loop stage the change moves: Goals -> Measure -> Prioritize -> Discover -> Act -> Learn. A change that serves no node goal is sprawl; record it as a finding.\n" +
      "- Map this node's own services, domains, and decisions here as they grow. Replace this list with the real owners.\n\n" +
      "## Compare target, current system, and proposed change\n" +
      "1. Fix the scope from the owned work item outcome: node, environment, services, authority.\n" +
      "2. Pin the evidence: repository and revision for each input; read the changed files and their callers.\n" +
      "3. Trace the mechanism: input -> authoritative writer -> external effect -> evidence -> gate. Inspect the failed behavior before proposing its cure.\n" +
      "4. Contrast with the north star: for each issue, cite the target, the current evidence, the proposed delta, and whether it is convergence, a justified transition, or a regression. A regression blocks approval.\n\n" +
      "## Review and hand off\n" +
      "- For designs apply `review-design`; for code apply `review-implementation`. Do not approve your own work.\n" +
      "- Prove live before->after behavior with the exact build SHA. Green CI, a merged PR, or a written artifact is not proof.",
    sourceType: "human",
    confidencePct: 60,
    tags: [
      "architect",
      "operating-map",
      "onboarding",
      "design-review",
      "node-template-baseline",
    ],
  },
  {
    id: "cogni-meta-confidence-convention",
    domain: "meta",
    title: "Confidence-score convention across the knowledge plane",
    content:
      "Every row in every knowledge table carries a `confidence_pct` integer (0-100) " +
      "representing 'our confidence this row is 100% clear and accurate'. New rows " +
      "default to 40 — start low; raise as evidence accumulates. Future guidance / " +
      "rubrics will define the path to higher scores. Will we ever reach 100%? TBD. " +
      "Suggested anchors: 40 = baseline (just inserted, not corroborated), " +
      "60 = candidate (multiple corroborating sources, no contradictions), " +
      "80 = verified (human-reviewed or outcome-validated), " +
      "95 = hardened (statistically significant, repeatedly confirmed), " +
      "100 = factual and works (objectively verifiable + currently functioning — " +
      "e.g., a code path with passing tests, a settled mathematical fact). " +
      "Below 100 = the room where new evidence can still refine.",
    sourceType: "human",
    confidencePct: 80,
    tags: ["meta", "confidence", "convention", "syntropy"],
  },
];
