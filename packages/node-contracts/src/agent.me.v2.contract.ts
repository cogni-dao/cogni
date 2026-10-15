// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.me.v2.contract`
 * Purpose: Self-introspection for human sessions, legacy agents, and durable agents.
 * Scope: Identity, credential liveness, and directly assigned node roles only; does not grant or mutate access.
 * Invariants: SELF_ONLY; CREDENTIAL_NE_PRINCIPAL; HUMAN_AND_AGENT_ARE_DISTINCT.
 * Side-effects: none
 * Links: story.5075, task.5252, https://cognidao.org/knowledge/human-ai-identity-standard
 * @public
 */

import { z } from "zod";
import {
  agentRequestPrincipalSchema,
  humanRequestPrincipalSchema,
  legacyAgentRequestPrincipalSchema,
} from "./agent.credentials.v1.contract";

const grantsSchema = z.object({
  grantsAvailable: z.boolean(),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      roles: z.array(z.string()),
    })
  ),
});

const humanOutputSchema = grantsSchema.extend({
  identity: humanRequestPrincipalSchema,
  credential: z.null(),
});

const legacyAgentOutputSchema = grantsSchema.extend({
  identity: legacyAgentRequestPrincipalSchema,
  credential: z.object({
    kind: z.literal("legacy_v1"),
    expiresAt: z.string().datetime(),
    renewUntil: z.null(),
    status: z.literal("active"),
  }),
});

const durableAgentOutputSchema = grantsSchema.extend({
  identity: agentRequestPrincipalSchema,
  credential: z.object({
    kind: z.literal("durable_v2"),
    expiresAt: z.string().datetime(),
    renewUntil: z.string().datetime(),
    status: z.enum(["active", "renew_only"]),
  }),
});

export const agentMeV2OutputSchema = z.discriminatedUnion("kind", [
  humanOutputSchema.extend({ kind: z.literal("human") }),
  legacyAgentOutputSchema.extend({ kind: z.literal("legacy_agent") }),
  durableAgentOutputSchema.extend({ kind: z.literal("agent") }),
]);

export type AgentMeV2Output = z.infer<typeof agentMeV2OutputSchema>;

export const agentMeV2Operation = {
  id: "agent.me.v2",
  summary: "Authenticated caller identity, credential liveness, and grants",
  description:
    "Returns the exact calling principal without coercing durable agents into users. Durable credential rotation changes credentialId, never principalId.",
  input: null,
  output: agentMeV2OutputSchema,
} as const;
