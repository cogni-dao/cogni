// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/database-cell-binding.v1`
 * Purpose: Validate reference-only private cell seal/read and explicit reviewed cutover requests.
 * Scope: Wire schemas only; does not accept credentials, endpoints, provider handles, or native identity assertions.
 * Invariants: The existing actuator derives every cell identity fact; cutover carries an explicit human review packet.
 * Side-effects: none
 * Links: ports/database-cell-binding.port.ts, features/compute/akash-tx/database-cell-binding.ts
 * @internal
 */
import { z } from "zod";

export const DatabaseCellBindingReferenceSchema = z
  .object({
    cogniKey: z.string().min(1).max(512),
    nodeId: z.string().uuid(),
    allocationEnvironment: z.enum(["candidate-a", "preview", "production"]),
  })
  .strict();
export const DatabaseCellCutoverReferenceSchema =
  DatabaseCellBindingReferenceSchema.extend({
    packetSha256: z.string().regex(/^[0-9a-f]{64}$/),
    actorId: z.string().regex(/^human:[a-zA-Z0-9._@:-]{1,120}$/),
  });

export const DatabaseCellBindingIdentitySchema =
  DatabaseCellBindingReferenceSchema.omit({ cogniKey: true });

/** References only; authorization and measured facts come from trusted evidence custody. */
export const DatabaseCellAppliedRegistrationReferenceSchema =
  DatabaseCellBindingReferenceSchema.extend({
    manualCutoverPacketSha256: z.string().regex(/^[0-9a-f]{64}$/),
    registrationKind: z.literal("legacy-physical").optional(),
    readmissionReceiptId: z.string().min(1).max(256).optional(),
  }).superRefine((value, ctx) => {
    if (
      value.registrationKind === "legacy-physical"
        ? value.readmissionReceiptId !== undefined
        : !value.readmissionReceiptId
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Legacy physical references forbid invented readmission; ordinary references require genuine readmission",
      });
  });
