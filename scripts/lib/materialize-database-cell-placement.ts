// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/materialize-database-cell-placement`
 * Purpose: Derive scoped cell projections from an audited allocation binding and private component custody.
 * Scope: Validates JSON and composes values; does not query providers, mutate databases, or publish secrets.
 * Invariants: Readiness never changes public DSNs; only approved production cutover replaces the shared endpoint.
 * Side-effects: IO (CLI stdin/stdout)
 * Links: docs/spec/secrets-management.md, shared/secrets/database-cell-binding.data.ts
 * @internal
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

import {
  DatabaseCellBootstrapKitSchema,
  DatabaseRecoveryCellAdminBindingSchema,
  DatabaseRecoveryCellProbeBindingSchema,
  DatabaseRecoveryCellReadmitBindingSchema,
} from "../../nodes/operator/app/src/shared/secrets/database-cell-binding.data";

import { AppliedDatabaseCellReceiptSchema } from "../../nodes/operator/app/src/shared/secrets/database-cell-placement.data";

const InputSchema = z
  .object({
    receipt: AppliedDatabaseCellReceiptSchema,
    kit: DatabaseCellBootstrapKitSchema,
    backupEncryptionKey: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function projectDatabaseCellPlacement(input: unknown) {
  const { receipt, kit, backupEncryptionKey } = InputSchema.parse(input);
  const binding = receipt.binding;
  const lane = kit.logicalDatabases.find(
    (value) => value.environment === binding.environment
  );
  if (
    !lane ||
    binding.nodeId !== kit.nodeId ||
    binding.nodeSlug !== kit.nodeSlug ||
    receipt.allocationEnvironment !== kit.environment ||
    binding.sourceSha !== kit.sourceSha ||
    receipt.targetBuildSha !== lane.sourceSha ||
    binding.databaseName !== lane.databaseName ||
    binding.appRole !== lane.appRole ||
    binding.serviceRole !== lane.serviceRole ||
    binding.migrationRole !== lane.migrationRole ||
    binding.probeRole !== lane.probeRole ||
    binding.budgetProfile !== lane.budgetProfile ||
    binding.endpoint.tlsCertificateSha256 !==
      createHash("sha256").update(kit.tlsCertificate).digest("hex")
  ) {
    throw new Error("cell custody differs from the audited allocation binding");
  }
  if (
    binding.environment !== "production" ||
    receipt.allocationEnvironment !== "production"
  ) {
    throw new Error("cross-environment cell control is not enabled");
  }
  // The existing client requires measured DNS plus the unique CA supplied before
  // Node starts. A ready receipt with verify-ca remains private prestage only.
  if (binding.endpoint.tlsMode !== "verify-full") {
    throw new Error("cell endpoint has not completed strict DNS TLS sealing");
  }
  const url = (role: string, password: string, database: string) => {
    const value = new URL(
      `postgresql://${binding.endpoint.host}:${binding.endpoint.port}`
    );
    value.username = role;
    value.password = password;
    value.pathname = `/${database}`;
    value.searchParams.set("sslmode", "verify-full");
    return value.href;
  };
  const common = {
    scope: "dedicated-cell" as const,
    nodeId: binding.nodeId,
    nodeSlug: binding.nodeSlug,
    environment: binding.environment,
    databaseName: binding.databaseName,
    probeRole: binding.probeRole,
    systemIdentifier: binding.systemIdentifier,
    substrateHost: binding.failureDomainId,
    sourceSha: binding.sourceSha,
    targetBuildSha: receipt.targetBuildSha,
    endpoint: {
      host: binding.endpoint.host,
      port: binding.endpoint.port,
    },
    tlsCaCertificate: kit.tlsCaCertificate,
  };
  const probe = DatabaseRecoveryCellProbeBindingSchema.parse({
    ...common,
    dsn: url(lane.probeRole, lane.probePassword, lane.databaseName),
  });
  const admin = DatabaseRecoveryCellAdminBindingSchema.parse({
    ...common,
    dsn: url("database_reliability_actuator", kit.actuatorPassword, "postgres"),
  });
  const readmit = DatabaseRecoveryCellReadmitBindingSchema.parse({
    ...common,
    dsn: url(
      "database_reliability_readmitter",
      kit.readmitPassword,
      "postgres"
    ),
  });
  const publicValues = {
    DATABASE_URL: url(lane.appRole, lane.appPassword, lane.databaseName),
    DATABASE_SERVICE_URL: url(
      lane.serviceRole,
      lane.servicePassword,
      lane.databaseName
    ),
    DATABASE_MIGRATION_URL: url(
      lane.migrationRole,
      lane.migrationPassword,
      lane.databaseName
    ),
    DATABASE_SSL_CA_CERT: kit.tlsCaCertificate,
  };
  return {
    privatePlan: publicValues,
    // No public writer may consume privatePlan on readiness alone.
    publicValues: binding.phase === "applied" ? publicValues : null,
    probe,
    admin,
    readmit,
    backup: {
      version: 1,
      nodeId: binding.nodeId,
      environment: binding.environment,
      databaseName: binding.databaseName,
      systemIdentifier: binding.systemIdentifier,
      dsn: url(lane.backupRole, lane.backupPassword, lane.databaseName),
      tlsCaCertificate: kit.tlsCaCertificate,
      encryptionKey: backupEncryptionKey,
    },
  };
}

if (process.argv[1]?.endsWith("materialize-database-cell-placement.ts")) {
  try {
    process.stdout.write(
      JSON.stringify(
        projectDatabaseCellPlacement(JSON.parse(readFileSync(0, "utf8")))
      )
    );
  } catch {
    process.stderr.write("cell placement refused invalid audited custody\n");
    process.exitCode = 1;
  }
}
