// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/database-cell-placement.data`
 * Purpose: Bind a logical database's native incident to its truthful physical allocation receipt.
 * Scope: Pure schemas and types; does not allocate resources or authorize cutover.
 * Invariants: Physical allocation environment and operator source remain separate from logical environment and app build.
 * Side-effects: none
 * Links: shared/secrets/database-cell-binding.data.ts, shared/db/akash-tx-allocations.ts
 * @internal
 */
import { z } from "zod";

import { DatabaseCellBindingSchema } from "./database-cell-binding.data";

export const AppliedDatabaseCellReceiptSchema = z
  .object({
    allocationEnvironment: z.enum(["candidate-a", "preview", "production"]),
    targetBuildSha: z.string().regex(/^[0-9a-f]{40}$/),
    initialIncidentId: z.string().min(1).max(256),
    binding: DatabaseCellBindingSchema,
  })
  .strict();
export const AppliedDatabaseCellReceiptsSchema = z
  .array(AppliedDatabaseCellReceiptSchema)
  .max(3)
  .superRefine((receipts, ctx) => {
    const seen = new Set<string>();
    for (const receipt of receipts) {
      const identity = `${receipt.binding.nodeId}/${receipt.binding.environment}`;
      if (seen.has(identity)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate logical cell receipt",
        });
      }
      seen.add(identity);
    }
  });
export type { AppliedDatabaseCellReceipt } from "@/types/database-cell";
