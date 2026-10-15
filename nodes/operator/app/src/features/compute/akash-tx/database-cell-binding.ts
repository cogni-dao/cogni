// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/database-cell-binding`
 * Purpose: Seal native prestage identity or register an audited admitted cell on its existing paid allocation.
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
  DatabaseCellAppliedProbeQualificationPort,
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
  type DatabaseCellAppliedCustody,
  DatabaseCellAppliedCustodySchema,
  type DatabaseCellBootstrapKit,
} from "@/shared/secrets/database-cell-binding.data";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptsSchema,
  assessDatabaseCellBackupRuntime,
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
  implements
    DatabaseCellBindingPort,
    DatabaseCellAppliedRegistrationPort,
    DatabaseCellAppliedProbeQualificationPort
{
  constructor(
    private readonly deps: {
      ledger: Pick<AkashTxAllocationLedgerPort, "read" | "listAllocated">;
      actuator: Pick<AkashTxActuatorPort, "observe">;
      store: BindingStore;
      observeNative: DatabaseCellNativeObserverPort["observe"];
      observeApplied?: DatabaseCellAppliedRegistrationEvidencePort["observe"];
      appliedCustody?(
        reference: DatabaseCellBindingReference
      ): Promise<DatabaseCellAppliedCustody>;
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
    const previous = await this.read(input);
    if (previous.some((receipt) => receipt.registration))
      throw new AkashTxError(
        "identity_conflict",
        "an audited admitted cell cannot enter prestage qualification"
      );
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
    return (await this.validateAppliedRegistration(input, true)).receipts;
  }
  async qualifyAppliedProbe(
    input: Parameters<
      DatabaseCellAppliedProbeQualificationPort["qualifyAppliedProbe"]
    >[0]
  ) {
    const result = await this.validateAppliedRegistration(input, false);
    const selected = result.receipts.filter(
      (receipt) => receipt.binding.environment === "production"
    );
    const receipt = selected[0];
    if (selected.length !== 1 || !receipt || !result.probeDsnSha256)
      throw new AkashTxError(
        "identity_conflict",
        "owned probe qualification absent or ambiguous"
      );
    const core = {
      version: 1 as const,
      nodeId: receipt.binding.nodeId,
      nodeSlug: receipt.binding.nodeSlug,
      environment: "production" as const,
      cogniKey: receipt.binding.cogniKey,
      allocationReceiptId: receipt.binding.receiptId,
      dseq: receipt.binding.dseq,
      providerAccount: receipt.binding.providerAccount,
      systemIdentifier: receipt.binding.systemIdentifier,
      targetBuildSha: receipt.targetBuildSha,
      manualCutoverPacketSha256: input.manualCutoverPacketSha256,
      readmissionReceiptId: input.readmissionReceiptId,
      probeDsnSha256: result.probeDsnSha256,
      observedFactsSha256: result.observedFactsSha256,
      observedAt: result.observedAt,
    };
    return {
      ...core,
      qualificationSha256: createHash("sha256")
        .update(JSON.stringify(core))
        .digest("hex"),
    };
  }
  private async validateAppliedRegistration(
    input: Parameters<
      DatabaseCellAppliedRegistrationPort["registerApplied"]
    >[0],
    persist: boolean
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
    if (!this.deps.observeApplied || !this.deps.appliedCustody)
      throw new AkashTxError(
        "ledger_unavailable",
        "read-only applied registration evidence producer unavailable"
      );
    const record = await this.record(input);
    const custody = DatabaseCellAppliedCustodySchema.parse(
      await this.deps.appliedCustody(input)
    );
    if (custody.nodeId !== input.nodeId || custody.environment !== "production")
      refuse("registration lacks its owned production applied custody");
    // This observer is distinct from prestage qualification. It must only read actual
    // provider/native/runtime state and authenticated immutable receipt artifacts.
    const parsedFacts = DatabaseCellAppliedRegistrationFactsSchema.safeParse(
      await this.deps.observeApplied({
        reference: input,
        custody,
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
    const validated = (receipts: readonly AppliedDatabaseCellReceipt[]) => ({
      receipts,
      observedAt: facts.observedAt,
      observedFactsSha256: createHash("sha256")
        .update(JSON.stringify(facts))
        .digest("hex"),
      probeDsnSha256: custody.readOnlyProbe
        ? createHash("sha256").update(custody.readOnlyProbe.dsn).digest("hex")
        : null,
    });
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
      `tcp://${custody.canonicalEndpointHost}:${providerEndpoint.port}`
    );
    if (
      isIP(providerEndpoint.hostname) ||
      !providerEndpoint.port ||
      providerEndpoint.username ||
      providerEndpoint.password ||
      providerEndpoint.search ||
      providerEndpoint.hash ||
      Number(new URL(custody.app.dsn).port) !== Number(canonical.port) ||
      Number(new URL(custody.service.dsn).port) !== Number(canonical.port) ||
      (custody.migration.kind === "dedicated-migration-url" &&
        Number(new URL(custody.migration.dsn).port) !== Number(canonical.port))
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
          .update(new X509Certificate(custody.tlsCertificate).raw)
          .digest("hex")
      )
    )
      refuse(
        "registration requires fresh paid-endpoint DNS, strict TLS and native identity proof"
      );
    if (
      !fresh(provider.observedAt) ||
      provider.manifestVersion !== packet.primaryManifestVersion ||
      provider.service.name !== packet.primaryServiceName ||
      provider.service.observedGeneration <= 0 ||
      [
        provider.service.replicas,
        provider.service.updatedReplicas,
        provider.service.readyReplicas,
        provider.service.availableReplicas,
        provider.service.total,
        provider.service.available,
      ].some((count) => count !== 1) ||
      provider.dseq !== record.externalName ||
      provider.providerAccount !== record.providerAccount ||
      provider.appliedSdlHash !== record.lastAppliedSdlHash ||
      provider.postgresImageDigest !==
        custody.manualProvenance.postgresImageDigest ||
      native.databaseName !== custody.databaseName ||
      native.appRole !== custody.appRole ||
      native.serviceRole !== custody.serviceRole
    )
      refuse(
        "registration native identity or managed SDL differs from custody"
      );
    if (
      packet.packetSha256 !== input.manualCutoverPacketSha256 ||
      packet.nodeId !== custody.nodeId ||
      packet.nodeSlug !== custody.nodeSlug ||
      JSON.stringify(packet.manualProvenance) !==
        JSON.stringify(custody.manualProvenance) ||
      custody.manualProvenance.managedSdlSha256 !== record.lastAppliedSdlHash ||
      Date.parse(custody.manualProvenance.qualifiedAt) >
        Date.parse(facts.observedAt) + 5000 ||
      packet.allocationReceiptId !== record.receiptId ||
      packet.systemIdentifier !== native.systemIdentifier ||
      packet.sourceSystemIdentifier === native.systemIdentifier ||
      packet.appSourceSha !== custody.targetBuildSha ||
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
      JSON.stringify(readmission.executionActor) !==
        JSON.stringify(packet.executionActor) ||
      JSON.stringify(readmission.approvalAuthority) !==
        JSON.stringify(packet.approvalAuthority) ||
      Date.parse(packet.approvalAuthority.capturedAt) >
        Date.parse(packet.approvedAt) ||
      Date.parse(readmission.admittedAt) < Date.parse(packet.approvedAt) ||
      Date.parse(readmission.admittedAt) > Date.now() + 5_000
    )
      refuse(
        "registration readmission identity or chronology differs from its reviewed packet"
      );
    const fields = [
      "connectionLimit",
      "statementTimeoutMs",
      "lockTimeoutMs",
      "idleInTransactionTimeoutMs",
      "tempFileLimitMiB",
      "workMemMiB",
    ] as const;
    if (
      custody.budget.roles.some((expected) => {
        const observedRoles = native.runtimeRoles.filter(
          (role) => role.name === expected.name
        );
        const frozenRoles = packet.preservedRoleBounds.filter(
          (role) => role.name === expected.name
        );
        const actual = observedRoles[0];
        const frozen = frozenRoles[0];
        return (
          observedRoles.length !== 1 ||
          frozenRoles.length !== 1 ||
          !actual ||
          !frozen ||
          !actual.canLogin ||
          actual.roleReadOnly ||
          fields.some(
            (key) =>
              actual[key] !== expected[key] || frozen[key] !== expected[key]
          )
        );
      })
    )
      refuse(
        "registration must observe admitted roles with exact authenticated preserved bounds"
      );
    const migrationDsn =
      custody.migration.kind === "app-database-url"
        ? custody.app.dsn
        : custody.migration.dsn;
    const appService = app.providerManifest.services.filter(
      (service) => service.name === packet.appServiceName
    );
    const currentAppService = appService[0];
    if (
      !fresh(app.providerManifest.observedAt) ||
      appService.length !== 1 ||
      !currentAppService ||
      currentAppService.observedGeneration <= 0 ||
      [
        currentAppService.replicas,
        currentAppService.updatedReplicas,
        currentAppService.readyReplicas,
        currentAppService.availableReplicas,
        currentAppService.total,
        currentAppService.available,
      ].some((count) => count !== 1) ||
      JSON.stringify(app.runtimePoolLimits) !==
        JSON.stringify(custody.runtimePoolLimits) ||
      JSON.stringify(packet.runtimePoolLimits) !==
        JSON.stringify(custody.runtimePoolLimits) ||
      app.nodeId !== custody.nodeId ||
      app.deployedSourceSha !== custody.targetBuildSha ||
      app.providerManifest.consoleVersion !== packet.appManifestVersion ||
      app.providerManifest.chainVersion !== packet.appManifestVersion ||
      app.providerManifest.imageDigest !== packet.appImageDigest ||
      !fresh(app.runtimeAdoption.observedAt) ||
      app.runtimeAdoption.systemIdentifier !== native.systemIdentifier ||
      app.runtimeAdoption.publicBootEgressIp !== packet.appEgressIp ||
      app.runtimeAdoption.sessions.length === 0 ||
      app.runtimeAdoption.sessions.some(
        (session) =>
          session.count <= 0 ||
          ![custody.appRole, custody.serviceRole].includes(session.role) ||
          !packet.expectedRuntimeApplications.some(
            (expected) =>
              expected.role === session.role &&
              expected.applicationName === session.applicationName
          )
      ) ||
      packet.expectedRuntimeApplications.some(
        (expected) =>
          ![custody.appRole, custody.serviceRole].includes(expected.role)
      ) ||
      packet.appDsnSha256 !== sha(custody.app.dsn) ||
      packet.serviceDsnSha256 !== sha(custody.service.dsn) ||
      packet.migrationConsumer !== custody.migration.kind ||
      app.appDsnSha256 !== sha(custody.app.dsn) ||
      app.serviceDsnSha256 !== sha(custody.service.dsn) ||
      app.migrationConsumer !== custody.migration.kind ||
      app.migrationDsnSha256 !== sha(migrationDsn) ||
      app.tlsTrustKind !== native.tlsTrustKind ||
      app.tlsTrustKind !== custody.tls.kind ||
      (custody.tls.kind === "private-ca"
        ? app.tlsCaSha256 !== sha(custody.tls.caCertificate)
        : app.tlsCaSha256 !== undefined) ||
      new Set(app.regions.map((region) => region.region)).size < 2 ||
      app.regions.some(
        (region) =>
          region.status !== 200 ||
          region.buildSha !== custody.targetBuildSha ||
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
      !sameRelations(backup.relations) ||
      !sameRelations(recovery.relations) ||
      backup.databaseName !== custody.databaseName ||
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
    const runtime = facts.backupRuntime;
    const latest = runtime.latestCompletedBackup;
    const assessed = assessDatabaseCellBackupRuntime(runtime);
    // A passing historical DR archive cannot conceal a stopped/failed live timer.
    // No product RPO SLA is invented: actual age and conditional cadence remain facts.
    if (
      !fresh(runtime.observedAt) ||
      runtime.timerActiveState !== "active" ||
      (runtime.latestAttempt.exitCode !== null &&
        runtime.latestAttempt.exitCode !== 0) ||
      (runtime.latestAttempt.completedAt === null) !==
        (runtime.latestAttempt.exitCode === null) ||
      (runtime.latestAttempt.completedAt !== null &&
        Date.parse(runtime.latestAttempt.completedAt) <
          Date.parse(runtime.latestAttempt.startedAt)) ||
      runtime.serviceActiveState === "failed" ||
      (runtime.nextRunAt === null
        ? !["active", "activating"].includes(runtime.serviceActiveState) ||
          runtime.latestAttempt.completedAt !== null ||
          runtime.latestAttempt.exitCode !== null
        : Date.parse(runtime.nextRunAt) <
          Date.parse(runtime.observedAt) - 5000) ||
      Date.parse(latest.completedAt) < Date.parse(latest.snapshotStartedAt) ||
      Date.parse(latest.completedAt) > Date.parse(runtime.observedAt) + 5000 ||
      Date.parse(latest.completedAt) < Date.parse(backup.completedAt) ||
      Math.abs(latest.snapshotAgeSeconds - assessed.snapshotAgeSeconds) > 5
    )
      refuse(
        "registration current backup timer or latest completed backup is unhealthy or inconsistent"
      );
    const evolution = facts.schemaEvolution;
    if (Boolean(packet.schemaEvolution) !== Boolean(evolution))
      refuse(
        "current schema evolution requires its authenticated separate receipt"
      );
    if (
      evolution &&
      (!fresh(evolution.observedAt) ||
        evolution.receiptSha256 !== packet.schemaEvolution?.receiptSha256 ||
        evolution.nodeId !== custody.nodeId ||
        evolution.environment !== custody.environment ||
        evolution.systemIdentifier !== native.systemIdentifier ||
        evolution.targetAppSha !== custody.targetBuildSha ||
        evolution.toMigrationCount !== evolution.fromMigrationCount + 1 ||
        native.migrationJournal?.rowCount !== evolution.toMigrationCount ||
        native.migrationJournal.sha256 !== evolution.currentJournalSha256 ||
        !fresh(native.migrationJournal.observedAt) ||
        Date.parse(evolution.completedAt) > Date.parse(readmission.admittedAt))
    )
      refuse(
        "current native schema journal differs from canonical post-restore evolution"
      );
    const control = custody.nativeControl?.provenance;
    const qualification = facts.nativeControl;
    if (Boolean(control) !== Boolean(qualification))
      refuse(
        "native control custody requires genuine fresh read-only qualification"
      );
    if (control && qualification) {
      const functions = (
        values: readonly { signature: string; definitionSha256: string }[]
      ) =>
        JSON.stringify(
          values
            .map(({ signature, definitionSha256 }) => ({
              signature,
              definitionSha256,
            }))
            .sort((a, b) => a.signature.localeCompare(b.signature))
        );
      const roles = (values: typeof qualification.exactRoleBounds) =>
        JSON.stringify(
          [...values].sort((a, b) => a.name.localeCompare(b.name))
        );
      if (
        !fresh(qualification.observedAt) ||
        qualification.nodeId !== custody.nodeId ||
        qualification.nodeSlug !== custody.nodeSlug ||
        qualification.environment !== "production" ||
        qualification.controlDatabaseName !== "postgres" ||
        qualification.databaseName !== custody.databaseName ||
        qualification.systemIdentifier !== native.systemIdentifier ||
        control.systemIdentifier !== native.systemIdentifier ||
        qualification.allocationReceiptId !== record.receiptId ||
        qualification.dseq !== record.externalName ||
        qualification.providerAccount !== record.providerAccount ||
        qualification.reviewedSourceSha !== control.reviewedSourceSha ||
        qualification.migrationManifestSha256 !==
          control.migrationManifestSha256 ||
        qualification.installedAt !== control.installedAt ||
        qualification.logicalProbeFunction.definitionSha256 !==
          control.logicalProbeDefinitionSha256 ||
        Date.parse(control.qualifiedAt) >
          Date.parse(qualification.observedAt) ||
        qualification.admission.manualPacketSha256 !== packet.packetSha256 ||
        qualification.admission.readmissionReceiptSha256 !==
          readmission.receiptId ||
        qualification.admission.admittedAt !== readmission.admittedAt ||
        JSON.stringify(qualification.admission.executionActor) !==
          JSON.stringify(packet.executionActor) ||
        JSON.stringify(qualification.admission.approvalAuthority) !==
          JSON.stringify(packet.approvalAuthority) ||
        functions(qualification.requiredFunctions) !==
          functions(control.functions) ||
        roles(qualification.exactRoleBounds) !== roles(custody.budget.roles)
      )
        refuse(
          "native control differs from actual installation, immutable admission or owned capabilities"
        );
    }
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
        old.registration.sourceSystemIdentifier !==
          packet.sourceSystemIdentifier ||
        old.registration.schemaEvolutionReceiptSha256 !==
          packet.schemaEvolution?.receiptSha256 ||
        JSON.stringify(old.registration.executionActor) !==
          JSON.stringify(packet.executionActor) ||
        JSON.stringify(old.registration.approvalAuthority) !==
          JSON.stringify(packet.approvalAuthority) ||
        old.registration.scheduledBackupReceiptSha256 !==
          backup.receiptSha256 ||
        old.registration.independentRecoveryReceiptSha256 !==
          recovery.receiptSha256 ||
        old.registration.appAllocationReceiptId !== app.allocationReceiptId ||
        old.registration.appSdlHash !== app.appliedSdlHash ||
        old.registration.appDsnSha256 !== app.appDsnSha256 ||
        old.registration.serviceDsnSha256 !== app.serviceDsnSha256 ||
        old.registration.migrationDsnSha256 !== app.migrationDsnSha256 ||
        old.registration.tlsCaSha256 !== app.tlsCaSha256 ||
        old.registration.migrationConsumer !== app.migrationConsumer ||
        (old.binding.nativeControl !== undefined &&
          JSON.stringify(old.binding.nativeControl) !==
            JSON.stringify(control)) ||
        old.registration.tlsTrustKind !== app.tlsTrustKind ||
        JSON.stringify(old.registration.runtimePoolLimits) !==
          JSON.stringify(custody.runtimePoolLimits))
    )
      refuse(
        "applied registration cannot replace prior physical identity or audited custody"
      );
    if (old) {
      if (!control || old.binding.nativeControl) return validated(previous);
      // Add genuine installed control to the same admitted identity. No role/login mutation,
      // invented incident, replacement allocation or rewritten original admission history.
      const next = AppliedDatabaseCellReceiptsSchema.parse(
        previous.map((receipt) =>
          receipt === old
            ? {
                ...receipt,
                binding: {
                  ...receipt.binding,
                  nativeControl: control,
                  probeRole: `probe_${custody.databaseName.slice("cogni_".length)}`,
                },
              }
            : receipt
        )
      );
      if (persist) await this.deps.store.save(record, next, previous);
      return validated(next);
    }
    const receipt: AppliedDatabaseCellReceipt = {
      allocationEnvironment: "production",
      targetBuildSha: custody.targetBuildSha,
      registration: {
        kind: "audited-manual",
        executionActor: packet.executionActor,
        approvalAuthority: packet.approvalAuthority,
        readmissionReceiptId: readmission.receiptId,
        manualCutoverPacketSha256: packet.packetSha256,
        sourceSystemIdentifier: packet.sourceSystemIdentifier,
        ...(packet.schemaEvolution
          ? {
              schemaEvolutionReceiptSha256:
                packet.schemaEvolution.receiptSha256,
            }
          : {}),
        scheduledBackupReceiptSha256: backup.receiptSha256,
        independentRecoveryReceiptSha256: recovery.receiptSha256,
        appAllocationReceiptId: app.allocationReceiptId,
        appSdlHash: app.appliedSdlHash,
        appDsnSha256: app.appDsnSha256,
        serviceDsnSha256: app.serviceDsnSha256,
        migrationDsnSha256: app.migrationDsnSha256,
        ...(app.tlsCaSha256 ? { tlsCaSha256: app.tlsCaSha256 } : {}),
        migrationConsumer: app.migrationConsumer,
        tlsTrustKind: app.tlsTrustKind,
        ...(custody.runtimePoolLimits
          ? { runtimePoolLimits: custody.runtimePoolLimits }
          : {}),
        registeredAt: facts.observedAt,
      },
      binding: {
        version: 1,
        phase: "applied",
        receiptId: record.receiptId,
        cogniKey: record.cogniKey,
        nodeId: custody.nodeId,
        nodeSlug: custody.nodeSlug,
        environment: "production",
        provider: "akash",
        dseq: record.externalName,
        providerAccount: record.providerAccount,
        endpoint: {
          host: canonical.hostname,
          port: Number(canonical.port),
          tlsMode: "verify-full",
          tlsCertificateSha256: sha(custody.tlsCertificate),
        },
        databaseName: custody.databaseName,
        appRole: custody.appRole,
        serviceRole: custody.serviceRole,
        ...(custody.migration.kind === "dedicated-migration-url"
          ? {
              migrationRole: decodeURIComponent(
                new URL(custody.migration.dsn).username
              ),
            }
          : {}),
        ...(control
          ? {
              nativeControl: control,
              probeRole: `probe_${custody.databaseName.slice("cogni_".length)}`,
            }
          : {}),
        systemIdentifier: native.systemIdentifier,
        failureDomainId: `akash:${record.providerAccount}:${record.externalName}`,
        manualProvenance: custody.manualProvenance,
        budgetProfile: custody.budgetProfile,
        appliedSdlHash: record.lastAppliedSdlHash,
        readyAt: facts.observedAt,
        cutover: {
          packetSha256: packet.packetSha256,
          actorId: `${packet.executionActor.kind}:${packet.executionActor.id}`,
          approvedAt: packet.approvedAt,
        },
      },
    };
    const next = AppliedDatabaseCellReceiptsSchema.parse([
      ...previous,
      receipt,
    ]);
    if (persist) await this.deps.store.save(record, next, previous);
    return validated(next);
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
