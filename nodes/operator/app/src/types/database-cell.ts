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
  initialIncidentId: string;
  binding: DatabaseCellBinding;
}
