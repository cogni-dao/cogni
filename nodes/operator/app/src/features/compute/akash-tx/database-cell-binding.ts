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
  DatabaseCellAppliedRegistrationEvidencePort,
  DatabaseCellAppliedRegistrationPort,
  DatabaseCellBindingPort,
  DatabaseCellBindingReference,
  DatabaseCellCutoverReference,
  DatabaseCellNativeObserverPort,
  DatabaseCellNativeProof,
} from "@/ports";
import { AkashTxError } from "@/ports";
import {
  composeDatabaseCellDsn,
  type DatabaseCellBootstrapKit,
} from "@/shared/secrets/database-cell-binding.data";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptsSchema,
  DatabaseCellAppliedRegistrationFactsSchema,
} from "@/shared/secrets/database-cell-placement.data";

interface BindingStore {
  read(cogniKey: string): Promise<readonly AppliedDatabaseCellReceipt[]>;
  save(
    record: AkashTxAllocationRecord,
    bindings: readonly AppliedDatabaseCellReceipt[],
    expected: readonly AppliedDatabaseCellReceipt[]
  ): Promise<void>;
}
export class DatabaseCellBinder
  implements DatabaseCellBindingPort, DatabaseCellAppliedRegistrationPort
{
  constructor(
    private readonly deps: {
      ledger: Pick<AkashTxAllocationLedgerPort, "read" | "listAllocated">;
      actuator: Pick<AkashTxActuatorPort, "observe">;
      store: BindingStore;
      observeNative: DatabaseCellNativeObserverPort["observe"];
      observeApplied?: DatabaseCellAppliedRegistrationEvidencePort["observe"];
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
              proof.endpointIdentity,
              proof.observation.systemIdentifier,
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
  async registerApplied(
    input: Parameters<DatabaseCellAppliedRegistrationPort["registerApplied"]>[0]
  ) {
    const refuse: (message: string) => never = (message) => {
      throw new AkashTxError("identity_conflict", message);
    };
    if (
      input.allocationEnvironment !== "production" ||
      !/^[0-9a-f]{64}$/.test(input.manualCutoverPacketSha256) ||
      !input.readmissionReceiptId
    )
      refuse("production registration requires audited receipt references");
    if (!this.deps.observeApplied)
      throw new AkashTxError(
        "ledger_unavailable",
        "read-only applied registration evidence producer unavailable"
      );
    const record = await this.record(input);
    const kit = await this.deps.kit(input);
    const lanes = kit.logicalDatabases.filter(
      (lane) => lane.environment === "production"
    );
    const lane = lanes[0];
    if (
      kit.nodeId !== input.nodeId ||
      kit.environment !== "production" ||
      lanes.length !== 1 ||
      !lane ||
      !kit.canonicalEndpointHost
    )
      refuse(
        "registration lacks its owned production kit and canonical DNS custody"
      );
    // This observer is distinct from prestage qualification. It must only read actual
    // provider/native/runtime state and authenticated immutable receipt artifacts.
    const parsedFacts = DatabaseCellAppliedRegistrationFactsSchema.safeParse(
      await this.deps.observeApplied({
        reference: input,
        kit,
        manualCutoverPacketSha256: input.manualCutoverPacketSha256,
        readmissionReceiptId: input.readmissionReceiptId,
      })
    );
    if (!parsedFacts.success)
      throw new AkashTxError(
        "ledger_unavailable",
        "trusted applied registration evidence malformed"
      );
    const facts = parsedFacts.data;
    const {
      provider,
      native,
      effectiveApp: app,
      manualCutover: packet,
      readmission,
      scheduledBackup: backup,
      independentRecovery: recovery,
    } = facts;
    const observed = await this.deps.actuator.observe({
      cogniKey: record.cogniKey,
      externalName: record.externalName,
    });
    const endpoints = [...new Set(observed.resource?.endpoints ?? [])].filter(
      (value) => value.startsWith("tcp://")
    );
    if (
      !observed.found ||
      observed.resource?.state !== "active" ||
      observed.resource.externalName !== record.externalName ||
      observed.resource.providerAccount !== record.providerAccount ||
      endpoints.length !== 1
    )
      refuse("registration provider differs from its allocated primary");
    const providerEndpointValue = endpoints[0];
    if (!providerEndpointValue) refuse("registration provider endpoint absent");
    const providerEndpoint = new URL(providerEndpointValue);
    const canonical = new URL(
      `tcp://${kit.canonicalEndpointHost}:${providerEndpoint.port}`
    );
    if (
      isIP(providerEndpoint.hostname) ||
      !providerEndpoint.port ||
      providerEndpoint.username ||
      providerEndpoint.password ||
      providerEndpoint.search ||
      providerEndpoint.hash
    )
      refuse("registration requires the actual strict DNS provider endpoint");
    const sha = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const fresh = (value: string) =>
      Date.parse(value) >= Date.now() - 60_000 &&
      Date.parse(value) <= Date.now() + 5_000;
    if (
      !fresh(facts.observedAt) ||
      !matchesEndpointIdentity(
        native.endpointIdentity,
        native.systemIdentifier,
        providerEndpoint,
        canonical,
        createHash("sha256")
          .update(new X509Certificate(kit.tlsCertificate).raw)
          .digest("hex")
      )
    )
      refuse(
        "registration requires fresh paid-endpoint DNS, strict TLS and native identity proof"
      );
    if (
      provider.dseq !== record.externalName ||
      provider.providerAccount !== record.providerAccount ||
      provider.appliedSdlHash !== record.lastAppliedSdlHash ||
      native.databaseName !== lane.databaseName ||
      native.appRole !== lane.appRole ||
      native.serviceRole !== lane.serviceRole
    )
      refuse(
        "registration native identity or managed SDL differs from custody"
      );
    if (
      packet.packetSha256 !== input.manualCutoverPacketSha256 ||
      packet.nodeId !== kit.nodeId ||
      packet.nodeSlug !== kit.nodeSlug ||
      packet.cellSourceSha !== kit.sourceSha ||
      packet.allocationReceiptId !== record.receiptId ||
      packet.systemIdentifier !== native.systemIdentifier ||
      packet.appSourceSha !== lane.sourceSha ||
      packet.appAllocationReceiptId !== app.allocationReceiptId ||
      packet.appSdlHash !== app.appliedSdlHash
    )
      refuse(
        "manual packet differs from the actual primary allocation or application"
      );
    if (
      readmission.receiptId !== input.readmissionReceiptId ||
      readmission.packetSha256 !== packet.packetSha256 ||
      readmission.allocationReceiptId !== record.receiptId ||
      readmission.systemIdentifier !== native.systemIdentifier ||
      readmission.authorizedActorId !== packet.authorizedActorId ||
      Date.parse(readmission.admittedAt) < Date.parse(packet.approvedAt) ||
      Date.parse(readmission.admittedAt) > Date.now() + 5_000
    )
      refuse(
        "registration readmission identity or chronology differs from its reviewed packet"
      );
    const runtimeRoles = [lane.appRole, lane.serviceRole];
    if (
      runtimeRoles.some(
        (name) =>
          native.runtimeRoles.filter(
            (role) => role.name === name && role.canLogin
          ).length !== 1
      )
    )
      refuse("registration must observe the genuinely admitted runtime roles");
    const url = (role: string, password: string) =>
      composeDatabaseCellDsn(
        { host: canonical.hostname, port: Number(canonical.port) },
        lane.databaseName,
        role,
        password
      );
    const appDsn = url(lane.appRole, lane.appPassword);
    if (
      app.nodeId !== kit.nodeId ||
      app.deployedSourceSha !== lane.sourceSha ||
      app.appDsnSha256 !== sha(appDsn) ||
      app.serviceDsnSha256 !==
        sha(url(lane.serviceRole, lane.servicePassword)) ||
      app.migrationDsnSha256 !==
        sha(
          app.migrationConsumer === "app-database-url"
            ? appDsn
            : url(lane.migrationRole, lane.migrationPassword)
        ) ||
      app.tlsTrustKind !== native.tlsTrustKind ||
      (app.tlsTrustKind === "private-ca" &&
        app.tlsCaSha256 !== sha(kit.tlsCaCertificate)) ||
      new Set(app.regions.map((region) => region.region)).size < 2 ||
      app.regions.some(
        (region) =>
          region.status !== 200 ||
          region.buildSha !== lane.sourceSha ||
          !fresh(region.observedAt)
      )
    )
      refuse(
        "registration current application DSN, TLS, source SHA or regional readiness differs from custody"
      );
    const sameRelations = (values: readonly string[]) =>
      JSON.stringify([...values].sort()) ===
      JSON.stringify([...packet.expectedRelations].sort());
    if (
      (kit.nodeSlug === "poly" && packet.expectedRelations.length !== 68) ||
      !sameRelations(backup.relations) ||
      !sameRelations(recovery.relations) ||
      backup.databaseName !== lane.databaseName ||
      backup.systemIdentifier !== native.systemIdentifier ||
      backup.executorFailureDomainId ===
        `akash:${record.providerAccount}:${record.externalName}` ||
      recovery.archiveSha256 !== backup.archiveSha256 ||
      recovery.restoredSystemIdentifier === native.systemIdentifier ||
      recovery.providerAccount === record.providerAccount ||
      recovery.recoveryFailureDomainId !==
        `akash:${recovery.providerAccount}:${recovery.dseq}` ||
      recovery.recoveryFailureDomainId ===
        `akash:${record.providerAccount}:${record.externalName}` ||
      recovery.fullSchemaFingerprintSha256 !==
        backup.fullSchemaFingerprintSha256 ||
      recovery.fullDataFingerprintSha256 !== backup.fullDataFingerprintSha256 ||
      recovery.sequenceStateFingerprintSha256 !==
        backup.sequenceStateFingerprintSha256 ||
      recovery.rowCount !== backup.rowCount ||
      Date.parse(backup.completedAt) < Date.parse(backup.snapshotStartedAt) ||
      Date.parse(recovery.completedAt) < Date.parse(backup.completedAt) ||
      Date.parse(recovery.completedAt) > Date.now() + 5_000
    )
      refuse(
        "registration requires an actual scheduled full backup and matching independent complete recovery"
      );
    const previous = await this.read(input);
    const old = previous.find(
      (receipt) => receipt.binding.environment === "production"
    );
    if (
      old &&
      (old.binding.phase !== "applied" ||
        old.binding.systemIdentifier !== native.systemIdentifier ||
        old.binding.endpoint.host !== canonical.hostname ||
        old.binding.endpoint.port !== Number(canonical.port) ||
        old.binding.cutover?.packetSha256 !== packet.packetSha256 ||
        old.registration?.readmissionReceiptId !== readmission.receiptId ||
        old.registration.scheduledBackupReceiptSha256 !==
          backup.receiptSha256 ||
        old.registration.independentRecoveryReceiptSha256 !==
          recovery.receiptSha256 ||
        old.registration.appAllocationReceiptId !== app.allocationReceiptId ||
        old.registration.appSdlHash !== app.appliedSdlHash ||
        old.registration.migrationConsumer !== app.migrationConsumer ||
        old.registration.tlsTrustKind !== app.tlsTrustKind)
    )
      refuse(
        "applied registration cannot replace prior physical identity or audited custody"
      );
    if (old) return previous;
    const receipt: AppliedDatabaseCellReceipt = {
      allocationEnvironment: "production",
      targetBuildSha: lane.sourceSha,
      registration: {
        kind: "audited-manual",
        readmissionReceiptId: readmission.receiptId,
        manualCutoverPacketSha256: packet.packetSha256,
        scheduledBackupReceiptSha256: backup.receiptSha256,
        independentRecoveryReceiptSha256: recovery.receiptSha256,
        appAllocationReceiptId: app.allocationReceiptId,
        appSdlHash: app.appliedSdlHash,
        migrationConsumer: app.migrationConsumer,
        tlsTrustKind: app.tlsTrustKind,
        registeredAt: facts.observedAt,
      },
      binding: {
        version: 1,
        phase: "applied",
        receiptId: record.receiptId,
        cogniKey: record.cogniKey,
        nodeId: kit.nodeId,
        nodeSlug: kit.nodeSlug,
        environment: "production",
        provider: "akash",
        dseq: record.externalName,
        providerAccount: record.providerAccount,
        endpoint: {
          host: canonical.hostname,
          port: Number(canonical.port),
          tlsMode: "verify-full",
          tlsCertificateSha256: sha(kit.tlsCertificate),
        },
        databaseName: lane.databaseName,
        appRole: lane.appRole,
        serviceRole: lane.serviceRole,
        migrationRole: lane.migrationRole,
        probeRole: lane.probeRole,
        systemIdentifier: native.systemIdentifier,
        failureDomainId: `akash:${record.providerAccount}:${record.externalName}`,
        sourceSha: kit.sourceSha,
        budgetProfile: lane.budgetProfile,
        appliedSdlHash: record.lastAppliedSdlHash,
        readyAt: facts.observedAt,
        cutover: {
          packetSha256: packet.packetSha256,
          actorId: packet.authorizedActorId,
          approvedAt: packet.approvedAt,
        },
      },
    };
    const next = AppliedDatabaseCellReceiptsSchema.parse([
      ...previous,
      receipt,
    ]);
    await this.deps.store.save(record, next, previous);
    return next;
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
  identity: DatabaseCellNativeProof["endpointIdentity"],
  systemIdentifier: string,
  provider: URL,
  canonical: URL,
  certificateDerSha256: string
): boolean {
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
    identity.systemIdentifier === systemIdentifier &&
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
