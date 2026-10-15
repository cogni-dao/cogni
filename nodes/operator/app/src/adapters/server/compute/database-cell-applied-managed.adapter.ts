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
} from "@/ports/akash-tx.port";
import type { DatabaseCellBindingReference } from "@/ports/database-cell-binding.port";
import { DatabaseCellAppliedCustodySchema } from "@/shared/secrets/database-cell-binding.data";
import type {
  DatabaseCellAppliedCustody,
  DatabaseCellAppliedRegistrationFacts as Facts,
} from "@/types/database-cell";

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
    !app.providerAccount ||
    primary.lastAppliedSdlHash !== custody.manualProvenance.managedSdlSha256 ||
    app.lastAppliedSdlHash !== packet.appSdlHash ||
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
      appliedSdlHash: primary.lastAppliedSdlHash,
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
