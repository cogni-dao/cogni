// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type {
  DatabaseDsnPair,
  DatabaseDsnRotationInput,
  DatabaseDsnRotationPort,
  DatabaseDsnRotationResult,
  DatabaseDsnSecretsPlanePort,
  DatabaseDsnSecretsWriteResult,
  DatabaseRuntimeSecretSyncPort,
} from "@/ports";

const DATABASE_DSN_KEYS = ["DATABASE_URL", "DATABASE_SERVICE_URL"] as const;

interface DatabaseConsumerVerifier {
  verify(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseDsnRotationInput["environment"];
    readonly targetCellId: string;
  }): Promise<{ readonly endpointFingerprint: string }>;
}

interface DatabaseDsnRotationAudit {
  append(event: {
    readonly action: "database_dsn_rotated" | "database_dsn_rollback";
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseDsnRotationInput["environment"];
    readonly incidentId: string;
    readonly actorId: string;
    readonly targetCellId: string;
    readonly openBaoVersion: number;
    readonly syncReceiptId: string;
    readonly occurredAt: string;
  }): Promise<void>;
}

export interface DatabaseDsnRotationDeps {
  readonly secrets: DatabaseDsnSecretsPlanePort;
  readonly sync: DatabaseRuntimeSecretSyncPort;
  readonly verifier: DatabaseConsumerVerifier;
  readonly audit: DatabaseDsnRotationAudit;
  readonly now?: () => Date;
}

/** Atomic two-DSN rotation with forced propagation, live verification and rollback. */
export class DatabaseDsnRotationAdapter implements DatabaseDsnRotationPort {
  private readonly now: () => Date;

  constructor(private readonly deps: DatabaseDsnRotationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async rotate(
    input: DatabaseDsnRotationInput
  ): Promise<DatabaseDsnRotationResult> {
    assertDsnPair(input.target, input.nodeSlug, input.targetCellEndpoint);
    const snapshot = await this.readPair(input);
    assertDsnPair(snapshot.pair, input.nodeSlug);
    const targetWrite = await this.casWritePair(
      input,
      input.target,
      snapshot.version,
      "rotation"
    );
    let targetSync: { readonly receiptId: string } | undefined;
    try {
      targetSync = await this.deps.sync.forceAndWait({
        nodeSlug: input.nodeSlug,
        environment: input.environment,
        openBaoVersion: targetWrite.version,
      });
      const verified = await this.deps.verifier.verify({
        nodeSlug: input.nodeSlug,
        environment: input.environment,
        targetCellId: input.targetCellId,
      });
      await this.deps.audit.append({
        action: "database_dsn_rotated",
        nodeId: input.nodeId,
        nodeSlug: input.nodeSlug,
        environment: input.environment,
        incidentId: input.incidentId,
        actorId: input.actorId,
        targetCellId: input.targetCellId,
        openBaoVersion: targetWrite.version,
        syncReceiptId: targetSync.receiptId,
        occurredAt: this.now().toISOString(),
      });
      return {
        openBaoVersion: targetWrite.version,
        syncReceiptId: targetSync.receiptId,
        targetCellId: input.targetCellId,
        endpointFingerprint: verified.endpointFingerprint,
      };
    } catch (cause) {
      let rollbackWrite: DatabaseDsnSecretsWriteResult;
      try {
        rollbackWrite = await this.casWritePair(
          input,
          snapshot.pair,
          targetWrite.version,
          "rollback"
        );
      } catch (rollbackCause) {
        throw new DatabaseDsnRotationError(
          "rollback_conflict",
          new AggregateError(
            [cause, rollbackCause],
            "database DSN rollback lost version ownership"
          )
        );
      }
      const rollbackSync = await this.deps.sync.forceAndWait({
        nodeSlug: input.nodeSlug,
        environment: input.environment,
        openBaoVersion: rollbackWrite.version,
      });
      await this.deps.audit.append({
        action: "database_dsn_rollback",
        nodeId: input.nodeId,
        nodeSlug: input.nodeSlug,
        environment: input.environment,
        incidentId: input.incidentId,
        actorId: input.actorId,
        targetCellId: input.targetCellId,
        openBaoVersion: rollbackWrite.version,
        syncReceiptId: rollbackSync.receiptId,
        occurredAt: this.now().toISOString(),
      });
      throw new DatabaseDsnRotationError("consumer_verification_failed", cause);
    }
  }

  private async readPair(input: DatabaseDsnRotationInput): Promise<{
    readonly version: number;
    readonly pair: DatabaseDsnPair;
  }> {
    const snapshot = await this.deps.secrets.readSecrets({
      nodeSlug: input.nodeSlug,
      env: input.environment,
      keys: DATABASE_DSN_KEYS,
    });
    const app = snapshot.values.DATABASE_URL;
    const service = snapshot.values.DATABASE_SERVICE_URL;
    if (!app || !service) throw new Error("database_dsn_snapshot_incomplete");
    return { version: snapshot.version, pair: { app, service } };
  }

  private async casWritePair(
    input: DatabaseDsnRotationInput,
    pair: DatabaseDsnPair,
    expectedVersion: number,
    phase: "rotation" | "rollback"
  ): Promise<DatabaseDsnSecretsWriteResult> {
    try {
      return await this.deps.secrets.compareAndSwapSecrets({
        nodeSlug: input.nodeSlug,
        env: input.environment,
        expectedVersion,
        values: pairValues(pair),
      });
    } catch (cause) {
      if (hasCode(cause, "openbao_cas_conflict")) {
        throw new DatabaseDsnRotationError(`${phase}_conflict`, cause);
      }

      let observed:
        | Awaited<ReturnType<DatabaseDsnRotationAdapter["readPair"]>>
        | undefined;
      const readFailures: unknown[] = [];
      // A committed KV write may still surface as a transport error. Reconcile
      // through bounded independent reads before declaring its ownership
      // unknown; consumer sync is never triggered until exact version+pair is
      // observed.
      for (let attempt = 0; attempt < 3 && !observed; attempt += 1) {
        try {
          observed = await this.readPair(input);
        } catch (readCause) {
          readFailures.push(readCause);
          await Promise.resolve();
        }
      }
      if (!observed) {
        throw new DatabaseDsnRotationError(
          `${phase}_write_failed`,
          new AggregateError(
            [cause, ...readFailures],
            "database DSN write outcome could not be reconciled"
          )
        );
      }
      if (
        observed.version === expectedVersion + 1 &&
        pairsEqual(observed.pair, pair)
      ) {
        return {
          written: true,
          version: observed.version,
          path: `cogni/${input.environment}/${input.nodeSlug}`,
          keys: [...DATABASE_DSN_KEYS].sort(),
        };
      }
      const code: DatabaseDsnRotationErrorCode =
        phase === "rotation"
          ? observed.version !== expectedVersion
            ? "rotation_conflict"
            : "rotation_write_failed"
          : observed.version !== expectedVersion
            ? "rollback_conflict"
            : "rollback_write_failed";
      throw new DatabaseDsnRotationError(code, cause);
    }
  }
}

function pairValues(pair: DatabaseDsnPair): Readonly<Record<string, string>> {
  return {
    DATABASE_URL: pair.app,
    DATABASE_SERVICE_URL: pair.service,
  };
}

function pairsEqual(left: DatabaseDsnPair, right: DatabaseDsnPair): boolean {
  return left.app === right.app && left.service === right.service;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

type DatabaseDsnRotationErrorCode =
  | "consumer_verification_failed"
  | "rotation_conflict"
  | "rotation_write_failed"
  | "rollback_conflict"
  | "rollback_write_failed";

export class DatabaseDsnRotationError extends Error {
  constructor(
    public readonly code: DatabaseDsnRotationErrorCode,
    options: unknown
  ) {
    super(code, { cause: options });
    this.name = "DatabaseDsnRotationError";
  }
}

function assertDsnPair(
  pair: DatabaseDsnPair,
  nodeSlug: string,
  expectedEndpoint?: string
): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(nodeSlug)) {
    throw new Error("invalid_node_slug");
  }
  const suffix = nodeSlug.replaceAll("-", "_");
  const app = parsePostgresDsn(pair.app);
  const service = parsePostgresDsn(pair.service);
  if (decodeURIComponent(app.username) !== `app_${suffix}`) {
    throw new Error("database_dsn_app_role_mismatch");
  }
  if (decodeURIComponent(service.username) !== `service_${suffix}`) {
    throw new Error("database_dsn_service_role_mismatch");
  }
  const expectedDatabase = `cogni_${suffix}`;
  if (
    decodeURIComponent(app.pathname.slice(1)) !== expectedDatabase ||
    decodeURIComponent(service.pathname.slice(1)) !== expectedDatabase
  ) {
    throw new Error("database_dsn_database_mismatch");
  }
  if (app.hostname !== service.hostname || app.port !== service.port) {
    throw new Error("database_dsn_targets_differ");
  }
  if (
    expectedEndpoint !== undefined &&
    canonicalHostname(app.hostname) !== canonicalHostname(expectedEndpoint)
  ) {
    throw new Error("database_dsn_cell_endpoint_mismatch");
  }
}

function canonicalHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  const unbracketed =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  if (!unbracketed || /[/@]/.test(unbracketed)) {
    throw new Error("database_dsn_cell_endpoint_invalid");
  }
  return unbracketed;
}

function parsePostgresDsn(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("database_dsn_invalid_protocol");
  }
  if (!url.username || !url.hostname || url.pathname.length < 2) {
    throw new Error("database_dsn_incomplete");
  }
  return url;
}
