// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type {
  DatabaseCellPhase,
  DatabaseCellStatus,
  DatabaseStateCellPort,
  ProvisionDatabaseCellInput,
} from "@/ports";

interface CherryDatabaseCellConfig {
  readonly authToken: string;
  readonly projectId: string;
  readonly timeoutMs: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
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
}

const PROVIDER = "cherry";

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
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.mapServer(existing, input);

    const storage = await this.request<{ id?: number | string }>(
      `/projects/${this.config.projectId}/storages`,
      {
        method: "POST",
        body: JSON.stringify({
          plan_id: 500,
          description: `cogni-db-${input.environment}-${input.nodeSlug}`,
          size: input.storageGiB,
          region: input.region,
        }),
      }
    );
    if (storage.id === undefined) throw new Error("cherry_storage_missing_id");

    const server = await this.request<CherryServer>(
      `/projects/${this.config.projectId}/servers`,
      {
        method: "POST",
        body: JSON.stringify({
          plan: input.plan,
          image: input.image,
          region: input.region,
          hostname: `cogni-${input.environment}-${input.nodeSlug}-db`,
          ssh_keys: input.sshKeyIds,
          storage_id: Number(storage.id),
          user_data: input.userData,
          cycle: "hourly",
          tags: JSON.stringify({
            "cogni.io/kind": "database-cell",
            "cogni.io/node-id": input.nodeId,
            "cogni.io/node-slug": input.nodeSlug,
            "cogni.io/environment": input.environment,
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
      budgetProfile: requiredTag(tags, "cogni.io/budget-profile"),
      idempotencyKey: requiredTag(tags, "cogni.io/idempotency-key"),
      region: "",
      plan: "",
      image: "",
      storageGiB: Number(tags["cogni.io/storage-gib"] ?? 0),
      sshKeyIds: [],
      userData: "",
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

  private async findByIdempotencyKey(
    key: string
  ): Promise<CherryServer | null> {
    const servers = await this.request<readonly CherryServer[]>(
      `/projects/${this.config.projectId}/servers`
    );
    return (
      servers.find(
        (server) => parseTags(server.tags)["cogni.io/idempotency-key"] === key
      ) ?? null
    );
  }

  private mapServer(
    server: CherryServer,
    input: ProvisionDatabaseCellInput,
    createdStorageId?: string
  ): DatabaseCellStatus {
    if (server.id === undefined) throw new Error("cherry_server_missing_id");
    const tags = parseTags(server.tags);
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
