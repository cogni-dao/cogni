// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/database-cell-recovery`
 * Purpose: Render the fixed cold recovery resource and bind its immutable intent.
 * Scope: Pure public recipe/reference policy; no credentials, provider or SQL IO.
 * Invariants: No PostgreSQL bootstrap/activation; one source-derived family; bounded money.
 * Side-effects: none
 * Links: bug.5540, https://cognidao.org/knowledge/akash-state-recovery
 */
import { createHash } from "node:crypto";
import type { ProvisionSpec } from "@cogni/ai-tools";
import { z } from "zod";
import type {
  AkashTxAllocationPolicy,
  AkashTxAllocationRecord,
  AkashTxDatabaseCellRecoveryInput,
} from "@/ports";

export const DatabaseCellRecoveryProfileSchema = z.strictObject({
  enabled: z.boolean(),
  // Qualification is separate from enablement: Console ignores requested deposit
  // and defaults to auto-funding. Production has no qualified budget policy yet.
  funding_status: z.enum(["unqualified", "qualified"]),
  cpu_units: z.literal(4),
  memory_mib: z.literal(16384),
  ephemeral_size_mib: z.literal(1024),
  persistent_size_mib: z.literal(204800),
  postgres_major: z.literal(15),
  image: z.literal(
    "postgres:15@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e"
  ),
  command: z.tuple([z.literal("sleep")]),
  args: z.tuple([z.literal("infinity")]),
  volume_name: z.literal("database"),
  mount_path: z.literal("/var/lib/postgresql/data"),
  pgdata: z.literal("/var/lib/postgresql/data/pgdata"),
  volume_tier: z.literal("nvme"),
  pricing_denom: z.literal("uact"),
  max_price_per_block: z.literal("100"),
  initial_escrow_usd: z.literal("0.5"),
});

const digest = (value: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function databaseCellRecoveryIntent(
  input: Omit<AkashTxDatabaseCellRecoveryInput, "cogniKey">,
  source: AkashTxAllocationRecord,
  profile: z.infer<typeof DatabaseCellRecoveryProfileSchema>
): {
  key: string;
  familyPrefix: string;
  spec: ProvisionSpec;
  policy: AkashTxAllocationPolicy;
} {
  const family = digest([
    "cogni.pg-recovery-family.v1",
    input.identity.nodeId,
    input.environment,
    source.receiptId,
    source.cogniKey,
    source.externalName,
    input.recovery.sourceSystemIdentifier,
  ]);
  const recipe = digest([
    profile.cpu_units,
    profile.memory_mib,
    profile.ephemeral_size_mib,
    profile.persistent_size_mib,
    profile.postgres_major,
    profile.image,
    profile.command,
    profile.args,
    profile.volume_name,
    profile.mount_path,
    profile.pgdata,
    profile.volume_tier,
    profile.pricing_denom,
    profile.max_price_per_block,
    profile.initial_escrow_usd,
  ]);
  const intent = digest([
    "cogni.pg-recovery.v1",
    family,
    input.recovery.profileId,
    recipe,
    profile.cpu_units,
    profile.memory_mib,
    profile.persistent_size_mib,
    profile.pricing_denom,
    profile.max_price_per_block,
    profile.initial_escrow_usd,
  ]);
  const familyPrefix = `pg-recover:v1:${input.identity.nodeId}:${input.environment}:${family}:`;
  return {
    familyPrefix,
    key: familyPrefix + intent,
    policy: { pricingDenom: "uact", pricingAmount: 100, initialEscrowUsd: 0.5 },
    spec: {
      name: `${input.nodeSlug}-database-cell`,
      retentionPolicy: "retain",
      services: [
        {
          name: "postgres",
          image: profile.image,
          cpuUnits: profile.cpu_units,
          memoryMi: profile.memory_mib,
          storageMi: profile.ephemeral_size_mib,
          command: [...profile.command],
          args: [...profile.args],
          env: { PGDATA: profile.pgdata },
          volumes: [
            {
              name: profile.volume_name,
              sizeMi: profile.persistent_size_mib,
              mountPath: profile.mount_path,
              tier: profile.volume_tier,
            },
          ],
          expose: [{ port: 5432, as: 5432, global: true }],
        },
      ],
    },
  };
}
