// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { Sql } from "postgres";
import type {
  DatabaseCellActionReceipt,
  DatabaseCellPhase,
  DatabaseCellStatus,
  DatabaseStateCellPort,
  ProvisionDatabaseCellInput,
} from "@/ports";

export interface CherryDatabaseCellConfig {
  readonly authToken: string;
  readonly projectId: string;
  readonly timeoutMs: number;
  readonly region: string;
  readonly plan: string;
  readonly image: string;
  readonly storagePlanId: number;
  readonly sshKeyIds: readonly number[];
  /** Provider-boundary renderer; may resolve bootstrap secrets without exposing them to callers. */
  readonly renderUserData: (
    input: ProvisionDatabaseCellInput
  ) => Promise<string>;
  /** Durable, cross-process CAS lease. The implementation must fence stale holders. */
  readonly provisionLease?: CherryDatabaseCellProvisionLease;
  /** Runs database-level verification after a provider action reaches success. */
  readonly databaseVerifier?: CherryDatabaseCellVerifier;
  readonly actionPollIntervalMs?: number;
  readonly actionPollAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface CherryDatabaseCellProvisionLease {
  withLease<T>(key: string, reconcile: () => Promise<T>): Promise<T>;
}

/**
 * Cross-process provision lock backed by a PostgreSQL session advisory lock.
 * The lock has no TTL: it remains owned by the reserved connection for the
 * entire reconcile, and PostgreSQL releases it if the process/connection dies.
 * `hashtextextended` provides one deterministic 64-bit lock key per full
 * provider project + idempotency identity used by provider lookup.
 */
export class PostgresCherryDatabaseCellProvisionLease
  implements CherryDatabaseCellProvisionLease
{
  constructor(private readonly sql: Pick<Sql, "reserve">) {}

  async withLease<T>(key: string, reconcile: () => Promise<T>): Promise<T> {
    const connection = await this.sql.reserve();
    let locked = false;
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    try {
      await connection.unsafe(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [key]
      );
      locked = true;
      outcome = { ok: true, value: await reconcile() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let unlockError: unknown;
    try {
      if (locked) {
        const [row] = await connection.unsafe<{ released: boolean }[]>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [key]
        );
        if (!row?.released) {
          unlockError = new Error(
            "cherry_database_cell_provision_unlock_failed"
          );
        }
      }
    } catch (error) {
      unlockError = error;
    } finally {
      connection.release();
    }
    if (!outcome.ok) {
      if (unlockError) {
        throw new AggregateError(
          [outcome.error, unlockError],
          "cherry_database_cell_provision_and_unlock_failed"
        );
      }
      throw outcome.error;
    }
    if (unlockError) throw unlockError;
    return outcome.value;
  }
}

export interface CherryDatabaseCellVerifier {
  verify(input: {
    readonly cellId: string;
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly endpoint: string;
    readonly action: DatabaseCellActionReceipt["action"];
    readonly backupLabel: string;
    readonly restorePointId: string;
  }): Promise<DatabaseCellActionReceipt["verification"]>;
}

interface CherryServer {
  readonly id?: number | string;
  readonly hostname?: string;
  readonly state?: string;
  readonly status?: string;
  readonly tags?: string | Record<string, string>;
  readonly ip_addresses?: readonly {
    readonly address?: string;
    readonly type?: string;
  }[];
  readonly storage?: readonly {
    readonly id?: number | string;
    readonly size?: number;
  }[];
  readonly backup?: {
    readonly id?: number | string;
  };
}

interface CherryStorage {
  readonly id?: number | string;
  readonly description?: string;
  readonly size?: number;
  readonly region?: string;
}

interface CherryServerAction {
  readonly id?: number | string;
  readonly type?: string;
  readonly action?: string;
  readonly label?: string;
  readonly status?: string;
  readonly state?: string;
  readonly completed_at?: string;
  readonly finished_at?: string;
}

interface CherryRestorePoint {
  readonly id?: number | string;
  readonly label?: string;
  readonly name?: string;
  readonly status?: string;
  readonly state?: string;
}

const PROVIDER = "cherry";
const SUCCESS_STATES = new Set([
  "complete",
  "completed",
  "done",
  "success",
  "succeeded",
]);
const FAILURE_STATES = new Set(["cancelled", "canceled", "error", "failed"]);
const RESTORE_POINT_SUCCESS_STATES = new Set([
  ...SUCCESS_STATES,
  "available",
  "ready",
]);

/** Cherry API lifecycle for dedicated Postgres state cells. */
export class CherryDatabaseCellAdapter implements DatabaseStateCellPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly config: CherryDatabaseCellConfig) {
    this.baseUrl = (
      config.baseUrl ?? "https://api.cherryservers.com/v1"
    ).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  async provision(
    input: ProvisionDatabaseCellInput
  ): Promise<DatabaseCellStatus> {
    const lease = this.config.provisionLease;
    if (!lease)
      throw new Error("cherry_database_cell_provision_lease_required");
    // This must exactly match the provider lookup uniqueness domain. Including
    // node/environment here would let a colliding caller take a different lock
    // while lookup still collides globally on the idempotency key.
    const leaseKey = [
      "cherry-database-cell",
      this.config.projectId,
      input.idempotencyKey,
    ].join(":");
    return lease.withLease(leaseKey, () => this.reconcileProvision(input));
  }

  private async reconcileProvision(
    input: ProvisionDatabaseCellInput
  ): Promise<DatabaseCellStatus> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.mapServer(existing, input);

    const userData = await this.config.renderUserData(input);
    const storage = await this.findOrCreateStorage(input);
    if (storage.id === undefined) throw new Error("cherry_storage_missing_id");

    const server = await this.request<CherryServer>(
      `/projects/${this.config.projectId}/servers`,
      {
        method: "POST",
        body: JSON.stringify({
          plan: this.config.plan,
          image: this.config.image,
          region: this.config.region,
          hostname: `cogni-${input.environment}-${input.nodeSlug}-db`,
          ssh_keys: this.config.sshKeyIds,
          storage_id: Number(storage.id),
          user_data: userData,
          cycle: "hourly",
          tags: JSON.stringify({
            "cogni.io/kind": "database-cell",
            "cogni.io/node-id": input.nodeId,
            "cogni.io/node-slug": input.nodeSlug,
            "cogni.io/environment": input.environment,
            "cogni.io/database-tier": input.databaseTier,
            "cogni.io/budget-profile": input.budgetProfile,
            "cogni.io/idempotency-key": input.idempotencyKey,
            "cogni.io/storage-id": String(storage.id),
            "cogni.io/storage-gib": String(input.storageGiB),
          }),
        }),
      }
    );
    if (server.id === undefined) throw new Error("cherry_server_missing_id");
    return this.mapServer(server, input, String(storage.id));
  }

  async status(input: {
    readonly cellId: string;
  }): Promise<DatabaseCellStatus> {
    const server = await this.request<CherryServer>(`/servers/${input.cellId}`);
    const tags = parseTags(server.tags);
    return this.mapServer(server, {
      nodeId: requiredTag(tags, "cogni.io/node-id"),
      nodeSlug: requiredTag(tags, "cogni.io/node-slug"),
      environment: requiredTag(
        tags,
        "cogni.io/environment"
      ) as ProvisionDatabaseCellInput["environment"],
      databaseTier: requiredTag(
        tags,
        "cogni.io/database-tier"
      ) as ProvisionDatabaseCellInput["databaseTier"],
      budgetProfile: requiredTag(tags, "cogni.io/budget-profile"),
      idempotencyKey: requiredTag(tags, "cogni.io/idempotency-key"),
      storageGiB: Number(tags["cogni.io/storage-gib"] ?? 0),
    });
  }

  async release(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
  }): Promise<void> {
    const current = await this.status({ cellId: input.cellId });
    if (current.nodeId !== input.expectedNodeId) {
      throw new Error("database_cell_identity_mismatch");
    }
    await this.request<void>(
      `/servers/${input.cellId}`,
      { method: "DELETE" },
      [204]
    );
    // The fixed volume is deliberately retained. A separate, audited retention
    // decision deletes it only after the rollback window and restore proof.
  }

  async backup(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
    readonly backupLabel: string;
  }): Promise<DatabaseCellActionReceipt> {
    return this.serverAction("backup", input);
  }

  async restore(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
    readonly backupLabel: string;
  }): Promise<DatabaseCellActionReceipt> {
    return this.serverAction("restore", input);
  }

  private async serverAction(
    action: DatabaseCellActionReceipt["action"],
    input: {
      readonly cellId: string;
      readonly expectedNodeId: string;
      readonly backupLabel: string;
    }
  ): Promise<DatabaseCellActionReceipt> {
    const verifier = this.config.databaseVerifier;
    if (!verifier) {
      throw new Error("cherry_database_cell_verifier_required");
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,126}$/.test(input.backupLabel)) {
      throw new Error("database_cell_backup_label_invalid");
    }
    const server = await this.request<CherryServer>(`/servers/${input.cellId}`);
    const tags = parseTags(server.tags);
    if (requiredTag(tags, "cogni.io/node-id") !== input.expectedNodeId) {
      throw new Error("database_cell_identity_mismatch");
    }
    const endpoint = server.ip_addresses?.find(
      (ip) => ip.type === "primary-ip" || ip.type === undefined
    )?.address;
    if (!endpoint) throw new Error("cherry_database_cell_endpoint_missing");
    const externalBackupId = server.backup?.id;
    if (externalBackupId === undefined) {
      throw new Error("cherry_database_cell_backup_service_missing");
    }

    let restorePoint: CherryRestorePoint | null = null;
    if (action === "restore") {
      restorePoint = await this.requireRestorePoint(
        String(externalBackupId),
        input.backupLabel
      );
    }
    const priorActions = await this.request<readonly CherryServerAction[]>(
      `/servers/${input.cellId}/actions`
    );
    const priorActionIds = new Set(
      priorActions.flatMap((candidate) =>
        candidate.id === undefined ? [] : [String(candidate.id)]
      )
    );
    const acceptedAt = this.now().toISOString();
    await this.request<CherryServer>(`/servers/${input.cellId}/actions`, {
      method: "POST",
      body: JSON.stringify({ type: action, label: input.backupLabel }),
    });
    const completedAction = await this.waitForAction({
      cellId: input.cellId,
      action,
      backupLabel: input.backupLabel,
      priorActionIds,
    });
    const completedRestorePoint = await this.requireRestorePoint(
      String(externalBackupId),
      input.backupLabel
    );
    if (
      restorePoint?.id !== undefined &&
      String(restorePoint.id) !== String(completedRestorePoint.id)
    ) {
      throw new Error("cherry_database_cell_restore_point_changed");
    }
    if (
      completedAction.id === undefined ||
      completedRestorePoint.id === undefined
    ) {
      throw new Error("cherry_database_cell_action_identity_missing");
    }
    const restorePointId = String(completedRestorePoint.id);
    const verification = await verifier.verify({
      cellId: input.cellId,
      nodeId: input.expectedNodeId,
      nodeSlug: requiredTag(tags, "cogni.io/node-slug"),
      endpoint,
      action,
      backupLabel: input.backupLabel,
      restorePointId,
    });
    assertVerification(verification);
    return {
      provider: PROVIDER,
      cellId: input.cellId,
      nodeId: input.expectedNodeId,
      action,
      backupLabel: input.backupLabel,
      acceptedAt,
      providerActionId: String(completedAction.id),
      restorePointId,
      completedAt:
        completedAction.completed_at ??
        completedAction.finished_at ??
        this.now().toISOString(),
      verification,
    };
  }

  private async waitForAction(input: {
    readonly cellId: string;
    readonly action: DatabaseCellActionReceipt["action"];
    readonly backupLabel: string;
    readonly priorActionIds: ReadonlySet<string>;
  }): Promise<CherryServerAction> {
    const attempts = this.config.actionPollAttempts ?? 60;
    const intervalMs = this.config.actionPollIntervalMs ?? 5_000;
    const sleep = this.config.sleep ?? defaultSleep;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const actions = await this.request<readonly CherryServerAction[]>(
        `/servers/${input.cellId}/actions`
      );
      const matches = actions.filter((candidate) => {
        const id = candidate.id;
        return (
          id !== undefined &&
          !input.priorActionIds.has(String(id)) &&
          (candidate.type ?? candidate.action) === input.action &&
          candidate.label === input.backupLabel
        );
      });
      if (matches.length > 1) {
        throw new Error("cherry_database_cell_action_not_unique");
      }
      const match = matches[0];
      if (match) {
        const state = normalizeProviderState(match.status ?? match.state);
        if (SUCCESS_STATES.has(state)) return match;
        if (FAILURE_STATES.has(state)) {
          throw new Error(`cherry_database_cell_${input.action}_failed`);
        }
      }
      if (attempt + 1 < attempts) await sleep(intervalMs);
    }
    throw new Error(`cherry_database_cell_${input.action}_timeout`);
  }

  private async requireRestorePoint(
    externalBackupId: string,
    backupLabel: string
  ): Promise<CherryRestorePoint> {
    const points = await this.request<readonly CherryRestorePoint[]>(
      `/backups/${externalBackupId}/restore-points`
    );
    const matches = points.filter(
      (point) =>
        (point.label ?? point.name) === backupLabel &&
        RESTORE_POINT_SUCCESS_STATES.has(
          normalizeProviderState(point.status ?? point.state)
        )
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? "cherry_database_cell_restore_point_missing"
          : "cherry_database_cell_restore_point_not_unique"
      );
    }
    if (matches[0]?.id === undefined) {
      throw new Error("cherry_database_cell_restore_point_identity_missing");
    }
    return matches[0];
  }

  private async findByIdempotencyKey(
    key: string
  ): Promise<CherryServer | null> {
    const servers = await this.request<readonly CherryServer[]>(
      `/projects/${this.config.projectId}/servers`
    );
    const matches = servers.filter(
      (server) => parseTags(server.tags)["cogni.io/idempotency-key"] === key
    );
    if (matches.length > 1) {
      throw new Error("cherry_database_cell_identity_not_unique");
    }
    return matches[0] ?? null;
  }

  private async findOrCreateStorage(
    input: ProvisionDatabaseCellInput
  ): Promise<CherryStorage> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.idempotencyKey)) {
      throw new Error("database_cell_idempotency_key_invalid");
    }
    const description = `cogni-db-cell-${input.idempotencyKey}`;
    const storages = await this.request<readonly CherryStorage[]>(
      `/projects/${this.config.projectId}/storages`
    );
    const matches = storages.filter(
      (storage) => storage.description === description
    );
    if (matches.length > 1) {
      throw new Error("cherry_database_cell_storage_not_unique");
    }
    const existing = matches[0];
    if (existing) {
      if (existing.size !== undefined && existing.size !== input.storageGiB) {
        throw new Error("cherry_database_cell_storage_size_mismatch");
      }
      if (
        existing.region !== undefined &&
        existing.region !== this.config.region
      ) {
        throw new Error("cherry_database_cell_storage_region_mismatch");
      }
      return existing;
    }
    return this.request<CherryStorage>(
      `/projects/${this.config.projectId}/storages`,
      {
        method: "POST",
        body: JSON.stringify({
          plan_id: this.config.storagePlanId,
          description,
          size: input.storageGiB,
          region: this.config.region,
        }),
      }
    );
  }

  private mapServer(
    server: CherryServer,
    input: ProvisionDatabaseCellInput,
    createdStorageId?: string
  ): DatabaseCellStatus {
    if (server.id === undefined) throw new Error("cherry_server_missing_id");
    const tags = parseTags(server.tags);
    // Provider state is the durable reservation. Never relabel a cell from the
    // caller: an idempotency-key collision or retry with changed intent fails
    // closed before returning/releasing another node's paid state.
    if (!createdStorageId) {
      const expected = {
        "cogni.io/node-id": input.nodeId,
        "cogni.io/node-slug": input.nodeSlug,
        "cogni.io/environment": input.environment,
        "cogni.io/database-tier": input.databaseTier,
        "cogni.io/budget-profile": input.budgetProfile,
        "cogni.io/idempotency-key": input.idempotencyKey,
        "cogni.io/storage-gib": String(input.storageGiB),
      } as const;
      for (const [name, value] of Object.entries(expected)) {
        if (tags[name] !== value) {
          throw new Error(`database_cell_identity_mismatch:${name}`);
        }
      }
    }
    const address = server.ip_addresses?.find(
      (ip) => ip.type === "primary-ip" || ip.type === undefined
    )?.address;
    const phase = mapPhase(server.state ?? server.status);
    const volumeId =
      createdStorageId ??
      tags["cogni.io/storage-id"] ??
      (server.storage?.[0]?.id === undefined
        ? undefined
        : String(server.storage[0].id));
    const sizeGiB = Number(
      tags["cogni.io/storage-gib"] ??
        server.storage?.[0]?.size ??
        input.storageGiB
    );
    return {
      provider: PROVIDER,
      cellId: String(server.id),
      nodeId: input.nodeId,
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      phase,
      endpoint: address ?? null,
      storage: volumeId ? { volumeId, sizeGiB } : null,
      observedAt: this.now().toISOString(),
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    accepted: readonly number[] = [200, 201, 202]
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.authToken}`,
          Accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!accepted.includes(response.status)) {
        throw new Error(`cherry_database_cell_http_${response.status}`);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseTags(value: CherryServer["tags"]): Record<string, string> {
  if (!value) return {};
  if (typeof value === "object") return { ...value };
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function requiredTag(tags: Record<string, string>, name: string): string {
  const value = tags[name];
  if (!value) throw new Error(`database_cell_missing_tag:${name}`);
  return value;
}

function mapPhase(value: string | undefined): DatabaseCellPhase {
  switch (value?.toLowerCase()) {
    case "active":
    case "ready":
    case "deployed":
      return "ready";
    case "pending":
    case "deploying":
    case "provisioning":
      return "provisioning";
    case "terminated":
    case "released":
    case "deleted":
      return "released";
    case "failed":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function normalizeProviderState(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function assertVerification(
  verification: DatabaseCellActionReceipt["verification"]
): void {
  if (
    !verification.schemaFingerprint ||
    !verification.checksum ||
    !Number.isSafeInteger(verification.rowCount) ||
    verification.rowCount < 0
  ) {
    throw new Error("cherry_database_cell_verification_invalid");
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
