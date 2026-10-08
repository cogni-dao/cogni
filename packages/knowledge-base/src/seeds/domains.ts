// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base/seeds/domains`
 * Purpose: Base `domains` registry rows — the starter shelves every spawned node inherits.
 *   Every knowledge entry's `domain` column references one of these or a node-declared shelf.
 * Scope: Seed data definitions only. Does not perform I/O.
 * Invariants: Domain `id`s are stable and the registry is APPEND-ONLY — the live API exposes
 *   GET and POST but no DELETE, so a registered shelf can never be removed. Add deliberately.
 * Side-effects: none
 * Links: knowledge entry `cogni-domain-taxonomy` (the approved taxonomy + its rationale)
 * @public
 */

export interface NewDomain {
  id: string;
  name: string;
  description?: string;
}

// Shelves sort on ONE axis: `use-*` is the service surface this hub offers to
// outside consumers, `build-*` is the machinery that provides it. Both are
// relative to the hub you are reading, so a node gets its own of each — it
// consumes the operator platform AND provides a service to its own users.
// Reader identity and lifecycle status are FIELDS, never shelves.
//
// Operator's own 14 shelves are NOT here: a node must not inherit the
// platform's internals. Nodes cite the operator hub for CI/CD and deploy
// knowledge rather than copying it. Likewise each node's niche shelves and any
// extra `use-*` surfaces are declared per-node in `.cogni/repo-spec.yaml` and
// seeded from there, never in this shared base — that was cross-node
// contamination. See knowledge entry `cogni-domain-taxonomy`.
//
// `skills` is intentionally absent: it is an entry_type (skill/guide/playbook),
// not a domain.
//
// NOTE (task.5194): these rows ARE applied — but only on the local-dev path.
// `scripts/db/seed-doltgres.mts` imports this constant and calls
// `registerDomain` for each row idempotently, and that script runs via
// `pnpm db:seed:doltgres` inside `pnpm db:setup`, which is invoked only from
// `scripts/bootstrap/setup.sh`. No GitHub workflow runs it, and it is pinned to
// `DOLTGRES_URL_OPERATOR`. A freshly spawned node therefore never seeds these
// shelves, which is why `mission` is empty fleet-wide. Registration is also
// available to any node agent directly: `POST /api/v1/knowledge/domains`
// returns 201 for a node bearer. task.5194 makes the first-agent bootstrap say
// which shelves to register; it does not need a new migrator.
export const BASE_DOMAIN_SEEDS: NewDomain[] = [
  {
    id: "meta",
    name: "Meta",
    description:
      "How to use this node and its knowledge hub — orientation, conventions, and the contribution contract. How to USE the hub, not how it is built.",
  },
  {
    id: "mission",
    name: "Mission",
    description:
      "The node's charter — why it exists, its values, and its non-goals. Seeded from `.cogni/repo-spec.yaml` intent at formation.",
  },
  {
    id: "strategy",
    name: "Strategy",
    description:
      "How the node pursues its mission — market and product research, pricing, bets, and EDO hypothesis chains promoted to rules once validated.",
  },
  {
    id: "method",
    name: "Method",
    description:
      "Reusable reasoning rules that hold independent of this stack — how to diagnose, what counts as proof, which inferences are unsound.",
  },
  {
    id: "use-service",
    name: "Use: Service",
    description:
      "How outside consumers use the service this node offers — the node's external surface. Declare further `use-*` shelves per node in repo-spec.",
  },
  {
    id: "build-agents",
    name: "Build: Agents",
    description:
      "The node's agent substrate — its agents, graphs, tools, prompts, and the knowledge and work-item planes that serve them.",
  },
  {
    id: "build-product",
    name: "Build: Product",
    description:
      "How the node's product is built — its UI, data model, and the surfaces it serves to users.",
  },
];
