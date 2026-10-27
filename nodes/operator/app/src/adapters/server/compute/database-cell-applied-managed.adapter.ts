// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/database-cell-applied-managed.adapter`
 * Purpose: Read existing owned allocations and current provider manifests for manual cell registration.
 * Scope: Existing account-scoped ledger, Console client, and mounted owned custody only.
 * Invariants: Configured DSN digests describe current mounted custody, never redacted provider values or a fresh Bao read.
 * Side-effects: Bounded ledger/provider/file reads through injected existing capabilities.
 * Links: ports/database-cell-binding.port.ts, bootstrap/akash-tx-actuator.ts
 * @internal
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parse } from "yaml";
import { z } from "zod";
import type {
  AkashTxAllocationLedgerPort,
  AkashTxConsolePort,
  DatabaseCellBindingReference,
} from "@/ports";
import { DatabaseCellAppliedCustodySchema } from "@/shared/secrets/database-cell-binding.data";
import type {
  DatabaseCellAppliedCustody,
  DatabaseCellAppliedRegistrationFacts as Facts,
} from "@/types/database-cell";

import {
  type PhysicalRecoveryArtifact,
  qualifyPhysicalPostimages,
} from "./database-cell-physical-postimage";

type ManagedObservation = Pick<Facts, "provider"> & {
  readonly providerEndpoint: { readonly host: string; readonly port: number };
  readonly effectiveApp: Omit<
    Facts["effectiveApp"],
    "runtimeAdoption" | "regions" | "readinessReceiptSha256"
  >;
};
const Definition = z.object({
  services: z.record(z.string(), z.object({ image: z.string() })),
});
const imageDigest = (image: string) => {
  const digest = image.match(/@(?<digest>sha256:[0-9a-f]{64})$/)?.groups
    ?.digest;
  if (!digest) throw new Error("applied_managed_image_not_pinned");
  return digest;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export async function observeAppliedCellManaged(input: {
  readonly reference: DatabaseCellBindingReference;
  readonly custody: DatabaseCellAppliedCustody;
  readonly packet: Facts["manualCutover"];
  readonly physicalArtifact?: PhysicalRecoveryArtifact;
  readonly ledger: Pick<AkashTxAllocationLedgerPort, "read">;
  readonly console: Pick<
    AkashTxConsolePort,
    "readManagedDefinition" | "status"
  >;
  /** Reread the existing private projected file on each call. No new secret reader. */
  readonly readMountedCustody: () => Promise<unknown>;
}): Promise<ManagedObservation> {
  const custody = DatabaseCellAppliedCustodySchema.parse(
    await input.readMountedCustody()
  );
  if (JSON.stringify(custody) !== JSON.stringify(input.custody))
    throw new Error("applied_mounted_custody_changed_during_observation");
  const packet = input.packet;
  const physical = input.physicalArtifact;
  const legacy =
    packet.physicalRecovery?.sourceAnchorKind === "legacy-native-capture";
  if (legacy !== Boolean(custody.physicalRecoverySource))
    throw new Error("physical_source_custody_variant_mismatch");
  if (Boolean(packet.physicalRecovery) !== Boolean(physical))
    throw new Error("physical_managed_evidence_missing");
  const [primary, app] = await Promise.all([
    input.ledger.read({ cogniKey: input.reference.cogniKey }),
    input.ledger.read({ cogniKey: packet.appCogniKey }),
  ]);
  if (
    !primary ||
    !app ||
    !input.console.readManagedDefinition ||
    primary.cogniKey !== input.reference.cogniKey ||
    app.cogniKey !== packet.appCogniKey ||
    primary.state !== "allocated" ||
    app.state !== "allocated" ||
    primary.receiptId !== packet.allocationReceiptId ||
    app.receiptId !== packet.appAllocationReceiptId ||
    primary.identity.nodeId !== custody.nodeId ||
    app.identity.nodeId !== custody.nodeId ||
    primary.environment !== "production" ||
    app.environment !== "production" ||
    primary.externalName === undefined ||
    app.externalName !== packet.appDseq ||
    primary.externalName === app.externalName ||
    !primary.providerAccount ||
    !primary.lastAppliedSdlHash ||
    !app.lastAppliedSdlHash ||
    !app.providerAccount ||
    (physical
      ? ![
          physical.evidence.target.originalAppliedSdlHash,
          physical.evidence.target.normalSdlHash,
        ].includes(primary.lastAppliedSdlHash ?? "")
      : primary.lastAppliedSdlHash !==
        custody.manualProvenance.managedSdlSha256) ||
    (physical
      ? ![
          physical.evidence.app.originalAppliedSdlHash,
          physical.evidence.app.heldSdlHash,
        ].includes(app.lastAppliedSdlHash ?? "")
      : app.lastAppliedSdlHash !== packet.appSdlHash) ||
    app.workload !== custody.nodeSlug ||
    packet.appDsnSha256 !== sha(custody.app.dsn) ||
    packet.serviceDsnSha256 !== sha(custody.service.dsn) ||
    packet.migrationConsumer !== custody.migration.kind ||
    JSON.stringify(packet.runtimePoolLimits) !==
      JSON.stringify(custody.runtimePoolLimits)
  )
    throw new Error(
      "applied_managed_owned_receipt_or_configured_custody_mismatch"
    );
  const [primaryDefinition, appDefinition, primaryStatus] = await Promise.all([
    input.console.readManagedDefinition({ leaseId: primary.externalName }),
    input.console.readManagedDefinition({ leaseId: packet.appDseq }),
    input.console.status({ leaseId: primary.externalName }),
  ]);
  if (
    primaryDefinition.consoleManifestVersion !==
      packet.primaryManifestVersion ||
    primaryDefinition.chainManifestVersion !== packet.primaryManifestVersion ||
    primaryDefinition.providerAccount !== primary.providerAccount ||
    appDefinition.providerAccount !== app.providerAccount ||
    appDefinition.consoleManifestVersion !== packet.appManifestVersion ||
    appDefinition.chainManifestVersion !== packet.appManifestVersion ||
    primaryStatus.state !== "active" ||
    primaryStatus.leaseId !== primary.externalName
  )
    throw new Error("applied_managed_current_provider_identity_mismatch");
  if (physical) {
    const source = await input.ledger.read({
      cogniKey: physical.evidence.source.cogniKey,
    });
    if (
      !source ||
      source.state !== "allocated" ||
      source.retentionPolicy !== "retain" ||
      primary.retentionPolicy !== "retain" ||
      source.identity.nodeId !== custody.nodeId ||
      source.environment !== "production" ||
      source.receiptId !== physical.evidence.source.receiptId ||
      source.externalName !== physical.evidence.source.dseq ||
      source.providerAccount !== physical.evidence.source.providerAccount ||
      source.lastAppliedSdlHash !==
        physical.evidence.source.originalAppliedSdlHash ||
      source.externalName === primary.externalName ||
      source.externalName === app.externalName
    )
      throw new Error("physical_managed_source_receipt_mismatch");
    const history = primary.appliedDatabaseCellBinding?.find(
      (receipt) => receipt.binding.environment === "production"
    );
    let ledgerHashes = {
      source: source.lastAppliedSdlHash,
      target: primary.lastAppliedSdlHash,
      app: app.lastAppliedSdlHash,
    };
    if (history) {
      const old = history.registration?.physicalRecovery;
      if (
        history.binding.phase !== "applied" ||
        !old ||
        JSON.stringify(old) !== JSON.stringify(packet.physicalRecovery) ||
        history.registration?.manualCutoverPacketSha256 !==
          packet.packetSha256 ||
        primary.lastAppliedSdlHash !== physical.evidence.target.normalSdlHash ||
        app.lastAppliedSdlHash !==
          physical.evidence.app.originalAppliedSdlHash ||
        source.lastAppliedSdlHash !== old.originalAppliedSdlHashes.source
      )
        throw new Error("physical_managed_original_anchor_history_mismatch");
      ledgerHashes = old.originalAppliedSdlHashes;
    }
    if (
      !ledgerHashes.source ||
      JSON.stringify(ledgerHashes) !==
        JSON.stringify(packet.physicalRecovery?.originalAppliedSdlHashes)
    )
      throw new Error("physical_managed_independent_original_anchors_missing");
    qualifyPhysicalPostimages({
      artifact: physical,
      custody,
      primaryServiceName: packet.primaryServiceName,
      appServiceName: packet.appServiceName,
      ledgerHashes: {
        source: ledgerHashes.source,
        target: ledgerHashes.target,
        app: ledgerHashes.app,
      },
    });
    const sourceDefinition = await input.console.readManagedDefinition({
      leaseId: source.externalName,
    });
    const e = physical.evidence;
    if (
      sourceDefinition.leaseId !== source.externalName ||
      sourceDefinition.providerAccount !== source.providerAccount ||
      sourceDefinition.ownerAccount !== primaryDefinition.ownerAccount ||
      sourceDefinition.ownerAccount !== appDefinition.ownerAccount ||
      sourceDefinition.consoleManifestVersion !== e.source.manifestVersion ||
      sourceDefinition.chainManifestVersion !== e.source.manifestVersion ||
      sourceDefinition.providerSdlSha256 !== e.source.storedSdlSha256 ||
      sha(sourceDefinition.providerSdl) !== e.source.storedSdlSha256 ||
      primaryDefinition.providerSdlSha256 !== e.target.storedSdlSha256 ||
      sha(primaryDefinition.providerSdl) !== e.target.storedSdlSha256 ||
      appDefinition.providerSdlSha256 !== e.app.heldSdlHash ||
      sha(appDefinition.providerSdl) !== e.app.heldSdlHash ||
      sourceDefinition.consoleManifestVersion !==
        sourceDefinition.chainManifestVersion ||
      Date.parse(sourceDefinition.observedAt) < Date.now() - 60000
    )
      throw new Error("physical_managed_known_postimage_mismatch");
  }
  const primaryService = primaryDefinition.services[0];
  if (
    primaryDefinition.services.length !== 1 ||
    !primaryService ||
    primaryService.name !== packet.primaryServiceName ||
    primaryService.observedGeneration <= 0 ||
    [
      primaryService.replicas,
      primaryService.updatedReplicas,
      primaryService.readyReplicas,
      primaryService.availableReplicas,
      primaryService.total,
      primaryService.available,
    ].some((count) => count !== 1)
  )
    throw new Error("applied_managed_primary_replica_identity_mismatch");
  const appServices = Definition.parse(
    parse(appDefinition.providerSdl)
  ).services;
  const appService = appServices[packet.appServiceName];
  const primaryImages = Object.values(
    Definition.parse(parse(primaryDefinition.providerSdl)).services
  ).map((service) => imageDigest(service.image));
  if (
    !appService ||
    imageDigest(appService.image) !== packet.appImageDigest ||
    primaryImages.length !== 1 ||
    primaryImages[0] !== custody.manualProvenance.postgresImageDigest
  )
    throw new Error("applied_managed_current_declared_image_mismatch");
  const endpoints = [...new Set(primaryStatus.endpoints)].filter((endpoint) =>
    endpoint.startsWith("tcp://")
  );
  if (endpoints.length !== 1 || !endpoints[0])
    throw new Error("applied_managed_primary_endpoint_ambiguous");
  const endpoint = new URL(endpoints[0]);
  if (
    isIP(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname
  )
    throw new Error("applied_managed_primary_endpoint_invalid");
  const migrationDsn =
    custody.migration.kind === "app-database-url"
      ? custody.app.dsn
      : custody.migration.dsn;
  return {
    provider: {
      observedAt: primaryDefinition.observedAt,
      dseq: primary.externalName,
      providerAccount: primary.providerAccount,
      appliedSdlHash:
        physical?.evidence.target.normalSdlHash ?? primary.lastAppliedSdlHash,
      postgresImageDigest: custody.manualProvenance.postgresImageDigest,
      manifestVersion: primaryDefinition.consoleManifestVersion,
      service: primaryService,
    },
    providerEndpoint: { host: endpoint.hostname, port: Number(endpoint.port) },
    effectiveApp: {
      allocationReceiptId: app.receiptId,
      deployedSourceSha: packet.appSourceSha,
      appliedSdlHash: app.lastAppliedSdlHash,
      nodeId: custody.nodeId,
      environment: "production",
      // These are current mounted configured consumers. The canonical writer verifies
      // their real Bao banks before publication; this reader does not reread Bao.
      appDsnSha256: sha(custody.app.dsn),
      serviceDsnSha256: sha(custody.service.dsn),
      migrationDsnSha256: sha(migrationDsn),
      ...(custody.tls.kind === "private-ca"
        ? { tlsCaSha256: sha(custody.tls.caCertificate) }
        : {}),
      tlsTrustKind: custody.tls.kind,
      migrationConsumer: custody.migration.kind,
      ...(custody.runtimePoolLimits
        ? { runtimePoolLimits: custody.runtimePoolLimits }
        : {}),
      providerManifest: {
        observedAt: appDefinition.observedAt,
        consoleVersion: appDefinition.consoleManifestVersion,
        chainVersion: appDefinition.chainManifestVersion,
        imageDigest: imageDigest(appService.image),
        services: appDefinition.services,
      },
    },
  };
}
