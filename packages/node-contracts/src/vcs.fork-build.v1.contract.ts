// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.fork-build.v1`
 * Purpose: Zod contract for the operator-dispatched, trusted-context fork-PR build
 *   request (POST /api/v1/vcs/fork-build). The external agent (read-only on GitHub)
 *   asks the operator App to dispatch `pr-build.yml`'s `workflow_dispatch` trigger
 *   for an approved fork PR so its `pr-{N}-{sha}` images get built and become
 *   flightable (FORK_FREEDOM).
 * Scope: Input/output shapes only. No network calls; no GitHub API import.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape owned here.
 *   - NO_REPO_FROM_AGENT: the BASE repo (owner/repo where the workflow runs) is
 *     operator-resolved from env, never the request body (anti-spoof). The agent
 *     supplies only which fork tree to build: prNumber + headRepo + headSha.
 *   - HEAD_SHA_IS_40_HEX: the head SHA is fully pinned (no ref/branch) — the build
 *     is reproducible and the immutable pr-{N}-{sha} tag is deterministic.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/fork-build/route.ts,
 *   .github/workflows/pr-build.yml (workflow_dispatch trigger)
 * @public
 */

import { z } from "zod";

export const forkBuildOperation = {
  input: z.object({
    prNumber: z.number().int().positive(),
    // owner/name of the FORK head repo (e.g. "flock-leader/cogni").
    headRepo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    // Fully-pinned 40-char hex head SHA — the fork tree that gets built.
    headSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
  }),

  output: z.object({
    dispatched: z.literal(true),
    prNumber: z.number().int().positive(),
    headRepo: z.string(),
    headSha: z.string(),
    workflowUrl: z.string(),
    message: z.string(),
  }),
} as const;
