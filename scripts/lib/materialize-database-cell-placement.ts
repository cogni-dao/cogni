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
  composeDatabaseCellDsn,
  DatabaseCellAppliedCustodySchema,
  DatabaseCellBootstrapKitSchema,
  DatabaseRecoveryCellAdminBindingSchema,
  DatabaseRecoveryCellProbeBindingSchema,
  DatabaseRecoveryCellReadmitBindingSchema,
} from "../../nodes/operator/app/src/shared/secrets/database-cell-binding.data";

import {
  AppliedDatabaseCellReceiptSchema,
  DatabaseCellAppliedEvidenceBundleSchema,
} from "../../nodes/operator/app/src/shared/secrets/database-cell-placement.data";

const InputSchema = z
  .object({
    receipt: AppliedDatabaseCellReceiptSchema,
    kit: DatabaseCellBootstrapKitSchema,
    backupEncryptionKey: z.string().regex(/^[0-9a-f]{64}$/),
    requireApplied: z.boolean().optional(),
  })
  .strict();

const AppliedInputSchema = z
  .object({
    receipt: AppliedDatabaseCellReceiptSchema,
    custody: DatabaseCellAppliedCustodySchema,
    requireApplied: z.boolean().optional(),
  })
  .strict();

export function projectDatabaseCellPlacement(input: unknown) {
  if (typeof input === "object" && input !== null && "custody" in input) {
    const { receipt, custody } = AppliedInputSchema.parse(input);
    const b = receipt.binding;
    if (
      !receipt.registration ||
      b.phase !== "applied" ||
      b.environment !== "production" ||
      receipt.allocationEnvironment !== "production" ||
      b.nodeId !== custody.nodeId ||
      b.nodeSlug !== custody.nodeSlug ||
      b.sourceSha !== custody.sourceSha ||
      receipt.targetBuildSha !== custody.targetBuildSha ||
      b.databaseName !== custody.databaseName ||
      b.appRole !== custody.appRole ||
      b.serviceRole !== custody.serviceRole ||
      b.budgetProfile !== custody.budgetProfile ||
      b.endpoint.host !== custody.canonicalEndpointHost ||
      b.endpoint.tlsMode !== "verify-full" ||
      b.endpoint.port !== Number(new URL(custody.app.dsn).port) ||
      b.endpoint.port !== Number(new URL(custody.service.dsn).port) ||
      b.endpoint.tlsCertificateSha256 !==
        createHash("sha256").update(custody.tlsCertificate).digest("hex") ||
      receipt.registration.migrationConsumer !== custody.migration.kind ||
      receipt.registration.tlsTrustKind !== custody.tls.kind
    )
      throw new Error(
        "applied consumer custody differs from audited current binding"
      );
    const migrationDsn =
      custody.migration.kind === "app-database-url"
        ? custody.app.dsn
        : custody.migration.dsn;
    if (
      (custody.migration.kind === "app-database-url" &&
        b.migrationRole !== undefined) ||
      (custody.migration.kind === "dedicated-migration-url" &&
        (b.migrationRole !==
          decodeURIComponent(new URL(migrationDsn).username) ||
          b.endpoint.port !== Number(new URL(migrationDsn).port)))
    )
      throw new Error(
        "applied migration consumer differs from audited binding"
      );
    const sha = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    if (
      receipt.registration.appDsnSha256 !== sha(custody.app.dsn) ||
      receipt.registration.serviceDsnSha256 !== sha(custody.service.dsn) ||
      receipt.registration.migrationDsnSha256 !== sha(migrationDsn) ||
      (custody.tls.kind === "private-ca"
        ? receipt.registration.tlsCaSha256 !== sha(custody.tls.caCertificate)
        : receipt.registration.tlsCaSha256 !== undefined)
    )
      throw new Error(
        "applied consumer bytes differ from authenticated custody"
      );
    const publicValues = {
      DATABASE_URL: custody.app.dsn,
      DATABASE_SERVICE_URL: custody.service.dsn,
      DATABASE_MIGRATION_URL: migrationDsn,
      ...(custody.tls.kind === "private-ca"
        ? { DATABASE_SSL_CA_CERT: custody.tls.caCertificate }
        : {}),
    };
    // A manual import proves current consumers, not nonexistent control credentials.
    return {
      privatePlan: publicValues,
      publicValues,
      probe: null,
      admin: null,
      readmit: null,
      backup: null,
    };
  }
  return projectBootstrapPlacement(input);
}

function projectBootstrapPlacement(input: unknown) {
  const { receipt, kit, backupEncryptionKey, requireApplied } =
    InputSchema.parse(input);
  if (receipt.registration)
    throw new Error(
      "audited manual cells require actual applied consumer custody"
    );
  const binding = receipt.binding;
  if (requireApplied && binding.phase !== "applied") {
    throw new Error(
      "declared cell placement requires its applied audited binding"
    );
  }
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
  const url = (role: string, password: string, database: string) =>
    composeDatabaseCellDsn(binding.endpoint, database, role, password);
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
        process.argv[2] === "--validate-evidence"
          ? DatabaseCellAppliedEvidenceBundleSchema.parse(
              JSON.parse(readFileSync(0, "utf8"))
            )
          : process.argv[2] === "--validate-applied-custody"
            ? DatabaseCellAppliedCustodySchema.parse(
                JSON.parse(readFileSync(0, "utf8"))
              )
            : projectDatabaseCellPlacement(JSON.parse(readFileSync(0, "utf8")))
      )
    );
  } catch {
    process.stderr.write("cell placement refused invalid audited custody\n");
    process.exitCode = 1;
  }
}
