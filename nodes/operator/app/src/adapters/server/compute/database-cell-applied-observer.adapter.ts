// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@adapters/server/compute/database-cell-applied-observer.adapter`
 * Purpose: Produce readonly registration facts for an already applied manual database cell.
 * Scope: Owned immutable artifacts, existing managed readers, and scoped native observations.
 * Invariants: No provisioner, qualification DDL, invented receipt, or caller-supplied evidence.
 * Side-effects: Bounded managed-provider/DNS/Postgres reads through injected existing custody.
 * Links: ports/database-cell-binding.port.ts, types/database-cell.ts
 * @internal
 */
import { z } from "zod";
import type { DatabaseCellAppliedRegistrationEvidencePort } from "@/ports";
import { AkashTxError } from "@/ports";
import {
  DatabaseCellAppliedRegistrationFactsSchema,
  DatabaseCellBackupRuntimeObservationSchema,
  DatabaseCellNativeControlObservationSchema,
  DatabaseCellPhysicalRecoveryEvidenceSchema,
  DatabaseCellPhysicalRecoveryFactsSchema,
  qualifyAppliedSchemaEvolution,
} from "@/shared/secrets/database-cell-placement.data";
import type {
  DatabaseCellAppliedRegistrationFacts,
  DatabaseCellPhysicalRecoveryFacts,
} from "@/types/database-cell";
import {
  canonicalEvidenceJson,
  decodeAppliedEvidenceBundle,
  evidenceSha256,
  qualifyAppliedDatabaseMetadata,
  qualifyAppliedDataParity,
  qualifyAppliedSchemaMatch,
} from "./database-cell-applied-artifacts";
import { observeAppliedDatabaseCellNative } from "./database-cell-applied-native.adapter";
import {
  mapAppliedManualPacket,
  mapAppliedReadmission,
} from "./database-cell-applied-packet";

import {
  type PhysicalRecoveryArtifact,
  PhysicalRecoveryArtifactSchema,
} from "./database-cell-physical-postimage";

type Input = Parameters<
  DatabaseCellAppliedRegistrationEvidencePort["observe"]
>[0];
type Facts = DatabaseCellAppliedRegistrationFacts;
/** Supplied only by bootstrap's existing managed allocation/provider/custody readers. */
export interface AppliedDatabaseCellManagedObservation {
  readonly provider: Facts["provider"];
  readonly providerEndpoint: { readonly host: string; readonly port: number };
  readonly effectiveApp: Omit<
    Facts["effectiveApp"],
    "runtimeAdoption" | "regions" | "readinessReceiptSha256"
  >;
}
const digest = z.string().regex(/^[0-9a-f]{64}$/),
  id = z.string().regex(/^\d+$/),
  timestamp = z.string().datetime({ offset: true });
const sequence = z.object({
  name: z.string().min(1),
  lastValue: id,
  isCalled: z.boolean(),
});
const Completion = z.object({
  event: z.literal("poly_cell_backup_complete"),
  utc: timestamp,
  sourceLease: id,
  sourceSystemId: id,
  source: z.string().min(1),
  cipherBytes: z.number().int().positive(),
  nativeToolMajor: z.literal(15),
  encryption: z.literal("age-x25519"),
  dumpStartedAt: timestamp.optional(),
});
const Scheduled = z.object({
  metadata: Completion,
  cipherSha256: digest,
  schedulerUnit: z.object({ bytesBase64: z.string().min(1), sha256: digest }),
  executorFailureDomainId: z.string().min(1),
});
const Authenticated = z.object({
  utc: timestamp,
  cipherSha256: digest,
  cipherBytes: z.number().int().positive(),
  ageAuthentication: z.literal(true),
  sourceSystemId: id,
  sourceLease: id,
  tables: z.array(z.string()).min(1),
  tableCount: z.number().int().positive(),
  sequenceSetCount: z.number().int().nonnegative(),
});
const Recovery = z.object({
  providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
  nativeRestore: z.object({
    event: z.literal("canonical_scheduled_full_backup_restore_complete"),
    utc: timestamp,
    exitCode: z.literal(0),
    recoverySystemId: id,
    recoveryLease: id,
    sourcePrimarySystemId: id,
    sourcePrimaryLease: id,
    archiveCipherSha256: digest,
    tableCount: z.number().int().positive(),
    sequenceSetCount: z.number().int().nonnegative(),
  }),
  qualification: z.object({
    qualifiedAt: timestamp,
    backup: z.object({
      cipherSha256: digest,
      encryptedCipherBytes: z.number().int().positive(),
      firstServiceStartedAt: timestamp,
      firstArchiveAvailableAt: timestamp,
      offProviderAnchor: z.string().min(1),
    }),
    verification: z.object({
      tables: z.number().int().positive(),
      rows: z.number().int().nonnegative(),
    }),
  }),
});
const NativeComparison = z.object({
  sourceObjects: z.number().int().positive(),
  targetObjects: z.number().int().positive(),
  exactMatchedObjects: z.number().int().positive(),
  missingObjects: z.array(z.unknown()).length(0),
  changedObjects: z.array(z.unknown()).length(0),
  extraObjects: z.array(
    z.object({
      schema: z.string(),
      type: z.literal("ACL"),
      name: z.string(),
      sql: z.string(),
    })
  ),
  sequenceMatch: z.literal(true),
  expectedSequences: z.array(sequence),
  targetCatalog: z.object({
    systemId: id,
    sequences: z.array(sequence),
    tables: z.array(z.object({ schema: z.string(), name: z.string() })),
  }),
});
const Supplement = z.object({
  systemId: id,
  after: z.object({
    datname: z.string(),
    owner: z.string(),
    datacl: z.array(z.string()),
    encoding: z.string(),
    datcollate: z.string(),
    datctype: z.string(),
    datconnlimit: z.number().int(),
  }),
  roleBounds: z
    .array(
      z.object({
        rolname: z.string(),
        rolcanlogin: z.literal(false),
        rolconnlimit: z.number().int(),
        rolconfig: z.array(z.string()),
      })
    )
    .length(5),
  allFiveRecoveryRolesRemainNOLOGIN: z.literal(true),
});
const Http = z.object({
  observedAt: timestamp,
  rows: z.array(
    z.object({
      path: z.string(),
      httpStatus: z.string(),
      curlExitCode: z.number().int(),
      buildSha: z.string().nullable(),
      status: z.string().nullable(),
      totalSeconds: z.number().nonnegative(),
    })
  ),
});
const Readiness = z.object({
  windowSample: z.object({
    at: timestamp,
    passed: z.literal(true),
    observations: z
      .array(
        z.object({
          origin: z.string().min(1),
          native: z.object({ systemIdentifier: id }),
          http: Http,
        })
      )
      .min(2),
  }),
  deep: z
    .array(
      z.object({
        origin: z.string().min(1),
        receipt: z.object({
          observedAt: timestamp,
          path: z.literal("/readyz?deep=1"),
          curlExitCode: z.literal(0),
          httpStatus: z.literal(200),
          totalSeconds: z.number().nonnegative().lt(5),
          status: z.literal("healthy"),
          buildSha: z.string().regex(/^[0-9a-f]{40}$/),
        }),
      })
    )
    .min(2),
});
const fresh = (value: string) =>
  Date.parse(value) >= Date.now() - 60000 &&
  Date.parse(value) <= Date.now() + 5000;
const sameRelations = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const normalizeSql = (value: string) =>
  value
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join("\n");

export class ReadOnlyAppliedDatabaseCellObserver
  implements DatabaseCellAppliedRegistrationEvidencePort
{
  constructor(
    private readonly deps: {
      readOwnedBundle: (reference: Input["reference"]) => Promise<unknown>;
      observeManaged: (input: {
        reference: Input["reference"];
        custody: Input["custody"];
        packet: Facts["manualCutover"];
        physicalArtifact?: PhysicalRecoveryArtifact;
      }) => Promise<AppliedDatabaseCellManagedObservation>;
      observeNativeControl?:
        | ((input: {
            reference: Input["reference"];
            custody: Input["custody"];
            native: Facts["native"];
            provider: Facts["provider"];
            packet: Facts["manualCutover"];
            physicalArtifact?: PhysicalRecoveryArtifact;
          }) => Promise<NonNullable<Facts["nativeControl"]>>)
        | undefined;
    }
  ) {}
  async observe(
    input: Input
  ): Promise<Facts | DatabaseCellPhysicalRecoveryFacts> {
    try {
      return await this.observeOwned(input);
    } catch {
      // No provider/SQL error string or malformed private artifact reaches an HTTP response/log.
      throw new AkashTxError(
        "ledger_unavailable",
        "trusted readonly applied-cell evidence unavailable or inconsistent"
      );
    }
  }
  private async observeOwned(
    input: Input
  ): Promise<Facts | DatabaseCellPhysicalRecoveryFacts> {
    const bundle = decodeAppliedEvidenceBundle(
      await this.deps.readOwnedBundle(input.reference),
      input.reference.nodeId
    );
    const packet = mapAppliedManualPacket(bundle.require("manual-cutover"));
    const legacy =
      packet.physicalRecovery?.sourceAnchorKind === "legacy-native-capture";
    if (
      (input.registrationKind === "legacy-physical") !== legacy ||
      (legacy && input.readmissionReceiptId !== undefined)
    )
      throw new Error("physical_legacy_reference_variant_mismatch");
    const readmission = legacy
      ? undefined
      : mapAppliedReadmission(bundle.require("readmission"), packet);
    if (
      packet.packetSha256 !== input.manualCutoverPacketSha256 ||
      (!legacy && readmission?.receiptId !== input.readmissionReceiptId) ||
      packet.nodeId !== input.custody.nodeId ||
      packet.environment !== input.custody.environment
    )
      throw new Error("applied_registration_owned_packet_reference_mismatch");
    if (packet.physicalRecovery) {
      const artifact = bundle.require("physical-recovery");
      const physical = PhysicalRecoveryArtifactSchema.parse(artifact.json);
      const current = z
        .object({
          physicalEvidenceSha256: digest,
          evidence: DatabaseCellPhysicalRecoveryEvidenceSchema,
        })
        .strict()
        .parse(bundle.require("physical-current").json);
      const immutable = (e: typeof physical.evidence) => ({
        ...e,
        observedAt: "",
        source: { ...e.source, observedAt: "" },
        target: {
          ...e.target,
          observedAt: "",
          volume: {
            ...e.target.volume,
            usedBytes: 0,
            availableBytes: 0,
            availableInodes: 0,
          },
        },
        app: { ...e.app, observedAt: "" },
        reconciliation: { ...e.reconciliation, observedAt: "" },
      });
      if (
        current.physicalEvidenceSha256 !== artifact.sha256 ||
        canonicalEvidenceJson(immutable(current.evidence)) !==
          canonicalEvidenceJson(immutable(physical.evidence))
      )
        throw new Error("physical_current_observation_identity_changed");
      const e = current.evidence;
      const backupArtifact = bundle.require("scheduled-backup");
      const backup = Scheduled.parse(backupArtifact.json);
      const archive = Authenticated.parse(
        bundle.require("backup-archive-verification").json
      );
      if (
        artifact.sha256 !== packet.physicalRecovery.evidenceSha256 ||
        backupArtifact.sha256 !== e.preservedBackup.receiptSha256 ||
        backup.cipherSha256 !== e.preservedBackup.archiveSha256 ||
        archive.cipherSha256 !== backup.cipherSha256 ||
        archive.cipherBytes !== e.preservedBackup.bytes ||
        backup.metadata.cipherBytes !== archive.cipherBytes ||
        archive.sourceSystemId !== packet.sourceSystemIdentifier ||
        archive.sourceLease !== e.source.dseq ||
        backup.metadata.sourceLease !== e.source.dseq
      )
        throw new Error("physical_preserved_archive_custody_mismatch");
      const managed = await this.deps.observeManaged({
        reference: input.reference,
        custody: input.custody,
        packet,
        physicalArtifact: physical,
      });
      const native = await observeAppliedDatabaseCellNative({
        custody: input.custody,
        providerEndpoint: managed.providerEndpoint,
        appEgressIp: packet.appEgressIp,
        expectedRuntimeApplications: packet.expectedRuntimeApplications,
        requireAbsentBusinessWriters: true,
        expectedRelations: packet.expectedRelations,
        observeMigrationJournal: true,
      });
      let nativeControl: Facts["nativeControl"];
      if (input.custody.nativeControl) {
        if (!this.deps.observeNativeControl)
          throw new Error("physical_native_control_observer_unavailable");
        nativeControl = DatabaseCellNativeControlObservationSchema.parse(
          await this.deps.observeNativeControl({
            reference: input.reference,
            custody: input.custody,
            native: native.native,
            provider: managed.provider,
            packet,
          })
        );
      }
      // Re-read provider/source/app containment after SQL too; a changed private bank
      // or native postimage invalidates the entire observation, never updates the ledger.
      const finalManaged = await this.deps.observeManaged({
        reference: input.reference,
        custody: input.custody,
        packet,
        physicalArtifact: physical,
      });
      if (
        canonicalEvidenceJson({ ...managed.provider, observedAt: "" }) !==
          canonicalEvidenceJson({ ...finalManaged.provider, observedAt: "" }) ||
        managed.effectiveApp.appliedSdlHash !==
          finalManaged.effectiveApp.appliedSdlHash
      )
        throw new Error("physical_managed_postimage_changed_during_sql");
      return DatabaseCellPhysicalRecoveryFactsSchema.parse({
        observedAt: new Date().toISOString(),
        physicalRecovery: e,
        provider: finalManaged.provider,
        native: native.native,
        effectiveApp: finalManaged.effectiveApp,
        manualCutover: packet,
        readmission,
        ...(nativeControl ? { nativeControl } : {}),
      });
    }
    if (!readmission)
      throw new Error("ordinary_registration_requires_genuine_readmission");
    const backupArtifact = bundle.require("scheduled-backup"),
      archiveArtifact = bundle.require("backup-archive-verification"),
      recoveryArtifact = bundle.require("independent-recovery");
    const scheduled = Scheduled.parse(backupArtifact.json),
      authenticated = Authenticated.parse(archiveArtifact.json),
      dr = Recovery.parse(recoveryArtifact.json);
    const restore = dr.nativeRestore;
    const unit = Buffer.from(scheduled.schedulerUnit.bytesBase64, "base64");
    if (
      evidenceSha256(unit) !== scheduled.schedulerUnit.sha256 ||
      !unit.toString("utf8").includes("Type=oneshot")
    )
      throw new Error("applied_backup_native_unit_bytes_mismatch");
    if (
      scheduled.metadata.sourceSystemId !== packet.systemIdentifier ||
      scheduled.metadata.sourceLease !== authenticated.sourceLease ||
      restore.sourcePrimarySystemId !== packet.systemIdentifier ||
      restore.sourcePrimaryLease !== scheduled.metadata.sourceLease ||
      restore.recoverySystemId === packet.systemIdentifier ||
      scheduled.cipherSha256 !== authenticated.cipherSha256 ||
      restore.archiveCipherSha256 !== authenticated.cipherSha256 ||
      dr.qualification.backup.cipherSha256 !== authenticated.cipherSha256 ||
      scheduled.metadata.cipherBytes !== authenticated.cipherBytes ||
      dr.qualification.backup.encryptedCipherBytes !==
        authenticated.cipherBytes ||
      scheduled.metadata.utc !==
        dr.qualification.backup.firstArchiveAvailableAt ||
      Date.parse(authenticated.utc) < Date.parse(scheduled.metadata.utc) ||
      Date.parse(restore.utc) < Date.parse(authenticated.utc) ||
      Date.parse(dr.qualification.qualifiedAt) < Date.parse(restore.utc) ||
      Date.parse(dr.qualification.backup.firstServiceStartedAt) >
        Date.parse(scheduled.metadata.utc) ||
      authenticated.sourceSystemId !== packet.systemIdentifier ||
      !sameRelations(authenticated.tables, packet.expectedRelations) ||
      authenticated.tableCount !== packet.expectedRelations.length ||
      restore.tableCount !== packet.expectedRelations.length ||
      dr.qualification.verification.tables !== packet.expectedRelations.length
    )
      throw new Error("applied_historical_backup_restore_identity_mismatch");
    const data = qualifyAppliedDataParity({
      source: bundle.require("source-parity").json,
      recovery: bundle.require("recovery-data-parity").json,
      recoverySystemId: restore.recoverySystemId,
      expectedRelations: packet.expectedRelations,
    });
    if (data.rowCount !== String(dr.qualification.verification.rows))
      throw new Error("applied_recovery_total_rows_mismatch");
    const schemaArtifact = z
      .object({
        nativeComparison: NativeComparison,
        fullSchemaMatch: z.unknown(),
      })
      .parse(bundle.require("recovery-schema").json);
    const comparison = schemaArtifact.nativeComparison;
    if (
      comparison.targetCatalog.systemId !== restore.recoverySystemId ||
      comparison.sourceObjects !== comparison.exactMatchedObjects ||
      comparison.targetObjects !==
        comparison.sourceObjects + comparison.extraObjects.length ||
      !sameRelations(
        comparison.targetCatalog.tables.map((x) => `${x.schema}.${x.name}`),
        packet.expectedRelations
      )
    )
      throw new Error("applied_recovery_schema_coverage_mismatch");
    const fullSchema = qualifyAppliedSchemaMatch({
      value: schemaArtifact.fullSchemaMatch,
      archiveSha256: authenticated.cipherSha256,
      backupSystemId: packet.systemIdentifier,
      recoverySystemId: restore.recoverySystemId,
      expectedObjectCount: comparison.targetObjects,
    });
    const sequences = [...comparison.expectedSequences].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      ),
      actualSequences = [...comparison.targetCatalog.sequences].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
    if (
      new Set(sequences.map((x) => x.name)).size !== sequences.length ||
      canonicalEvidenceJson(sequences) !==
        canonicalEvidenceJson(actualSequences) ||
      authenticated.sequenceSetCount !== sequences.length ||
      restore.sequenceSetCount !== sequences.length
    )
      throw new Error("applied_recovery_native_sequence_states_mismatch");
    const sequenceStateFingerprintSha256 = evidenceSha256(
      canonicalEvidenceJson(sequences)
    );
    const metadata = z
      .object({
        source: z.unknown(),
        recovery: z.unknown(),
        supplement: Supplement,
      })
      .parse(bundle.require("recovery-database-metadata").json);
    const globals = qualifyAppliedDatabaseMetadata({
      source: metadata.source,
      recovery: metadata.recovery,
      databaseName: input.custody.databaseName,
      recoverySystemId: restore.recoverySystemId,
    });
    if (
      metadata.supplement.systemId !== globals.recoverySystemIdentifier ||
      canonicalEvidenceJson({
        name: metadata.supplement.after.datname,
        owner: metadata.supplement.after.owner,
        acl: [...metadata.supplement.after.datacl].sort(),
        encoding: metadata.supplement.after.encoding,
        collation: metadata.supplement.after.datcollate,
        ctype: metadata.supplement.after.datctype,
        connectionLimit: metadata.supplement.after.datconnlimit,
      }) !==
        canonicalEvidenceJson({
          name: globals.recoveryDatabase.name,
          owner: globals.recoveryDatabase.owner,
          acl: [...globals.recoveryDatabase.acl].sort(),
          encoding: globals.recoveryDatabase.encoding,
          collation: globals.recoveryDatabase.collation,
          ctype: globals.recoveryDatabase.ctype,
          connectionLimit: globals.recoveryDatabase.connectionLimit,
        })
    )
      throw new Error("applied_recovery_globals_supplement_scope_mismatch");
    this.qualifyAuxiliaryAcl(
      comparison.extraObjects,
      metadata.supplement.roleBounds.map((x) => x.rolname),
      input.custody
    );
    const runtime = DatabaseCellBackupRuntimeObservationSchema.parse(
      z
        .object({ backupRuntime: z.unknown() })
        .parse(bundle.require("backup-runtime").json).backupRuntime
    );
    if (
      !fresh(runtime.observedAt) ||
      runtime.timerActiveState !== "active" ||
      (runtime.latestAttempt.exitCode !== null &&
        runtime.latestAttempt.exitCode !== 0)
    )
      throw new Error("applied_current_backup_runtime_unhealthy");
    const readinessArtifact = bundle.require("current-app-readiness"),
      readiness = Readiness.parse(readinessArtifact.json);
    const regions = readiness.windowSample.observations.map((observation) => {
      const result = observation.http.rows.filter((x) => x.path === "/readyz");
      const row = result[0];
      if (
        result.length !== 1 ||
        !row ||
        row.httpStatus !== "200" ||
        row.curlExitCode !== 0 ||
        row.status !== "healthy" ||
        row.totalSeconds >= 5 ||
        row.buildSha !== input.custody.targetBuildSha ||
        observation.native.systemIdentifier !== packet.systemIdentifier ||
        !fresh(observation.http.observedAt)
      )
        throw new Error("applied_current_public_region_not_ready");
      return {
        region: observation.origin,
        status: 200,
        buildSha: row.buildSha,
        observedAt: observation.http.observedAt,
      };
    });
    if (
      new Set(regions.map((x) => x.region)).size < 2 ||
      readiness.deep.some(
        (x) =>
          !fresh(x.receipt.observedAt) ||
          x.receipt.buildSha !== input.custody.targetBuildSha
      ) ||
      !sameRelations(
        regions.map((x) => x.region),
        readiness.deep.map((x) => x.origin)
      )
    )
      throw new Error("applied_current_deep_region_not_ready");
    const managed = await this.deps.observeManaged({
      reference: input.reference,
      custody: input.custody,
      packet,
    });
    const configuredDatabase = new URL(input.custody.app.dsn);
    if (
      managed.provider.dseq !== scheduled.metadata.sourceLease ||
      managed.provider.providerAccount === dr.providerAccount ||
      scheduled.metadata.source !==
        `${configuredDatabase.hostname}:${configuredDatabase.port}/${input.custody.databaseName}`
    )
      throw new Error("applied_backup_managed_primary_endpoint_mismatch");
    const native = await observeAppliedDatabaseCellNative({
      custody: input.custody,
      observeMigrationJournal: Boolean(packet.schemaEvolution),
      providerEndpoint: managed.providerEndpoint,
      appEgressIp: packet.appEgressIp,
      expectedRuntimeApplications: packet.expectedRuntimeApplications,
    });
    let schemaEvolution: Facts["schemaEvolution"];
    if (packet.schemaEvolution) {
      const artifact = bundle.require("schema-evolution");
      const evolution = qualifyAppliedSchemaEvolution(artifact.json);
      const current = native.native.migrationJournal;
      if (
        artifact.sha256 !== packet.schemaEvolution.receiptSha256 ||
        evolution.nodeId !== packet.nodeId ||
        evolution.environment !== packet.environment ||
        evolution.systemIdentifier !== packet.systemIdentifier ||
        evolution.database !== input.custody.databaseName ||
        evolution.targetAppSha !== packet.appSourceSha ||
        !current ||
        current.rowCount !== evolution.toMigrationCount ||
        current.sha256 !== evolution.currentJournal.sha256 ||
        Date.parse(evolution.completedAt) > Date.parse(readmission.admittedAt)
      )
        throw new Error("applied_schema_evolution_current_journal_mismatch");
      schemaEvolution = {
        receiptSha256: artifact.sha256,
        nodeId: evolution.nodeId,
        environment: evolution.environment,
        systemIdentifier: evolution.systemIdentifier,
        targetAppSha: evolution.targetAppSha,
        fromMigrationCount: evolution.fromMigrationCount,
        toMigrationCount: evolution.toMigrationCount,
        migrationSqlSha256: evolution.migration.sqlSha256,
        currentJournalSha256: current.sha256,
        completedAt: evolution.completedAt,
        observedAt: current.observedAt,
      };
    }
    let nativeControl: Facts["nativeControl"];
    if (input.custody.nativeControl) {
      const artifact = bundle.require("native-control-qualification");
      const installed = DatabaseCellNativeControlObservationSchema.parse(
        artifact.json
      );
      const provenance = input.custody.nativeControl.provenance;
      if (
        !this.deps.observeNativeControl ||
        artifact.sha256 !== provenance.qualificationReceiptSha256 ||
        installed.observedAt !== provenance.qualifiedAt ||
        installed.systemIdentifier !== provenance.systemIdentifier ||
        installed.reviewedSourceSha !== provenance.reviewedSourceSha ||
        installed.installedAt !== provenance.installedAt ||
        installed.admission.manualPacketSha256 !== packet.packetSha256 ||
        installed.admission.readmissionReceiptSha256 !==
          readmission.receiptId ||
        installed.logicalProbeFunction.definitionSha256 !==
          provenance.logicalProbeDefinitionSha256 ||
        canonicalEvidenceJson(
          installed.requiredFunctions
            .map(({ signature, definitionSha256 }) => ({
              signature,
              definitionSha256,
            }))
            .sort((a, b) => a.signature.localeCompare(b.signature))
        ) !==
          canonicalEvidenceJson(
            [...provenance.functions].sort((a, b) =>
              a.signature.localeCompare(b.signature)
            )
          )
      )
        throw new Error(
          "applied_control_actual_qualification_artifact_unavailable"
        );
      nativeControl = DatabaseCellNativeControlObservationSchema.parse(
        await this.deps.observeNativeControl({
          reference: input.reference,
          custody: input.custody,
          native: native.native,
          provider: managed.provider,
          packet,
        })
      );
    }
    const start =
      scheduled.metadata.dumpStartedAt ??
      dr.qualification.backup.firstServiceStartedAt;
    return DatabaseCellAppliedRegistrationFactsSchema.parse({
      observedAt: new Date().toISOString(),
      provider: managed.provider,
      native: native.native,
      ...(nativeControl ? { nativeControl } : {}),
      ...(schemaEvolution ? { schemaEvolution } : {}),
      effectiveApp: {
        ...managed.effectiveApp,
        runtimeAdoption: native.runtimeAdoption,
        regions,
        readinessReceiptSha256: readinessArtifact.sha256,
      },
      manualCutover: packet,
      readmission,
      backupRuntime: runtime,
      scheduledBackup: {
        receiptSha256: backupArtifact.sha256,
        databaseName: input.custody.databaseName,
        systemIdentifier: scheduled.metadata.sourceSystemId,
        archiveSha256: authenticated.cipherSha256,
        archiveBytes: authenticated.cipherBytes,
        snapshotStartedAt: start,
        snapshotTimeBasis: scheduled.metadata.dumpStartedAt
          ? "dump-command-start-conservative"
          : "service-start-conservative",
        completedAt: scheduled.metadata.utc,
        verifiedArchiveReceiptSha256: archiveArtifact.sha256,
        schedulerUnitSha256: scheduled.schedulerUnit.sha256,
        executorFailureDomainId: scheduled.executorFailureDomainId,
        fullSchemaFingerprintSha256: fullSchema.fullSchemaFingerprintSha256,
        fullDataFingerprintSha256: data.fullDataFingerprintSha256,
        sequenceStateFingerprintSha256,
        relations: data.relations,
        rowCount: data.rowCount,
      },
      independentRecovery: {
        receiptSha256: recoveryArtifact.sha256,
        archiveSha256: restore.archiveCipherSha256,
        restoredSystemIdentifier: restore.recoverySystemId,
        providerAccount: dr.providerAccount,
        dseq: restore.recoveryLease,
        recoveryFailureDomainId: `akash:${dr.providerAccount}:${restore.recoveryLease}`,
        completedAt: dr.qualification.qualifiedAt,
        fullSchemaFingerprintSha256: fullSchema.fullSchemaFingerprintSha256,
        fullDataFingerprintSha256: data.fullDataFingerprintSha256,
        sequenceStateFingerprintSha256,
        relations: data.relations,
        rowCount: data.rowCount,
      },
    });
  }
  private qualifyAuxiliaryAcl(
    extras: z.infer<typeof NativeComparison>["extraObjects"],
    roles: readonly string[],
    custody: Input["custody"]
  ) {
    if (!custody.readOnlyProbe)
      throw new Error("applied_probe_custody_missing");
    const probe = decodeURIComponent(
      new URL(custody.readOnlyProbe.dsn).username
    );
    const backup = roles.filter(
      (x) =>
        ![custody.appRole, custody.serviceRole, "app_readonly", probe].includes(
          x
        )
    );
    if (
      backup.length !== 1 ||
      !backup[0] ||
      roles.length !== new Set(roles).size
    )
      throw new Error("applied_auxiliary_role_identity_ambiguous");
    const signature =
      "pg_catalog.pg_control_system(OUT pg_control_version integer, OUT catalog_version_no integer, OUT system_identifier bigint, OUT pg_control_last_modified timestamp with time zone)";
    const expected = new Map([
      [
        "pg_catalog|FUNCTION pg_control_system(OUT pg_control_version integer, OUT catalog_version_no integer, OUT system_identifier bigint, OUT pg_control_last_modified timestamp with time zone)",
        normalizeSql(
          `GRANT ALL ON FUNCTION ${signature} TO ${backup[0]};\nGRANT ALL ON FUNCTION ${signature} TO ${probe};`
        ),
      ],
      [
        "-|SCHEMA drizzle",
        normalizeSql(`GRANT USAGE ON SCHEMA drizzle TO ${probe};`),
      ],
      [
        "drizzle|TABLE __drizzle_migrations",
        normalizeSql(
          `GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${probe};`
        ),
      ],
    ]);
    if (
      extras.length !== expected.size ||
      new Set(extras.map((x) => `${x.schema}|${x.name}`)).size !==
        extras.length ||
      extras.some(
        (x) => expected.get(`${x.schema}|${x.name}`) !== normalizeSql(x.sql)
      )
    )
      throw new Error("applied_recovery_unexpected_auxiliary_acl");
  }
}
