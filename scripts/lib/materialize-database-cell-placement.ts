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
  DatabaseCellLogicalProbeFunctionSchema,
  DatabaseRecoveryCellAdminBindingSchema,
  DatabaseRecoveryCellProbeBindingSchema,
  DatabaseRecoveryCellReadmitBindingSchema,
} from "../../nodes/operator/app/src/shared/secrets/database-cell-binding.data";

import {
  AppliedDatabaseCellReceiptSchema,
  DatabaseCellAppliedEvidenceBundleSchema,
  DatabaseCellNativeControlObservationSchema,
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
    controlMaterial: z
      .object({ actuatorDsn: z.string().url(), readmitDsn: z.string().url() })
      .strict()
      .optional(),
    evidenceBundle: DatabaseCellAppliedEvidenceBundleSchema.optional(),
    requireApplied: z.boolean().optional(),
  })
  .strict();

export function projectDatabaseCellPlacement(input: unknown) {
  if (typeof input === "object" && input !== null && "custody" in input) {
    const {
      receipt,
      custody,
      requireApplied,
      controlMaterial,
      evidenceBundle,
    } = AppliedInputSchema.parse(input);

    const b = receipt.binding;
    if (
      !receipt.registration ||
      b.phase !== "applied" ||
      b.environment !== "production" ||
      receipt.allocationEnvironment !== "production" ||
      b.nodeId !== custody.nodeId ||
      b.nodeSlug !== custody.nodeSlug ||
      b.sourceSha !== undefined ||
      JSON.stringify(b.manualProvenance) !==
        JSON.stringify(custody.manualProvenance) ||
      b.appliedSdlHash !== custody.manualProvenance.managedSdlSha256 ||
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
      receipt.registration.tlsTrustKind !== custody.tls.kind ||
      JSON.stringify(receipt.registration.runtimePoolLimits) !==
        JSON.stringify(custody.runtimePoolLimits)
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
    const control = b.nativeControl;
    if (
      JSON.stringify(control) !==
      JSON.stringify(custody.nativeControl?.provenance)
    )
      throw new Error(
        "registered native control differs from current owned custody"
      );
    let nativeProjection:
      | {
          probe: z.infer<typeof DatabaseRecoveryCellProbeBindingSchema>;
          admin: z.infer<typeof DatabaseRecoveryCellAdminBindingSchema>;
          readmit: z.infer<typeof DatabaseRecoveryCellReadmitBindingSchema>;
        }
      | undefined;
    if (control && controlMaterial && evidenceBundle) {
      const artifact = evidenceBundle.artifacts.find(
        (entry) => entry.kind === "native-control-qualification"
      );
      if (
        !artifact ||
        artifact.sha256 !== control.qualificationReceiptSha256 ||
        evidenceBundle.nodeId !== b.nodeId ||
        evidenceBundle.environment !== b.environment
      )
        throw new Error("actual native control qualification bytes required");
      const qualified = DatabaseCellNativeControlObservationSchema.parse(
        JSON.parse(Buffer.from(artifact.bytesBase64, "base64").toString("utf8"))
      );
      const fingerprints = (
        values: readonly { signature: string; definitionSha256: string }[]
      ) =>
        JSON.stringify(
          [...values]
            .map(({ signature, definitionSha256 }) => ({
              signature,
              definitionSha256,
            }))
            .sort((a, b) => a.signature.localeCompare(b.signature))
        );
      if (
        qualified.observedAt !== control.qualifiedAt ||
        qualified.installedAt !== control.installedAt ||
        qualified.nodeId !== b.nodeId ||
        qualified.nodeSlug !== b.nodeSlug ||
        qualified.environment !== b.environment ||
        qualified.systemIdentifier !== b.systemIdentifier ||
        qualified.databaseName !== b.databaseName ||
        qualified.allocationReceiptId !== b.receiptId ||
        qualified.dseq !== b.dseq ||
        qualified.providerAccount !== b.providerAccount ||
        qualified.reviewedSourceSha !== control.reviewedSourceSha ||
        qualified.migrationManifestSha256 !== control.migrationManifestSha256 ||
        qualified.admission.manualPacketSha256 !==
          receipt.registration.manualCutoverPacketSha256 ||
        qualified.admission.readmissionReceiptSha256 !==
          receipt.registration.readmissionReceiptId ||
        qualified.logicalProbeFunction.definitionSha256 !==
          control.logicalProbeDefinitionSha256 ||
        fingerprints(qualified.requiredFunctions) !==
          fingerprints(control.functions)
      )
        throw new Error(
          "native control receipt differs from registered immutable installation"
        );
      if (!custody.nativeControl || !custody.readOnlyProbe || !b.probeRole)
        throw new Error(
          "qualified native logical and control probe custody required"
        );
      const common = {
        version: 2 as const,
        scope: "dedicated-cell" as const,
        nodeId: b.nodeId,
        nodeSlug: b.nodeSlug,
        environment: b.environment,
        databaseName: b.databaseName,
        probeRole: b.probeRole,
        systemIdentifier: b.systemIdentifier,
        substrateHost: b.failureDomainId,
        targetBuildSha: receipt.targetBuildSha,
        endpoint: { host: b.endpoint.host, port: b.endpoint.port },
        allocationReceiptId: b.receiptId,
        dseq: b.dseq,
        providerAccount: b.providerAccount,
        controlDatabaseName: "postgres" as const,
        nativeControl: control,
        tlsTrustKind: custody.tls.kind,
        ...(custody.tls.kind === "private-ca"
          ? { tlsCaCertificate: custody.tls.caCertificate }
          : {}),
      };
      nativeProjection = {
        probe: DatabaseRecoveryCellProbeBindingSchema.parse({
          ...common,
          dsn: custody.nativeControl.probe.dsn,
          logicalProbeDsn: custody.readOnlyProbe.dsn,
          logicalProbeCustody: {
            ...custody.readOnlyProbe.custodyRef,
            dsnSha256: sha(custody.readOnlyProbe.dsn),
          },
          logicalProbeFunction: DatabaseCellLogicalProbeFunctionSchema.parse(
            qualified.logicalProbeFunction
          ),
        }),
        admin: DatabaseRecoveryCellAdminBindingSchema.parse({
          ...common,
          dsn: controlMaterial.actuatorDsn,
        }),
        readmit: DatabaseRecoveryCellReadmitBindingSchema.parse({
          ...common,
          dsn: controlMaterial.readmitDsn,
        }),
      };
    }
    if (requireApplied && !nativeProjection)
      throw new Error(
        "manual cell placement activation requires real reviewed native control projections"
      );
    return {
      privatePlan: publicValues,
      publicValues,
      ...(custody.runtimePoolLimits
        ? { runtimePoolLimits: custody.runtimePoolLimits }
        : {}),
      probe: nativeProjection?.probe ?? null,
      admin: nativeProjection?.admin ?? null,
      readmit: nativeProjection?.readmit ?? null,
      retireSourceBinding: nativeProjection
        ? {
            nodeId: b.nodeId,
            environment: b.environment,
            systemIdentifier: receipt.registration.sourceSystemIdentifier,
          }
        : null,
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
    retireSourceBinding: null,
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

/** Explicit owner-only phase: component material, never native installation or activation. */
export function composeDatabaseCellControlComponents(input: unknown) {
  const value = AppliedInputSchema.extend({
    actuatorPassword: z.string().regex(/^[0-9a-f]{64}$/),
    readmitPassword: z.string().regex(/^[0-9a-f]{64}$/),
  })
    .strict()
    .parse(input);
  if (value.actuatorPassword === value.readmitPassword)
    throw new Error("control roles require distinct generated credentials");
  projectDatabaseCellPlacement({
    receipt: value.receipt,
    custody: value.custody,
  });
  const { receipt, custody } = value;
  if (custody.nativeControl || receipt.binding.nativeControl)
    throw new Error("installed control custody cannot be reminted");
  if (!custody.readOnlyProbe)
    throw new Error("actual scoped logical probe custody required");
  const probe = new URL(custody.readOnlyProbe.dsn);
  probe.pathname = "/postgres";
  const endpoint = receipt.binding.endpoint;
  return {
    nodeId: custody.nodeId,
    nodeSlug: custody.nodeSlug,
    environment: custody.environment,
    components: [
      {
        service: `${custody.nodeSlug}-database-recovery-probe`,
        key: "DATABASE_CELL_CONTROL_PROBE_URL",
        value: probe.href,
      },
      {
        service: `${custody.nodeSlug}-database-cell-actuator`,
        key: "DATABASE_CELL_ACTUATOR_PASSWORD",
        value: value.actuatorPassword,
      },
      {
        service: `${custody.nodeSlug}-database-cell-actuator`,
        key: "DATABASE_CELL_ACTUATOR_URL",
        value: composeDatabaseCellDsn(
          endpoint,
          "postgres",
          "database_reliability_actuator",
          value.actuatorPassword
        ),
      },
      {
        service: `${custody.nodeSlug}-database-cell-readmitter`,
        key: "DATABASE_CELL_READMIT_PASSWORD",
        value: value.readmitPassword,
      },
      {
        service: `${custody.nodeSlug}-database-cell-readmitter`,
        key: "DATABASE_CELL_READMIT_URL",
        value: composeDatabaseCellDsn(
          endpoint,
          "postgres",
          "database_reliability_readmitter",
          value.readmitPassword
        ),
      },
    ],
  };
}

if (process.argv[1]?.endsWith("materialize-database-cell-placement.ts")) {
  try {
    process.stdout.write(
      JSON.stringify(
        process.argv[2] === "--control-components"
          ? composeDatabaseCellControlComponents(
              JSON.parse(readFileSync(0, "utf8"))
            )
          : process.argv[2] === "--validate-evidence"
            ? DatabaseCellAppliedEvidenceBundleSchema.parse(
                JSON.parse(readFileSync(0, "utf8"))
              )
            : process.argv[2] === "--validate-applied-custody"
              ? DatabaseCellAppliedCustodySchema.parse(
                  JSON.parse(readFileSync(0, "utf8"))
                )
              : projectDatabaseCellPlacement(
                  JSON.parse(readFileSync(0, "utf8"))
                )
      )
    );
  } catch {
    process.stderr.write("cell placement refused invalid audited custody\n");
    process.exitCode = 1;
  }
}
