// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/authorization-facade.v1`
 * Purpose: Strict wire contracts for the node-scoped operator authorization facade.
 * Scope: Same-node account reads, exact-account direct tool execution and semantic grants.
 * Invariants: NO_NODE_ID_INPUT; NO_RAW_TUPLES; UUID_LOCAL_IDS; STRICT_INPUT.
 * Side-effects: none
 * Links: task.5226, docs/spec/rbac.md
 * @public
 */

import { z } from "zod";

const LocalIdSchema = z.string().uuid();
const ToolIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
const RequestIdSchema = z.string().min(1).max(160);

const ActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), id: LocalIdSchema }),
  z.strictObject({ kind: z.literal("agent"), id: LocalIdSchema }),
]);

const TargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), id: LocalIdSchema }),
  z.strictObject({ kind: z.literal("agent"), id: LocalIdSchema }),
]);

const CheckContextSchema = z.strictObject({
  runId: z.string().min(1).max(160).optional(),
  toolCallId: z.string().min(1).max(160).optional(),
});

const AuthzSubcheckSchema = z.strictObject({
  name: z.enum(["permission", "delegation"]),
  user: z.string(),
  relation: z.string(),
  object: z.string(),
  decision: z.enum(["allow", "deny"]),
  code: z.enum(["authz_allowed", "authz_denied", "authz_unavailable"]),
});

const AuthzDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("allow"),
    code: z.literal("authz_allowed"),
    checks: z.array(AuthzSubcheckSchema),
  }),
  z.strictObject({
    decision: z.literal("deny"),
    code: z.enum(["authz_denied", "authz_unavailable"]),
    checks: z.array(AuthzSubcheckSchema),
    reason: z.string().optional(),
  }),
]);

export const authorizationFacadeCheckOperation = {
  id: "authorization.facade.check.v1",
  input: z
    .strictObject({
      actor: ActorSchema,
      action: z.enum(["billing_account.read", "tool.execute"]).optional(),
      toolId: ToolIdSchema.optional(),
      subjectUserId: LocalIdSchema.optional(),
      billingAccountId: LocalIdSchema,
      context: CheckContextSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if ((value.action === "tool.execute") !== (value.toolId !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["toolId"],
          message:
            "tool.execute requires an exact toolId; account reads do not accept it",
        });
      }
      if (
        value.action === "tool.execute" &&
        value.subjectUserId !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["subjectUserId"],
          message: "Delegated tool execution is not supported",
        });
      }
      if (value.subjectUserId !== undefined && value.actor.kind !== "agent") {
        ctx.addIssue({
          code: "custom",
          path: ["subjectUserId"],
          message: "subjectUserId is valid only for an agent actor",
        });
      }
    }),
  output: AuthzDecisionSchema,
} as const;

const GrantInputSchema = z.strictObject({
  operation: z.literal("grant"),
  grantorUserId: LocalIdSchema,
  billingAccountId: LocalIdSchema,
  target: TargetSchema,
  role: z.enum(["reader", "obo", "tool_executor"]),
  toolId: ToolIdSchema.optional(),
  subjectUserId: LocalIdSchema.optional(),
  expiresAt: z.string().datetime(),
  requestId: RequestIdSchema.optional(),
});

const RevokeInputSchema = z.strictObject({
  operation: z.literal("revoke"),
  grantorUserId: LocalIdSchema,
  billingAccountId: LocalIdSchema,
  target: TargetSchema,
  role: z.enum(["reader", "obo", "tool_executor"]),
  toolId: ToolIdSchema.optional(),
  subjectUserId: LocalIdSchema.optional(),
  requestId: RequestIdSchema.optional(),
});

const SemanticGrantInputSchema = z
  .discriminatedUnion("operation", [GrantInputSchema, RevokeInputSchema])
  .superRefine((value, ctx) => {
    if ((value.role === "tool_executor") !== (value.toolId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["toolId"],
        message: "Only tool_executor accepts and requires toolId",
      });
    }
    if (value.role === "obo") {
      if (value.target.kind !== "agent") {
        ctx.addIssue({
          code: "custom",
          path: ["target", "kind"],
          message: "OBO access requires an agent target",
        });
      }
      if (value.subjectUserId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["subjectUserId"],
          message: "OBO access requires subjectUserId",
        });
      }
    } else if (value.subjectUserId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectUserId"],
        message: "direct access does not accept subjectUserId",
      });
    }
  });

const AuthzWriteDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("success"),
    code: z.literal("authz_write_success"),
  }),
  z.strictObject({
    decision: z.literal("failure"),
    code: z.enum(["authz_write_denied", "authz_write_unavailable"]),
    reason: z.string().optional(),
  }),
]);

export const authorizationFacadeGrantOperation = {
  id: "authorization.facade.billing-account-grant.v1",
  input: SemanticGrantInputSchema,
  output: AuthzWriteDecisionSchema,
} as const;

export type AuthorizationFacadeCheckInput = z.infer<
  typeof authorizationFacadeCheckOperation.input
>;
export type AuthorizationFacadeGrantInput = z.infer<
  typeof authorizationFacadeGrantOperation.input
>;
