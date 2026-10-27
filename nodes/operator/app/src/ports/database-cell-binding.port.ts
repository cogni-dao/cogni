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
  DatabaseCellPhysicalRecoveryFacts,
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
 * Audited import seam: genuine post-readmission or preserved legacy physical admission.
 * References never supply native facts, credentials or approval flags.
 * Missing trusted evidence supply refuses registration; prestage containment is unchanged.
 */
export interface DatabaseCellAppliedRegistrationPort {
  registerApplied(
    input: DatabaseCellBindingReference & {
      readonly manualCutoverPacketSha256: string;
      readonly registrationKind?: "legacy-physical" | undefined;
      readonly readmissionReceiptId?: string | undefined;
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
    readonly registrationKind?: "legacy-physical" | undefined;
    readonly readmissionReceiptId?: string | undefined;
  }): Promise<
    DatabaseCellAppliedRegistrationFacts | DatabaseCellPhysicalRecoveryFacts
  >;
}

/** Full applied evidence validation without saving a binding or publishing any secret. */
export interface DatabaseCellAppliedProbeQualificationPort {
  qualifyAppliedProbe(
    input: Parameters<DatabaseCellAppliedRegistrationPort["registerApplied"]>[0]
  ): Promise<
    import("@/types/database-cell").DatabaseCellAppliedProbeQualification
  >;
}

/** Expected canonical preimages and observed native postimages, never mutation authority. */
export interface DatabaseCellPhysicalRecoveryWrite {
  readonly source: import("./akash-tx.port").AkashTxAllocationRecord;
  readonly target: import("./akash-tx.port").AkashTxAllocationRecord;
  readonly app: import("./akash-tx.port").AkashTxAllocationRecord;
  readonly expectedSource: readonly AppliedDatabaseCellReceipt[];
  readonly expectedTarget: readonly AppliedDatabaseCellReceipt[];
  readonly targetBindings: readonly AppliedDatabaseCellReceipt[];
  readonly recoveryIntentKey: string;
  readonly targetSdlHash: string;
  readonly appSdlHash: string;
  readonly packetSha256: string;
}
