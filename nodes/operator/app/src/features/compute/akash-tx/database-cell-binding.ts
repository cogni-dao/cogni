// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/database-cell-binding`
 * Purpose: Seal native cell identity into the existing paid allocation before audited cutover.
 * Scope: One bounded observe and native read per request; does not allocate compute or publish secrets.
 * Invariants: Caller supplies references only; provider receipt, owned kit and scoped native observations supply binding facts.
 * Side-effects: IO (existing provider observation, native proof, allocation metadata)
 * Links: ports/database-cell-binding.port.ts, shared/secrets/database-cell-placement.data.ts
 * @internal
 */
import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type {
  AkashTxActuatorPort,
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  DatabaseCellBindingPort,
  DatabaseCellBindingReference,
  DatabaseCellCutoverReference,
  DatabaseCellNativeObserverPort,
  DatabaseCellNativeProof,
} from "@/ports";
import { AkashTxError } from "@/ports";
import type { DatabaseCellBootstrapKit } from "@/shared/secrets/database-cell-binding.data";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptsSchema,
} from "@/shared/secrets/database-cell-placement.data";

interface BindingStore {
  read(cogniKey: string): Promise<readonly AppliedDatabaseCellReceipt[]>;
  save(
    record: AkashTxAllocationRecord,
    bindings: readonly AppliedDatabaseCellReceipt[],
    expected: readonly AppliedDatabaseCellReceipt[]
  ): Promise<void>;
}
export class DatabaseCellBinder implements DatabaseCellBindingPort {
  constructor(
    private readonly deps: {
      ledger: Pick<AkashTxAllocationLedgerPort, "read" | "listAllocated">;
      actuator: Pick<AkashTxActuatorPort, "observe">;
      store: BindingStore;
      observeNative: DatabaseCellNativeObserverPort["observe"];
      kit(
        reference: DatabaseCellBindingReference
      ): Promise<DatabaseCellBootstrapKit>;
      buildSha: string;
    }
  ) {}

  private async record(input: DatabaseCellBindingReference) {
    const record = await this.deps.ledger.read({ cogniKey: input.cogniKey });
    if (
      !record ||
      record.state !== "allocated" ||
      record.identity.nodeId !== input.nodeId ||
      record.environment !== input.allocationEnvironment ||
      !record.externalName ||
      !record.providerAccount ||
      !record.lastAppliedSdlHash
    )
      throw new AkashTxError(
        "identity_conflict",
        "cell reference differs from its applied allocation"
      );
    return {
      ...record,
      externalName: record.externalName,
      providerAccount: record.providerAccount,
      lastAppliedSdlHash: record.lastAppliedSdlHash,
    };
  }

  async discover(input: Omit<DatabaseCellBindingReference, "cogniKey">) {
    const kit = await this.deps.kit({ ...input, cogniKey: "" });
    const records = await this.deps.ledger.listAllocated({
      nodeId: input.nodeId,
      environment: input.allocationEnvironment,
      limit: 100,
    });
    const matching = records.filter(
      (record) => record.workload === `${kit.nodeSlug}-database-cell`
    );
    const selected = matching[0];
    if (matching.length !== 1 || !selected)
      throw new AkashTxError(
        "not_found",
        "owned cell allocation absent or ambiguous"
      );
    const reference = { ...input, cogniKey: selected.cogniKey };
    const record = await this.record(reference);
    const observed = await this.deps.actuator.observe({
      cogniKey: record.cogniKey,
      externalName: record.externalName,
    });
    if (
      !observed.found ||
      !observed.resource ||
      observed.resource.externalName !== record.externalName ||
      observed.resource.providerAccount !== record.providerAccount
    )
      throw new AkashTxError(
        "identity_conflict",
        "owned cell allocation no longer matches its provider"
      );
    return {
      reference,
      identity: record.identity,
      externalName: record.externalName,
      endpoints: observed.resource.endpoints,
      kitCertificateSha256: createHash("sha256")
        .update(kit.tlsCertificate)
        .digest("hex"),
    };
  }

  async read(input: DatabaseCellBindingReference) {
    const record = await this.record(input);
    const receipts = AppliedDatabaseCellReceiptsSchema.parse(
      await this.deps.store.read(input.cogniKey)
    );
    for (const receipt of receipts) {
      const binding = receipt.binding;
      if (
        receipt.allocationEnvironment !== record.environment ||
        binding.receiptId !== record.receiptId ||
        binding.nodeId !== record.identity.nodeId ||
        binding.cogniKey !== record.cogniKey ||
        binding.dseq !== record.externalName ||
        binding.providerAccount !== record.providerAccount
      )
        throw new AkashTxError(
          "identity_conflict",
          "stored cell placement differs from its allocation"
        );
    }
    return receipts;
  }

  async seal(input: DatabaseCellBindingReference) {
    const record = await this.record(input);
    const kit = await this.deps.kit(input);
    if (
      kit.nodeId !== input.nodeId ||
      kit.environment !== input.allocationEnvironment ||
      kit.sourceSha !== this.deps.buildSha
    )
      throw new AkashTxError(
        "identity_conflict",
        "cell kit differs from the running approved artifact"
      );
    const observed = await this.deps.actuator.observe({
      cogniKey: input.cogniKey,
      externalName: record.externalName,
    });
    const resource = observed.resource;
    if (
      !observed.found ||
      !resource ||
      resource.externalName !== record.externalName ||
      resource.providerAccount !== record.providerAccount
    )
      throw new AkashTxError(
        "identity_conflict",
        "observed cell differs from its allocated provider"
      );
    const endpoints = [...new Set(resource.endpoints)]
      .filter((value) => value.startsWith("tcp://"))
      .map((value) => new URL(value));
    if (endpoints.length !== 1)
      throw new AkashTxError(
        "invalid_request",
        "cell must expose one measured TCP endpoint"
      );
    const providerEndpoint = endpoints[0];
    const endpoint =
      kit.canonicalEndpointHost && providerEndpoint
        ? new URL(`tcp://${kit.canonicalEndpointHost}:${providerEndpoint.port}`)
        : providerEndpoint;
    if (
      !endpoint ||
      isIP(endpoint.hostname) ||
      !/^[a-z0-9][a-z0-9.-]+$/.test(endpoint.hostname) ||
      !endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new AkashTxError(
        "invalid_request",
        "cell requires its observed strict DNS TCP endpoint"
      );
    const proofs = await this.deps.observeNative(kit, {
      host: endpoint.hostname,
      port: Number(endpoint.port),
      ...(kit.canonicalEndpointHost && providerEndpoint
        ? {
            providerEndpoint: {
              host: providerEndpoint.hostname,
              port: Number(providerEndpoint.port),
            },
          }
        : {}),
    });
    if (kit.canonicalEndpointHost && providerEndpoint) {
      const certificateDerSha256 = createHash("sha256")
        .update(new X509Certificate(kit.tlsCertificate).raw)
        .digest("hex");
      if (
        !proofs.length ||
        proofs.some(
          (proof) =>
            !matchesEndpointIdentity(
              proof,
              providerEndpoint,
              endpoint,
              certificateDerSha256
            )
        )
      ) {
        throw new AkashTxError(
          "identity_conflict",
          "canonical cell DNS, TLS and native identity are not proven against the paid endpoint"
        );
      }
    }
    const previous = await this.read(input);
    const receipts = AppliedDatabaseCellReceiptsSchema.parse(
      proofs.map(({ lane, observation, incident }) => {
        const old = previous.find(
          (value) => value.binding.environment === lane.environment
        );
        if (
          old &&
          (old.binding.systemIdentifier !== observation.systemIdentifier ||
            old.binding.databaseName !== lane.databaseName ||
            old.binding.endpoint.host !== endpoint.hostname ||
            old.binding.endpoint.port !== Number(endpoint.port))
        )
          throw new AkashTxError(
            "identity_conflict",
            "cell placement cannot silently change physical identity"
          );
        if (old?.binding.phase === "applied") return old;
        if (
          !observation.runtimeRolesNoLogin ||
          observation.activeRuntimeSessions !== 0 ||
          incident.state !== "contained"
        )
          throw new AkashTxError(
            "invalid_request",
            "prestage cell must remain natively contained"
          );
        return {
          allocationEnvironment: record.environment,
          targetBuildSha: lane.sourceSha,
          initialIncidentId: incident.incidentId,
          binding: {
            version: 1,
            phase: "ready",
            receiptId: record.receiptId,
            cogniKey: record.cogniKey,
            nodeId: kit.nodeId,
            nodeSlug: kit.nodeSlug,
            environment: lane.environment,
            provider: "akash",
            dseq: record.externalName,
            providerAccount: record.providerAccount,
            endpoint: {
              host: endpoint.hostname,
              port: Number(endpoint.port),
              tlsMode: "verify-full",
              tlsCertificateSha256: createHash("sha256")
                .update(kit.tlsCertificate)
                .digest("hex"),
            },
            databaseName: lane.databaseName,
            appRole: lane.appRole,
            serviceRole: lane.serviceRole,
            migrationRole: lane.migrationRole,
            probeRole: lane.probeRole,
            systemIdentifier: observation.systemIdentifier,
            failureDomainId: `akash:${record.providerAccount}:${record.externalName}`,
            sourceSha: kit.sourceSha,
            budgetProfile: lane.budgetProfile,
            appliedSdlHash: record.lastAppliedSdlHash,
            readyAt: old?.binding.readyAt ?? new Date().toISOString(),
          },
        };
      })
    );
    if (JSON.stringify(previous) !== JSON.stringify(receipts))
      await this.deps.store.save(record, receipts, previous);
    return receipts;
  }
  async cutover(input: DatabaseCellCutoverReference) {
    if (
      input.allocationEnvironment !== "production" ||
      !/^[0-9a-f]{64}$/.test(input.packetSha256) ||
      !/^human:[a-zA-Z0-9._@:-]{1,120}$/.test(input.actorId)
    )
      throw new AkashTxError(
        "invalid_request",
        "production cutover requires its reviewed human packet"
      );
    const receipts = await this.seal(input);
    const prod = receipts.find(
      (receipt) => receipt.binding.environment === "production"
    );
    if (!prod)
      throw new AkashTxError(
        "invalid_request",
        "production cell receipt missing"
      );
    if (prod.binding.phase === "applied") {
      if (
        prod.binding.cutover?.packetSha256 !== input.packetSha256 ||
        prod.binding.cutover?.actorId !== input.actorId
      )
        throw new AkashTxError(
          "identity_conflict",
          "approved cutover cannot be rebound"
        );
      return receipts;
    }
    const kit = await this.deps.kit(input);
    const proofs = await this.deps.observeNative(kit, prod.binding.endpoint);
    const proof = proofs.find(
      (value) => value.lane.environment === "production"
    );
    if (
      !proof?.observation.systemTenantExists ||
      !proof.observation.backupQualified ||
      !proof.observation.runtimeRolesNoLogin ||
      proof.observation.activeRuntimeSessions !== 0 ||
      proof.observation.systemIdentifier !== prod.binding.systemIdentifier ||
      proof.incident.incidentId !== prod.initialIncidentId ||
      proof.incident.state !== "contained"
    )
      throw new AkashTxError(
        "invalid_request",
        "restored production cell must remain natively contained"
      );
    const applied = AppliedDatabaseCellReceiptsSchema.parse(
      receipts.map((receipt) =>
        receipt === prod
          ? {
              ...receipt,
              binding: {
                ...receipt.binding,
                phase: "applied",
                cutover: {
                  packetSha256: input.packetSha256,
                  actorId: input.actorId,
                  approvedAt: new Date().toISOString(),
                },
              },
            }
          : receipt
      )
    );
    await this.deps.store.save(await this.record(input), applied, receipts);
    return applied;
  }
}

/** Alias facts must describe the same live endpoint; a configured hostname is never proof. */
function matchesEndpointIdentity(
  proof: DatabaseCellNativeProof,
  provider: URL,
  canonical: URL,
  certificateDerSha256: string
): boolean {
  const identity = proof.endpointIdentity;
  if (!identity) return false;
  const observedAt = Date.parse(identity.observedAt);
  return (
    Number.isFinite(observedAt) &&
    observedAt <= Date.now() + 5_000 &&
    observedAt >= Date.now() - 60_000 &&
    identity.provider.host === provider.hostname &&
    identity.provider.port === Number(provider.port) &&
    identity.canonical.host === canonical.hostname &&
    identity.canonical.port === Number(canonical.port) &&
    identity.systemIdentifier === proof.observation.systemIdentifier &&
    identity.peerCertificateDerSha256 === certificateDerSha256 &&
    identity.provider.addresses.length > 0 &&
    identity.canonical.addresses.length > 0 &&
    identity.provider.addresses.every((address) => Boolean(isIP(address))) &&
    identity.canonical.addresses.every((address) => Boolean(isIP(address))) &&
    identity.provider.addresses.some((address) =>
      identity.canonical.addresses.includes(address)
    )
  );
}
