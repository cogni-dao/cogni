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
interface DatabaseCellBindingBase {
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
  migrationRole?: string | undefined;
  probeRole?: string | undefined;
  systemIdentifier: string;
  failureDomainId: string;
  budgetProfile: string;
  appliedSdlHash: string;
  readyAt: string;
  cutover?:
    | { packetSha256: string; actorId: string; approvedAt: string }
    | undefined;
  /** Actual subsequently installed control code; separate from the database image. */
  nativeControl?: DatabaseCellNativeControlProvenance | undefined;
}
export interface DatabaseCellControlCustodyReference {
  readonly service: string;
  readonly key: string;
  readonly dsnSha256: string;
}
export interface DatabaseCellNativeControlProvenance {
  readonly version: 1;
  readonly controlDatabaseName: "postgres";
  readonly reviewedSourceSha: string;
  readonly migrationManifestSha256: string;
  readonly systemIdentifier: string;
  readonly installedAt: string;
  readonly qualifiedAt: string;
  readonly qualificationReceiptSha256: string;
  readonly logicalProbeDefinitionSha256: string;
  readonly functions: readonly {
    readonly signature: string;
    readonly definitionSha256: string;
  }[];
  /** Mutating capability references/digests only; never their credentials. */
  readonly custody: {
    readonly probe: DatabaseCellControlCustodyReference;
    readonly actuator: DatabaseCellControlCustodyReference;
    readonly readmitter: DatabaseCellControlCustodyReference;
  };
}
export interface DatabaseCellNativeControlObservation {
  readonly version: 1;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: "production";
  readonly controlDatabaseName: "postgres";
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly allocationReceiptId: string;
  readonly dseq: string;
  readonly providerAccount: string;
  readonly reviewedSourceSha: string;
  readonly migrationManifestSha256: string;
  readonly installedAt: string;
  readonly observedAt: string;
  readonly admission: {
    readonly manualPacketSha256: string;
    readonly readmissionReceiptSha256: string;
    readonly admittedAt: string;
    readonly importedAt: string;
    readonly executionActor: DatabaseCellExecutionActor;
    readonly approvalAuthority: DatabaseCellApprovalAuthority;
  };
  readonly requiredFunctions: readonly {
    readonly signature: string;
    readonly definitionSha256: string;
    readonly owner: "postgres";
    readonly securityDefiner: boolean;
    readonly publicCanExecute: false;
    readonly probeCanExecute: boolean;
    readonly actuatorCanExecute: boolean;
    readonly readmitterCanExecute: boolean;
    readonly searchPath: string;
  }[];
  readonly logicalProbeFunction: {
    readonly signature: "public.database_recovery_probe()";
    readonly definitionSha256: string;
    readonly owner: "postgres";
    readonly securityDefiner: true;
    readonly publicCanExecute: false;
    readonly probeCanExecute: true;
    readonly searchPath: string;
  };
  readonly exactRoleBounds: readonly DatabaseCellRoleBounds[];
}
export interface DatabaseCellManualProvenance {
  readonly kind: "manual-observed";
  readonly postgresImageDigest: string;
  readonly managedSdlSha256: string;
  readonly qualificationArtifactSha256: string;
  readonly qualifiedAt: string;
  readonly originalProvisionerArtifact?:
    | {
        readonly sha256: string;
        readonly executorSourceSha?: string | undefined;
      }
    | undefined;
}
export type DatabaseCellBinding = DatabaseCellBindingBase &
  (
    | { sourceSha: string; manualProvenance?: undefined }
    | { sourceSha?: undefined; manualProvenance: DatabaseCellManualProvenance }
  );
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
        executionActor: DatabaseCellExecutionActor;
        approvalAuthority: DatabaseCellApprovalAuthority;
        readmissionReceiptId: string;
        manualCutoverPacketSha256: string;
        sourceSystemIdentifier: string;
        schemaEvolutionReceiptSha256?: string | undefined;
        scheduledBackupReceiptSha256: string;
        independentRecoveryReceiptSha256: string;
        appAllocationReceiptId: string;
        appSdlHash: string;
        appDsnSha256: string;
        serviceDsnSha256: string;
        migrationDsnSha256: string;
        tlsCaSha256?: string | undefined;
        migrationConsumer: "app-database-url" | "dedicated-migration-url";
        runtimePoolLimits?: DatabaseCellRuntimePoolLimits | undefined;
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

/** Existing private bank/key identity; request callers cannot select credential custody. */
export interface DatabaseCellCustodyReference {
  readonly service: string;
  readonly key: string;
}
/** Effective per-role settings preserved by an authenticated manual cutover. */
export interface DatabaseCellRoleBounds {
  readonly name: string;
  readonly connectionLimit: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  readonly tempFileLimitMiB: number;
  readonly workMemMiB: number;
}
/** One app replica, including its separate service read pool and dedicated job leader. */
export interface DatabaseCellRuntimePoolLimits {
  readonly replicaCount: 1;
  readonly app: number;
  readonly service: number;
  readonly read: number;
}
/** Imported current consumers only: no provider root, signing key, or invented control roles. */
export interface DatabaseCellAppliedCustody {
  readonly version: 1;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: "production";
  readonly manualProvenance: DatabaseCellManualProvenance;
  readonly targetBuildSha: string;
  readonly canonicalEndpointHost: string;
  readonly databaseName: string;
  readonly appRole: string;
  readonly serviceRole: string;
  readonly budgetProfile: "shared-default-v1" | "dedicated-high-throughput-v1";
  readonly runtimePoolLimits?: DatabaseCellRuntimePoolLimits | undefined;
  readonly budget: {
    readonly kind: "preserved-role-bounds";
    readonly roles: readonly DatabaseCellRoleBounds[];
  };
  readonly tlsCertificate: string;
  readonly tls:
    | { readonly kind: "system" }
    | {
        readonly kind: "private-ca";
        readonly caCertificate: string;
        readonly custody: DatabaseCellCustodyReference;
      };
  readonly app: {
    readonly dsn: string;
    readonly custody: DatabaseCellCustodyReference;
  };
  readonly service: {
    readonly dsn: string;
    readonly custody: DatabaseCellCustodyReference;
  };
  readonly migration:
    | { readonly kind: "app-database-url" }
    | {
        readonly kind: "dedicated-migration-url";
        readonly dsn: string;
        readonly custody: DatabaseCellCustodyReference;
      };
  readonly readOnlyProbe?:
    | {
        readonly dsn: string;
        readonly custodyRef: DatabaseCellCustodyReference;
      }
    | undefined;
  readonly nativeControl?:
    | {
        readonly provenance: DatabaseCellNativeControlProvenance;
        readonly probe: {
          readonly dsn: string;
          readonly custodyRef: DatabaseCellCustodyReference;
        };
      }
    | undefined;
}

export type DatabaseCellAppliedEvidenceKind =
  | "manual-cutover"
  | "readmission"
  | "source-parity"
  | "scheduled-backup"
  | "backup-archive-verification"
  | "independent-recovery"
  | "recovery-schema"
  | "current-app-readiness"
  | "backup-runtime"
  | "recovery-database-metadata"
  | "recovery-data-parity"
  | "native-control-qualification"
  | "schema-evolution";
/** Authenticated transport only; adapters must additionally parse each kind's actual typed contents. */
export interface DatabaseCellAppliedEvidenceBundle {
  readonly version: 1;
  readonly nodeId: string;
  readonly environment: "production";
  readonly artifacts: readonly {
    readonly kind: DatabaseCellAppliedEvidenceKind;
    readonly mediaType: "application/json";
    readonly sha256: string;
    readonly bytesBase64: string;
  }[];
}

export interface DatabaseCellExecutionActor {
  readonly kind: "agent" | "human";
  readonly id: string;
}
export interface DatabaseCellApprovalAuthority {
  readonly kind: "conversation-user";
  readonly label: "CEO";
  readonly humanAppUserId: string | null;
  readonly source: "direct-user-instruction";
  readonly decisionRef: string;
  readonly capturedAt: string;
  readonly delegationDigest: string;
}

/** Exact-exported basis requires a real captured server snapshot; other starts are conservative lower bounds. */
export type DatabaseCellSnapshotTimeBasis =
  | "service-start-conservative"
  | "dump-command-start-conservative"
  | "exact-exported-snapshot";

/** Current schedule truth is separate from the historical archive qualified by DR. */
export interface DatabaseCellBackupRuntimeObservation {
  readonly observedAt: string;
  readonly timerActiveState:
    | "active"
    | "inactive"
    | "failed"
    | "activating"
    | "deactivating"
    | "unknown";
  readonly nextRunAt: string | null;
  readonly serviceActiveState:
    | "active"
    | "inactive"
    | "failed"
    | "activating"
    | "deactivating"
    | "unknown";
  readonly intervalSeconds: number;
  readonly jitterSeconds: number;
  readonly installedFullTimeoutSeconds: number;
  readonly latestAttempt: {
    readonly startedAt: string;
    readonly completedAt: string | null;
    readonly exitCode: number | null;
  };
  readonly latestCompletedBackup: {
    readonly archiveSha256: string;
    readonly archiveBytes: number;
    readonly snapshotStartedAt: string;
    readonly snapshotTimeBasis: DatabaseCellSnapshotTimeBasis;
    readonly completedAt: string;
    readonly snapshotAgeSeconds: number;
  };
}

export interface DatabaseCellAppliedRegistrationFacts {
  readonly observedAt: string;
  readonly nativeControl?: DatabaseCellNativeControlObservation | undefined;
  readonly schemaEvolution?:
    | {
        readonly receiptSha256: string;
        readonly nodeId: string;
        readonly environment: "production";
        readonly systemIdentifier: string;
        readonly targetAppSha: string;
        readonly fromMigrationCount: number;
        readonly toMigrationCount: number;
        readonly migrationSqlSha256: string;
        readonly currentJournalSha256: string;
        readonly completedAt: string;
        readonly observedAt: string;
      }
    | undefined;
  readonly backupRuntime: DatabaseCellBackupRuntimeObservation;
  readonly provider: {
    readonly observedAt: string;
    readonly dseq: string;
    readonly providerAccount: string;
    readonly appliedSdlHash: string;
    readonly postgresImageDigest: string;
    readonly manifestVersion: string;
    readonly service: {
      readonly name: string;
      readonly observedGeneration: number;
      readonly replicas: number;
      readonly updatedReplicas: number;
      readonly readyReplicas: number;
      readonly availableReplicas: number;
      readonly total: number;
      readonly available: number;
    };
  };
  readonly native: {
    readonly databaseName: string;
    readonly systemIdentifier: string;
    readonly appRole: string;
    readonly serviceRole: string;
    readonly runtimeRoles: readonly (DatabaseCellRoleBounds & {
      readonly canLogin: boolean;
      readonly roleReadOnly: boolean;
    })[];
    readonly activeRuntimeSessions: number;
    readonly migrationJournal?:
      | {
          readonly rowCount: number;
          readonly sha256: string;
          readonly observedAt: string;
        }
      | undefined;
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
    /** Current owned configured values, not opaque provider env-token hashes. */
    readonly appDsnSha256: string;
    readonly serviceDsnSha256: string;
    readonly migrationDsnSha256: string;
    readonly tlsCaSha256?: string | undefined;
    readonly tlsTrustKind: "system" | "private-ca";
    readonly migrationConsumer: "app-database-url" | "dedicated-migration-url";
    readonly readinessReceiptSha256: string;
    readonly runtimePoolLimits?: DatabaseCellRuntimePoolLimits | undefined;
    readonly providerManifest: {
      readonly observedAt: string;
      readonly services: readonly {
        readonly name: string;
        readonly observedGeneration: number;
        readonly replicas: number;
        readonly updatedReplicas: number;
        readonly readyReplicas: number;
        readonly availableReplicas: number;
        readonly total: number;
        readonly available: number;
      }[];
      readonly consoleVersion: string;
      readonly chainVersion: string;
      readonly imageDigest: string;
    };
    readonly runtimeAdoption: {
      readonly observedAt: string;
      readonly systemIdentifier: string;
      /** Public boot egress is distinct from provider-forwarded native peer addresses. */
      readonly publicBootEgressIp: string;
      readonly sessions: readonly {
        readonly role: string;
        readonly applicationName: string;
        readonly peerAddress: string;
        readonly count: number;
      }[];
    };
  };
  readonly manualCutover: {
    readonly packetSha256: string;
    readonly purpose: "production-primary";
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: "production";
    readonly manualProvenance: DatabaseCellManualProvenance;
    readonly appAllocationReceiptId: string;
    readonly primaryManifestVersion: string;
    readonly primaryServiceName: string;
    readonly appCogniKey: string;
    readonly appDseq: string;
    readonly appDsnSha256: string;
    readonly serviceDsnSha256: string;
    readonly migrationConsumer: "app-database-url" | "dedicated-migration-url";
    readonly appSdlHash: string;
    readonly appManifestVersion: string;
    readonly appImageDigest: string;
    readonly appEgressIp: string;
    readonly appServiceName: string;
    readonly runtimePoolLimits?: DatabaseCellRuntimePoolLimits | undefined;
    readonly expectedRuntimeApplications: readonly {
      readonly role: string;
      readonly applicationName: string;
    }[];
    readonly expectedRelations: readonly string[];
    readonly preservedRoleBounds: readonly DatabaseCellRoleBounds[];
    readonly allocationReceiptId: string;
    readonly systemIdentifier: string;
    readonly appSourceSha: string;
    readonly sourceSystemIdentifier: string;
    readonly schemaEvolution?: { readonly receiptSha256: string } | undefined;
    readonly sourceFenceReceiptSha256: string;
    readonly restorationParityManifestSha256: string;
    readonly executionActor: DatabaseCellExecutionActor;
    readonly approvalAuthority: DatabaseCellApprovalAuthority;
    readonly approvedAt: string;
  };
  readonly readmission: {
    readonly receiptId: string;
    readonly packetSha256: string;
    readonly allocationReceiptId: string;
    readonly systemIdentifier: string;
    readonly admittedAt: string;
    readonly executionActor: DatabaseCellExecutionActor;
    readonly approvalAuthority: DatabaseCellApprovalAuthority;
  };
  readonly scheduledBackup: {
    readonly receiptSha256: string;
    readonly databaseName: string;
    readonly systemIdentifier: string;
    readonly archiveSha256: string;
    readonly archiveBytes: number;
    readonly snapshotStartedAt: string;
    readonly snapshotTimeBasis: DatabaseCellSnapshotTimeBasis;
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

/** Readonly qualification, never an applied allocation receipt. */
export interface DatabaseCellAppliedProbeQualification {
  version: 1;
  nodeId: string;
  nodeSlug: string;
  environment: "production";
  cogniKey: string;
  allocationReceiptId: string;
  dseq: string;
  providerAccount: string;
  systemIdentifier: string;
  targetBuildSha: string;
  manualCutoverPacketSha256: string;
  readmissionReceiptId: string;
  probeDsnSha256: string;
  observedFactsSha256: string;
  observedAt: string;
  qualificationSha256: string;
}
