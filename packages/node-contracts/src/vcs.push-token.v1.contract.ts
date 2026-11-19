// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.push-token.v1`
 * Purpose: Zod contract for the node-scoped push token (POST /api/v1/vcs/push-token): the operator App mints a short-lived installation token limited to ONE node repo with contents + pull_requests write, so an agent with no GitHub account (a node's AI sandbox) can push a branch and open a PR.
 * Scope: Input/output shapes only. Does not make network calls or import the GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.push-token.v1.contract.
 *   - NODE_ID_OR_SLUG: the agent supplies only the NODE; owner/repo are operator-resolved from the
 *     node's catalog `source_repo` (anti-spoof, never the body).
 *   - FIXED_PERMISSIONS: the token carries exactly PUSH_TOKEN_PERMISSIONS; never workflows, actions,
 *     administration or secrets.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/push-token/route.ts, https://node-template.cognidao.org/knowledge/node-ai-code-identity
 * @public
 */

import { z } from "zod";

export const PUSH_TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
} as const;

export const pushTokenOperation = {
  input: z.object({
    nodeId: z.string().min(1),
  }),

  output: z.object({
    token: z.string().min(1),
    expiresAt: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    permissions: z.object({
      contents: z.literal("write"),
      pull_requests: z.literal("write"),
    }),
  }),
} as const;
