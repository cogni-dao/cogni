// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type {
  DatabaseDsnPair,
  DatabaseDsnRotationInput,
  DatabaseDsnRotationPort,
  DatabaseDsnRotationResult,
  DatabaseRuntimeSecretSyncPort,
  OperatorSecretsPlanePort,
} from "@/ports";

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
  readonly secrets: OperatorSecretsPlanePort;
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
    assertDsnPair(input.target);
    assertDsnPair(input.rollback);
    const targetWrite = await this.writePair(input, input.target);
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
      const rollbackWrite = await this.writePair(input, input.rollback);
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

  private writePair(input: DatabaseDsnRotationInput, pair: DatabaseDsnPair) {
    return this.deps.secrets.writeSecrets({
      nodeSlug: input.nodeSlug,
      env: input.environment,
      op: "rotate",
      values: {
        DATABASE_URL: pair.app,
        DATABASE_SERVICE_URL: pair.service,
      },
    });
  }
}

export class DatabaseDsnRotationError extends Error {
  constructor(
    public readonly code: "consumer_verification_failed",
    options: unknown
  ) {
    super(code, { cause: options });
    this.name = "DatabaseDsnRotationError";
  }
}

function assertDsnPair(pair: DatabaseDsnPair): void {
  const app = parsePostgresDsn(pair.app);
  const service = parsePostgresDsn(pair.service);
  if (app.username === service.username)
    throw new Error("database_dsn_roles_equal");
  if (app.hostname !== service.hostname || app.pathname !== service.pathname) {
    throw new Error("database_dsn_targets_differ");
  }
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
