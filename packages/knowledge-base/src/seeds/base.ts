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
      "- `cognition-substrate-bootstrap` (why the session bundle exists) and the skills index in the session bundle. Then create this node's `<slug>-agent-orientation` and cite this entry.\n\n" +
      "Refine whenever repo layout, scripts, CI, deploy, auth, or validation behavior changes.",
    sourceType: "human",
    confidencePct: 60,
    tags: ["agent-orientation", "operating-map", "onboarding", "session-start"],
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
