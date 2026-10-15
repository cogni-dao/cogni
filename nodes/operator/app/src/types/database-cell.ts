// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@types/database-cell`
 * Purpose: Define cell identity types shared by ports and runtime parsers at the bottom of the dependency tree.
 * Scope: Interfaces only; does not validate values, allocate resources, or publish secrets.
 * Invariants: Physical allocation identity remains distinct from the logical application build and environment.
 * Side-effects: none
 * Links: shared/secrets/database-cell-binding.data.ts, ports/database-cell-binding.port.ts
 * @public
 */
export type CellEnvironment = "candidate-a" | "preview" | "production";
export interface DatabaseCellBinding {
  version: 1;
  phase: "ready" | "applied" | "superseded";
  receiptId: string;
  cogniKey: string;
  nodeId: string;
  nodeSlug: string;
  environment: CellEnvironment;
  provider: "akash";
  dseq: string;
  providerAccount: string;
  endpoint: {
    host: string;
    port: number;
    tlsMode: "verify-ca" | "verify-full";
    tlsCertificateSha256: string;
  };
  databaseName: string;
  appRole: string;
  serviceRole: string;
  migrationRole: string;
  probeRole: string;
  systemIdentifier: string;
  failureDomainId: string;
  sourceSha: string;
  budgetProfile: string;
  appliedSdlHash: string;
  readyAt: string;
  cutover?:
    | { packetSha256: string; actorId: string; approvedAt: string }
    | undefined;
}
export interface DatabaseCellBudget {
  appConnectionLimit: number;
  appStatementTimeoutMs: number;
  serviceConnectionLimit: number;
  serviceStatementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  tempFileLimitMiB: number;
  workMemMiB: number;
}
export interface DatabaseCellLogicalDatabase {
  environment: CellEnvironment;
  databaseName: string;
  appRole: string;
  serviceRole: string;
  migrationRole: string;
  probeRole: string;
  backupRole: string;
  sourceSha: string;
  budgetProfile: "shared-default-v1" | "dedicated-high-throughput-v1";
  budget: DatabaseCellBudget;
  appPassword: string;
  servicePassword: string;
  migrationPassword: string;
  probePassword: string;
  backupPassword: string;
}
export interface DatabaseCellBootstrapKit {
  version: 1;
  nodeId: string;
  nodeSlug: string;
  environment: CellEnvironment;
  sourceSha: string;
  rootPassword: string;
  actuatorPassword: string;
  readmitPassword: string;
  tlsCaCertificate: string;
  tlsCertificate: string;
  tlsPrivateKey: string;
  /** Owned canonical DNS alias; native endpoint proof must link it to the paid lease. */
  canonicalEndpointHost?: string | undefined;
  logicalDatabases: DatabaseCellLogicalDatabase[];
  diagnostic?:
    | {
        sourceDatabaseName: string;
        databaseName: string;
        replayRole: string;
        replayPassword: string;
        targetBuildSha: string;
      }
    | undefined;
}
export interface AppliedDatabaseCellReceipt {
  allocationEnvironment: CellEnvironment;
  targetBuildSha: string;
  initialIncidentId?: string | undefined;
  registration?:
    | {
        kind: "audited-manual";
        readmissionReceiptId: string;
        manualCutoverPacketSha256: string;
        scheduledBackupReceiptSha256: string;
        independentRecoveryReceiptSha256: string;
        appAllocationReceiptId: string;
        appSdlHash: string;
        migrationConsumer: "app-database-url" | "dedicated-migration-url";
        tlsTrustKind: "system" | "private-ca";
        registeredAt: string;
      }
    | undefined;
  binding: DatabaseCellBinding;
}

/** Facts measured on the authenticated connection to the owned paid endpoint. */
export interface DatabaseCellEndpointIdentity {
  readonly observedAt: string;
  readonly provider: {
    readonly host: string;
    readonly port: number;
    readonly addresses: readonly string[];
  };
  readonly canonical: {
    readonly host: string;
    readonly port: number;
    readonly addresses: readonly string[];
  };
  readonly peerCertificateDerSha256: string;
  readonly systemIdentifier: string;
}

export interface DatabaseCellAppliedRegistrationFacts {
  readonly observedAt: string;
  readonly provider: {
    readonly dseq: string;
    readonly providerAccount: string;
    readonly appliedSdlHash: string;
  };
  readonly native: {
    readonly databaseName: string;
    readonly systemIdentifier: string;
    readonly appRole: string;
    readonly serviceRole: string;
    readonly runtimeRoles: readonly {
      readonly name: string;
      readonly canLogin: boolean;
      readonly connectionLimit: number;
    }[];
    readonly activeRuntimeSessions: number;
    readonly serverVersionNum: number;
    readonly tlsTrustKind: "system" | "private-ca";
    readonly endpointIdentity: DatabaseCellEndpointIdentity;
  };
  readonly effectiveApp: {
    readonly allocationReceiptId: string;
    readonly deployedSourceSha: string;
    readonly appliedSdlHash: string;
    readonly nodeId: string;
    readonly environment: "production";
    readonly regions: readonly {
      readonly region: string;
      readonly status: number;
      readonly buildSha: string;
      readonly observedAt: string;
    }[];
    readonly appDsnSha256: string;
    readonly serviceDsnSha256: string;
    readonly migrationDsnSha256: string;
    readonly tlsCaSha256?: string | undefined;
    readonly tlsTrustKind: "system" | "private-ca";
    readonly migrationConsumer: "app-database-url" | "dedicated-migration-url";
    readonly readinessReceiptSha256: string;
  };
  readonly manualCutover: {
    readonly packetSha256: string;
    readonly purpose: "production-primary";
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: "production";
    readonly cellSourceSha: string;
    readonly appAllocationReceiptId: string;
    readonly appSdlHash: string;
    readonly expectedRelations: readonly string[];
    readonly allocationReceiptId: string;
    readonly systemIdentifier: string;
    readonly appSourceSha: string;
    readonly sourceFenceReceiptSha256: string;
    readonly restorationParityManifestSha256: string;
    readonly authorizedActorId: string;
    readonly approvedAt: string;
  };
  readonly readmission: {
    readonly receiptId: string;
    readonly packetSha256: string;
    readonly allocationReceiptId: string;
    readonly systemIdentifier: string;
    readonly admittedAt: string;
    readonly authorizedActorId: string;
  };
  readonly scheduledBackup: {
    readonly receiptSha256: string;
    readonly databaseName: string;
    readonly systemIdentifier: string;
    readonly archiveSha256: string;
    readonly archiveBytes: number;
    readonly snapshotStartedAt: string;
    readonly completedAt: string;
    readonly verifiedArchiveReceiptSha256: string;
    readonly schedulerUnitSha256: string;
    readonly executorFailureDomainId: string;
    readonly fullSchemaFingerprintSha256: string;
    readonly fullDataFingerprintSha256: string;
    readonly sequenceStateFingerprintSha256: string;
    readonly relations: readonly string[];
    readonly rowCount: string;
  };
  readonly independentRecovery: {
    readonly receiptSha256: string;
    readonly archiveSha256: string;
    readonly restoredSystemIdentifier: string;
    readonly providerAccount: string;
    readonly dseq: string;
    readonly recoveryFailureDomainId: string;
    readonly completedAt: string;
    readonly fullSchemaFingerprintSha256: string;
    readonly fullDataFingerprintSha256: string;
    readonly sequenceStateFingerprintSha256: string;
    readonly relations: readonly string[];
    readonly rowCount: string;
  };
}
