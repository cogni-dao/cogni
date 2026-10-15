// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/database-cell-binding.port`
 * Purpose: Persist measured cell identity on the existing paid allocation receipt.
 * Scope: Typed private binding requests only; does not allocate a second resource or expose credentials.
 * Invariants: Caller references an owned allocation; native measurements and component custody supply identity.
 * Side-effects: none (interfaces only)
 * Links: shared/secrets/database-cell-placement.data.ts, ports/akash-tx.port.ts
 * @internal
 */
import type {
  AppliedDatabaseCellReceipt,
  DatabaseCellAppliedCustody,
  DatabaseCellAppliedRegistrationFacts,
  DatabaseCellBootstrapKit,
  DatabaseCellEndpointIdentity,
} from "@/types/database-cell";

export interface DatabaseCellBindingReference {
  readonly cogniKey: string;
  readonly nodeId: string;
  readonly allocationEnvironment: string;
}
export interface DatabaseCellCutoverReference
  extends DatabaseCellBindingReference {
  readonly packetSha256: string;
  readonly actorId: string;
}
export interface DatabaseCellBindingPort {
  discover(input: Omit<DatabaseCellBindingReference, "cogniKey">): Promise<{
    reference: DatabaseCellBindingReference;
    identity: import("./akash-tx.port").AkashTxWorkloadIdentity;
    externalName: string;
    endpoints: readonly string[];
    kitCertificateSha256: string;
  }>;
  read(
    input: DatabaseCellBindingReference
  ): Promise<readonly AppliedDatabaseCellReceipt[]>;
  cutover(
    input: DatabaseCellCutoverReference
  ): Promise<readonly AppliedDatabaseCellReceipt[]>;
  seal(
    input: DatabaseCellBindingReference
  ): Promise<readonly AppliedDatabaseCellReceipt[]>;
}

export interface DatabaseCellNativeProof {
  /** Measured by the trusted native observer, never accepted from a binding request. */
  readonly endpointIdentity?: DatabaseCellEndpointIdentity;
  readonly lane: DatabaseCellBootstrapKit["logicalDatabases"][number];
  readonly observation: {
    readonly database: string;
    readonly role: string;
    readonly systemIdentifier: string;
    readonly runtimeRolesNoLogin: boolean;
    readonly activeRuntimeSessions: number;
    readonly systemTenantExists: boolean;
    readonly backupQualified: boolean;
  };
  readonly incident: { readonly incidentId: string; readonly state: string };
}
export interface DatabaseCellNativeObserverPort {
  observe(
    kit: DatabaseCellBootstrapKit,
    endpoint: {
      host: string;
      port: number;
      providerEndpoint?: { host: string; port: number };
    }
  ): Promise<readonly DatabaseCellNativeProof[]>;
}

/**
 * Post-readmission import seam. Separate from prestage seal/cutover:
 * the request names audited receipts, never supplies native facts or approval flags.
 * Missing trusted evidence supply refuses registration; prestage containment is unchanged.
 */
export interface DatabaseCellAppliedRegistrationPort {
  registerApplied(
    input: DatabaseCellBindingReference & {
      readonly manualCutoverPacketSha256: string;
      readonly readmissionReceiptId: string;
    }
  ): Promise<readonly AppliedDatabaseCellReceipt[]>;
}

/** Credential-free measured facts; digest references must be loaded and validated by the adapter. */
export type { DatabaseCellAppliedRegistrationFacts } from "@/types/database-cell";

/** Authenticates artifact custody and rereads provider/native/runtime truth; never trusts request success assertions. */
export interface DatabaseCellAppliedRegistrationEvidencePort {
  observe(input: {
    readonly reference: DatabaseCellBindingReference;
    readonly custody: DatabaseCellAppliedCustody;
    readonly manualCutoverPacketSha256: string;
    readonly readmissionReceiptId: string;
  }): Promise<DatabaseCellAppliedRegistrationFacts>;
}
