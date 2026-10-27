// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@adapters/server/compute/database-cell-applied-packet`
 * Purpose: Map the actual nested manual-cutover packet and final native readmission receipt.
 * Scope: Immutable byte references and delegated authority; no synthetic applied evidence.
 * Invariants: Prepared/unapproved packets and readonly-login receipts cannot register admission.
 * Side-effects: none
 * Links: shared/secrets/database-cell-placement.data.ts
 * @internal
 */
import { z } from "zod";
import { DatabaseCellAppliedRegistrationFactsSchema } from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedRegistrationFacts } from "@/types/database-cell";
import {
  canonicalEvidenceJson,
  evidenceSha256,
} from "./database-cell-applied-artifacts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const parts = DatabaseCellAppliedRegistrationFactsSchema.shape;
const ManualPacket = z.object({
  version: z.literal(1),
  nodeId: z.string().uuid(),
  nodeSlug: z.string().min(1),
  environment: z.literal("production"),
  purpose: z.literal("production-primary"),
  approvalFrozen: z.literal(true),
  approvedAt: timestamp,
  executionActor: parts.manualCutover.shape.executionActor,
  approvalAuthority: parts.manualCutover.shape.approvalAuthority,
  delegationArtifact: z.object({
    mediaType: z.literal("application/json"),
    sha256: digest,
    bytesBase64: z.string().min(1),
  }),
  primary: z.object({
    allocationReceiptId: z.string().uuid(),
    systemIdentifier: z.string().regex(/^\d+$/),
    image: z.string().regex(/@sha256:[0-9a-f]{64}$/),
    providerAdoption: z.object({
      consoleManifestVersion: z.string().min(1),
      chainManifestVersion: z.string().min(1),
      serviceName: z.string().min(1),
      replicaStatus: z.object({
        replicas: z.literal(1),
        updated_replicas: z.literal(1),
        ready_replicas: z.literal(1),
        available_replicas: z.literal(1),
        total: z.literal(1),
        available: z.literal(1),
        observed_generation: z.number().int().positive(),
      }),
    }),
    implementationProvenance: z.object({
      kind: z.literal("manual-observed"),
      image: z.string(),
      appliedSdlHash: digest,
      qualificationArtifactSha256: digest,
      qualifiedAt: timestamp,
    }),
  }),
  effectiveApp: z.object({
    allocationReceiptId: z.string().uuid(),
    cogniKey: z.string().min(1).max(512),
    dseq: z.string().regex(/^\d+$/),
    dsnDigests: z.object({
      DATABASE_URL: digest,
      DATABASE_SERVICE_URL: digest,
    }),
    migrationConsumer: parts.manualCutover.shape.migrationConsumer,
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    appliedSdlHash: digest,
    image: z.string().regex(/@sha256:[0-9a-f]{64}$/),
    egressIp: z.string().min(1),
    serviceName: z.string().min(1),
    runtimePoolLimits: z
      .object({
        appMax: z.number().int().positive(),
        serviceMax: z.number().int().positive(),
        serviceReadMax: z.number().int().positive(),
      })
      .optional(),
    expectedRuntimeApplications:
      parts.manualCutover.shape.expectedRuntimeApplications,
    providerAdoption: z.object({
      consoleManifestVersion: z.string().min(1),
      chainManifestVersion: z.string().min(1),
      replicaStatus: z.object({
        replicas: z.literal(1),
        updated_replicas: z.literal(1),
        ready_replicas: z.literal(1),
        available_replicas: z.literal(1),
        total: z.literal(1),
        available: z.literal(1),
        observed_generation: z.number().int().positive(),
      }),
    }),
  }),
  physicalRecovery: parts.manualCutover.shape.physicalRecovery,
  schemaEvolution: z.object({ receiptSha256: digest }).strict().optional(),
  sourceFence: z.object({
    handoffSha256: digest,
    systemIdentifier: z.string().regex(/^\d+$/),
    sourceUnchanged: z.literal(true),
  }),
  restoration: z.object({
    expectedRelations: z.array(z.string()).min(1),
    restorationParityManifestSha256: digest,
  }),
  preservedRoleBounds: z.object({
    kind: z.literal("preserved-role-bounds"),
    roles: parts.manualCutover.shape.preservedRoleBounds,
  }),
});
export function mapAppliedManualPacket(artifact: {
  sha256: string;
  json: unknown;
}): DatabaseCellAppliedRegistrationFacts["manualCutover"] {
  const packet = ManualPacket.parse(artifact.json);
  const delegation = Buffer.from(
    packet.delegationArtifact.bytesBase64,
    "base64"
  );
  if (
    evidenceSha256(delegation) !== packet.delegationArtifact.sha256 ||
    packet.delegationArtifact.sha256 !==
      packet.approvalAuthority.delegationDigest
  )
    throw new Error("applied_packet_delegation_byte_identity_mismatch");
  if (
    packet.primary.image !== packet.primary.implementationProvenance.image ||
    (packet.physicalRecovery
      ? packet.primary.systemIdentifier !== packet.sourceFence.systemIdentifier
      : packet.primary.systemIdentifier ===
        packet.sourceFence.systemIdentifier) ||
    packet.primary.providerAdoption.consoleManifestVersion !==
      packet.primary.providerAdoption.chainManifestVersion ||
    packet.effectiveApp.providerAdoption.consoleManifestVersion !==
      packet.effectiveApp.providerAdoption.chainManifestVersion
  )
    throw new Error("applied_packet_native_manifest_identity_mismatch");
  const postgresImageDigest = packet.primary.image.split("@")[1];
  if (!postgresImageDigest)
    throw new Error("applied_packet_native_image_digest_missing");
  return parts.manualCutover.parse({
    ...(packet.physicalRecovery
      ? { physicalRecovery: packet.physicalRecovery }
      : {}),
    packetSha256: artifact.sha256,
    purpose: packet.purpose,
    nodeId: packet.nodeId,
    nodeSlug: packet.nodeSlug,
    environment: packet.environment,
    manualProvenance: {
      kind: "manual-observed",
      postgresImageDigest,
      managedSdlSha256: packet.primary.implementationProvenance.appliedSdlHash,
      qualificationArtifactSha256:
        packet.primary.implementationProvenance.qualificationArtifactSha256,
      qualifiedAt: packet.primary.implementationProvenance.qualifiedAt,
    },
    appAllocationReceiptId: packet.effectiveApp.allocationReceiptId,
    appCogniKey: packet.effectiveApp.cogniKey,
    appDseq: packet.effectiveApp.dseq,
    appDsnSha256: packet.effectiveApp.dsnDigests.DATABASE_URL,
    serviceDsnSha256: packet.effectiveApp.dsnDigests.DATABASE_SERVICE_URL,
    migrationConsumer: packet.effectiveApp.migrationConsumer,
    appSdlHash: packet.effectiveApp.appliedSdlHash,
    appManifestVersion:
      packet.effectiveApp.providerAdoption.consoleManifestVersion,
    appImageDigest: packet.effectiveApp.image.split("@")[1],
    appEgressIp: packet.effectiveApp.egressIp,
    appServiceName: packet.effectiveApp.serviceName,
    runtimePoolLimits: packet.effectiveApp.runtimePoolLimits
      ? {
          replicaCount:
            packet.effectiveApp.providerAdoption.replicaStatus.replicas,
          app: packet.effectiveApp.runtimePoolLimits.appMax,
          service: packet.effectiveApp.runtimePoolLimits.serviceMax,
          read: packet.effectiveApp.runtimePoolLimits.serviceReadMax,
        }
      : undefined,
    expectedRuntimeApplications:
      packet.effectiveApp.expectedRuntimeApplications,
    expectedRelations: packet.restoration.expectedRelations,
    preservedRoleBounds: packet.preservedRoleBounds.roles,
    allocationReceiptId: packet.primary.allocationReceiptId,
    primaryManifestVersion:
      packet.primary.providerAdoption.consoleManifestVersion,
    primaryServiceName: packet.primary.providerAdoption.serviceName,
    systemIdentifier: packet.primary.systemIdentifier,
    appSourceSha: packet.effectiveApp.sourceSha,
    sourceSystemIdentifier: packet.sourceFence.systemIdentifier,
    ...(packet.schemaEvolution
      ? { schemaEvolution: packet.schemaEvolution }
      : {}),
    sourceFenceReceiptSha256: packet.sourceFence.handoffSha256,
    restorationParityManifestSha256:
      packet.restoration.restorationParityManifestSha256,
    executionActor: packet.executionActor,
    approvalAuthority: packet.approvalAuthority,
    approvedAt: packet.approvedAt,
  });
}
const NativeAdmission = z.object({
  observedAt: timestamp,
  cluster: z.string().regex(/^\d+$/),
  operation: z.literal("final-readmit"),
  authorizedActorId: z.string().min(1),
  executorPrincipal: z.enum(["agent", "human"]),
  manualCutoverPacketSha256: digest,
  approvalAuthority: z.object({
    kind: z.literal("conversation-user"),
    label: z.literal("CEO"),
    humanAppUserId: z.string().nullable(),
    source: z.literal("direct-user-instruction"),
    capturedAt: timestamp,
    decisionRef: z.string().min(1),
    delegationArtifactSha256: digest,
  }),
  watchdogQuiescedBeforeWritableCommit: z.literal(true),
  finalFailSafeVerifiedQuiescent: z.literal(true),
  sourceUnchanged: z.literal(true),
  serverDefaultReadOnly: z.literal("off"),
  roles: z
    .array(
      z.object({
        role: z.string().min(1),
        login: z.literal(true),
        connectionLimit: z.number().int(),
        validUntil: z.literal("infinity"),
        config: z.array(z.string()).nullable(),
      })
    )
    .length(2),
});
/** Receipt identity is the exact SHA256 of the original native receipt bytes. */
export function mapAppliedReadmission(
  artifact: { sha256: string; json: unknown },
  packet: DatabaseCellAppliedRegistrationFacts["manualCutover"]
): DatabaseCellAppliedRegistrationFacts["readmission"] {
  const native = NativeAdmission.parse(artifact.json);
  const { delegationArtifactSha256, ...authority } = native.approvalAuthority;
  const approvalAuthority = {
    ...authority,
    delegationDigest: delegationArtifactSha256,
  };
  const executionActor = {
    kind: native.executorPrincipal,
    id: native.authorizedActorId,
  };
  if (
    native.cluster !== packet.systemIdentifier ||
    native.manualCutoverPacketSha256 !== packet.packetSha256 ||
    canonicalEvidenceJson(approvalAuthority) !==
      canonicalEvidenceJson({ ...packet.approvalAuthority }) ||
    canonicalEvidenceJson(executionActor) !==
      canonicalEvidenceJson({ ...packet.executionActor }) ||
    Date.parse(native.observedAt) < Date.parse(packet.approvedAt)
  )
    throw new Error("applied_readmission_immutable_authority_mismatch");
  const roles = new Map(native.roles.map((role) => [role.role, role]));
  for (const expected of packet.preservedRoleBounds) {
    const role = roles.get(expected.name);
    if (
      !role ||
      role.connectionLimit !== expected.connectionLimit ||
      role.config?.some(
        (setting) => setting === "default_transaction_read_only=on"
      )
    )
      throw new Error("applied_readmission_runtime_role_not_admitted");
  }
  return parts.readmission.parse({
    receiptId: artifact.sha256,
    packetSha256: packet.packetSha256,
    allocationReceiptId: packet.allocationReceiptId,
    systemIdentifier: native.cluster,
    admittedAt: native.observedAt,
    executionActor,
    approvalAuthority,
  });
}
