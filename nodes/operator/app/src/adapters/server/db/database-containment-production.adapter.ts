// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RELIABILITY_POLICY_V1, reliabilityStatusV1Schema } from "@cogni/node-contracts";
import type { Logger } from "pino";
import postgres, { type Sql } from "postgres";
import { parse as parseYaml } from "yaml";
import type {
  DatabaseCellActionReceipt,
  DatabaseCellCapacity,
  DatabaseCellStatus,
  DatabaseContainmentAction,
  DatabaseContainmentPort,
  DatabaseContainmentStatus,
  DatabaseContainmentStatusPort,
  DatabaseDsnPair,
  DatabaseDsnRotationInput,
  DatabaseDsnRotationPort,
  DatabaseDsnRotationResult,
  DatabaseDsnSecretsPlanePort,
  DatabaseDsnSecretsWriteResult,
  DatabaseEnvironment,
  DatabaseReadmissionPort,
  DatabaseRuntimeSecretSyncPort,
  DatabaseStateCellPort,
  DatabaseTier,
  LokiReaderPort,
  ProvisionDatabaseCellInput,
  ReliabilityReadmitPort,
  ReliabilityStatusReaderPort,
} from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";
import {
  CherryDatabaseCellAdapter,
  type CherryDatabaseCellConfig,
  type CherryDatabaseCellVerifier,
  PostgresCherryDatabaseCellProvisionLease,
} from "../compute/cherry-database-cell.adapter";

const execFileAsync = promisify(execFile);

export interface DatabaseControlSql {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<readonly T[]>;
}

export interface DatabaseSourceFence {
  isFenced(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
  }): Promise<boolean>;
  setFenced(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly fenced: boolean;
  }): Promise<void>;
}

export interface DatabaseSourceFenceStatus {
  isFenced(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
  }): Promise<boolean>;
}

export interface DatabaseContainmentAuditEvent {
  readonly action:
    | "containment_requested"
    | "contained"
    | "containment_failed"
    | "readmission_requested"
    | "readmitted"
    | "readmission_failed";
  readonly incidentId: string;
  readonly actorId: string;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly reason: DatabaseContainmentAction["reason"];
  readonly occurredAt: string;
  readonly errorCode?: string;
}

export interface DatabaseContainmentAuditWriter {
  append(event: DatabaseContainmentAuditEvent): Promise<void>;
}

export interface PostgresDatabaseContainmentDeps {
  readonly sql: DatabaseControlSql;
  /** Optional read-only visibility into the manual secondary firewall control. */
  readonly fenceStatus?: DatabaseSourceFenceStatus;
  readonly audit: DatabaseContainmentAuditWriter & {
    latest(input: {
      readonly nodeId: string;
      readonly environment: DatabaseEnvironment;
    }): Promise<DatabaseContainmentAuditEvent | null>;
  };
  readonly cells?: DatabaseStateCellPort;
  readonly now?: () => Date;
}

export class DatabaseContainmentConfigurationError extends Error {
  readonly code = "DATABASE_CONTAINMENT_CONFIGURATION_INVALID";

  constructor(readonly missingCapabilities: readonly string[]) {
    super(
      `database containment requires privileged capabilities: ${missingCapabilities.join(", ")}`
    );
    this.name = "DatabaseContainmentConfigurationError";
  }
}

/**
 * Production construction boundary. The public app must not synthesize these
 * capabilities: its composition root may wire this only when an admin SQL
 * executor, durable audit sink, and real source-firewall actuator are present.
 */
export function createPostgresDatabaseContainmentAdapter(
  deps: PostgresDatabaseContainmentDeps
): DatabaseContainmentPort {
  const missing: string[] = [];
  if (typeof deps.sql?.query !== "function") missing.push("admin_sql_executor");
  if (
    typeof deps.audit?.append !== "function" ||
    typeof deps.audit?.latest !== "function"
  ) {
    missing.push("durable_audit_sink");
  }
  if (missing.length > 0) {
    throw new DatabaseContainmentConfigurationError(missing);
  }
  return new PostgresDatabaseContainmentAdapter(deps);
}

export interface PostgresDatabaseReadmissionDeps {
  readonly readmitSql: DatabaseControlSql;
  /** Status-only client/port; must not carry the autonomous contain credential. */
  readonly status: DatabaseContainmentStatusPort;
  readonly audit: DatabaseContainmentAuditWriter;
  readonly now?: () => Date;
}

export function createPostgresDatabaseReadmissionAdapter(
  deps: PostgresDatabaseReadmissionDeps
): DatabaseReadmissionPort {
  const missing: string[] = [];
  if (typeof deps.readmitSql?.query !== "function") {
    missing.push("readmit_sql_executor");
  }
  if (typeof deps.status?.status !== "function") {
    missing.push("containment_status_client");
  }
  if (typeof deps.audit?.append !== "function") {
    missing.push("durable_audit_sink");
  }
  if (missing.length > 0) {
    throw new DatabaseContainmentConfigurationError(missing);
  }
  return new PostgresDatabaseReadmissionAdapter(deps);
}

/**
 * Audited v1 containment action: revoke node logins, terminate its sessions,
 * and apply its source-specific network fence. No global database restart.
 */
export class PostgresDatabaseContainmentAdapter
  implements DatabaseContainmentPort
{
  private readonly now: () => Date;

  constructor(private readonly deps: PostgresDatabaseContainmentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async contain(
    input: DatabaseContainmentAction
  ): Promise<DatabaseContainmentStatus> {
    await this.audit("containment_requested", input);
    try {
      const roles = rolesFor(input.nodeSlug);
      for (const role of roles) {
        await this.deps.sql.query(
          "SELECT public.contain_database_role($1::text)",
          [role]
        );
      }
      // v1 automation intentionally stops at the proven per-node role boundary.
      // The host firewall remains a separately audited, manual secondary control.
      const verified = await this.status(input);
      if (verified.phase !== "contained") {
        throw new Error("database_containment_not_confirmed");
      }
      const occurredAt = this.now().toISOString();
      await this.audit("contained", input, undefined, occurredAt);
      return {
        ...verified,
        lastTransitionAt: occurredAt,
        incidentId: input.incidentId,
        reason: input.reason,
      };
    } catch (error) {
      await this.audit("containment_failed", input, errorCode(error));
      throw error;
    }
  }

  async status(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly desiredTier: DatabaseTier;
    readonly budgetProfile: string;
    readonly cellId?: string;
  }): Promise<DatabaseContainmentStatus> {
    const roles = rolesFor(input.nodeSlug);
    const [roleRows, sessionRows, firewallFenced, cell, latest] =
      await Promise.all([
        this.deps.sql.query<{ rolname: string; rolcanlogin: boolean }>(
          "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])",
          [roles]
        ),
        this.deps.sql.query<{ count: string | number }>(
          "SELECT count(*) AS count FROM pg_stat_activity WHERE usename = ANY($1::text[])",
          [roles]
        ),
        this.deps.fenceStatus
          ? this.deps.fenceStatus.isFenced({
              nodeSlug: input.nodeSlug,
              environment: input.environment,
            })
          : Promise.resolve(null),
        input.cellId && this.deps.cells
          ? this.deps.cells.status({ cellId: input.cellId })
          : Promise.resolve(null),
        this.deps.audit.latest({
          nodeId: input.nodeId,
          environment: input.environment,
        }),
      ]);
    const activeSessions = Number(sessionRows[0]?.count ?? 0);
    // Missing roles fail closed: absence is not evidence that access is enabled.
    const rolesPresent = roleRows.length === roles.length;
    const rolesCanLogin =
      rolesPresent && roleRows.every((role) => role.rolcanlogin);
    const rolesNoLogin =
      rolesPresent && roleRows.every((role) => !role.rolcanlogin);
    const contained = rolesNoLogin && activeSessions === 0;
    const phase = contained
      ? "contained"
      : !rolesPresent || !rolesCanLogin || activeSessions > 0
        ? "recovering"
        : "open";
    return {
      nodeId: input.nodeId,
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      desiredTier: input.desiredTier,
      budgetProfile: input.budgetProfile,
      contained,
      phase,
      activeSessions,
      rolesPresent,
      rolesCanLogin,
      firewallFenced,
      cell,
      observedAt: this.now().toISOString(),
      lastTransitionAt: latest?.occurredAt ?? null,
      incidentId: latest?.incidentId ?? null,
      reason: latest?.reason ?? null,
    };
  }

  private async audit(
    action: DatabaseContainmentAuditEvent["action"],
    input: DatabaseContainmentAction,
    error?: string,
    occurredAt = this.now().toISOString()
  ): Promise<void> {
    await this.deps.audit.append({
      action,
      incidentId: input.incidentId,
      actorId: input.actorId,
      nodeId: input.nodeId,
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      reason: input.reason,
      occurredAt,
      ...(error ? { errorCode: error } : {}),
    });
  }
}

export class PostgresDatabaseReadmissionAdapter
  implements DatabaseReadmissionPort
{
  private readonly now: () => Date;

  constructor(private readonly deps: PostgresDatabaseReadmissionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async readmit(
    input: DatabaseContainmentAction
  ): Promise<DatabaseContainmentStatus> {
    if (input.actorId.startsWith("system:")) {
      throw new Error("database_readmission_requires_human_actor");
    }
    await this.audit("readmission_requested", input);
    try {
      const roles = rolesFor(input.nodeSlug);
      for (const role of roles) {
        await this.deps.readmitSql.query(
          "SELECT public.readmit_database_role($1::text)",
          [role]
        );
      }
      const verified = await this.deps.status.status(input);
      if (verified.phase !== "open") {
        throw new Error("database_readmission_not_confirmed");
      }
      const occurredAt = this.now().toISOString();
      await this.audit("readmitted", input, undefined, occurredAt);
      return {
        ...verified,
        lastTransitionAt: occurredAt,
        incidentId: input.incidentId,
        reason: input.reason,
      };
    } catch (error) {
      await this.audit("readmission_failed", input, errorCode(error));
      throw error;
    }
  }

  private async audit(
    action: DatabaseContainmentAuditEvent["action"],
    input: DatabaseContainmentAction,
    error?: string,
    occurredAt = this.now().toISOString()
  ): Promise<void> {
    await this.deps.audit.append({
      action,
      incidentId: input.incidentId,
      actorId: input.actorId,
      nodeId: input.nodeId,
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      reason: input.reason,
      occurredAt,
      ...(error ? { errorCode: error } : {}),
    });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:-]{1,80}$/i.test(error.message)) {
    return error.message;
  }
  return "database_containment_operation_failed";
}

function rolesFor(nodeSlug: string): readonly string[] {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(nodeSlug)) {
    throw new Error("invalid_node_slug");
  }
  const suffix = nodeSlug.replaceAll("-", "_");
  // The as-built per-node roles are app + service. `app_readonly` remains an
  // environment-shared v0 support role, so revoking it would contain every node.
  return [`app_${suffix}`, `service_${suffix}`];
}

export class HttpReliabilityStatusAdapter
  implements ReliabilityStatusReaderPort
{
  constructor(
    private readonly config: {
      readonly baseUrl: string;
      readonly bearerToken: string;
      readonly timeoutMs?: number;
    }
  ) {}

  async read(
    input: Parameters<ReliabilityStatusReaderPort["read"]>[0]
  ): Promise<Awaited<ReturnType<ReliabilityStatusReaderPort["read"]>>> {
    const url = new URL("/v1/status", this.config.baseUrl);
    url.searchParams.set("node_id", input.nodeId);
    url.searchParams.set("node_slug", input.nodeSlug);
    url.searchParams.set("environment", input.environment);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.config.bearerToken}` },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      throw new Error(`reliability actuator status failed: ${response.status}`);
    }
    const status = reliabilityStatusV1Schema.parse(await response.json());
    if (
      status.nodeId !== input.nodeId ||
      status.slug !== input.nodeSlug ||
      status.environment !== input.environment
    ) {
      throw new Error("reliability actuator returned a cross-node status");
    }
    const ageMs = Date.now() - Date.parse(status.observedAt);
    if (ageMs < -15_000 || ageMs > RELIABILITY_POLICY_V1.evidenceTtlMs) {
      throw new Error("reliability actuator returned stale status");
    }
    return status;
  }
}

export class HttpReliabilityReadmitAdapter implements ReliabilityReadmitPort {
  constructor(
    private readonly config: {
      readonly baseUrl: string;
      readonly bearerToken: string;
      readonly timeoutMs?: number;
    }
  ) {}

  async readmit(
    input: Parameters<ReliabilityReadmitPort["readmit"]>[0]
  ): Promise<Awaited<ReturnType<ReliabilityReadmitPort["readmit"]>>> {
    const url = new URL("/v1/readmit", this.config.baseUrl);
    url.searchParams.set("node_id", input.nodeId);
    url.searchParams.set("node_slug", input.nodeSlug);
    url.searchParams.set("environment", input.environment);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.bearerToken}`,
        "x-cogni-actor-id": `human:${input.actorId}`,
        "x-cogni-incident-id": input.incidentId,
      },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      throw new Error(
        `reliability actuator readmit failed: ${response.status}`
      );
    }
    const body = (await response.json()) as {
      phase?: unknown;
      incidentId?: unknown;
      lastTransitionAt?: unknown;
    };
    if (body.phase !== "open") {
      throw new Error("reliability actuator readmit did not open database");
    }
    return {
      phase: body.phase,
      incidentId: typeof body.incidentId === "string" ? body.incidentId : null,
      lastTransitionAt:
        typeof body.lastTransitionAt === "string"
          ? body.lastTransitionAt
          : null,
    };
  }
}

export interface ProductionDatabaseContainmentConfig {
  readonly adminDsn: string;
  readonly log: Logger;
  readonly loki: LokiReaderPort;
  readonly lokiEnvironment: string;
  /** Optional read-only observer for the manual secondary firewall control. */
  readonly firewallStatus?: DatabaseSourceFenceStatus;
  readonly cells?: PostgresDatabaseContainmentDeps["cells"];
}

export interface ProductionCherryDatabaseCellConfig
  extends Omit<
    CherryDatabaseCellConfig,
    "provisionLease" | "databaseVerifier"
  > {
  /** Dedicated session used only for the cross-process provision advisory lock. */
  readonly lockDsn: string;
  /** Endpoint-neutral read-only identity; endpoint comes from Cherry after provision. */
  readonly verificationCredential: PostgresDatabaseCellVerificationCredential;
}

/** Production lifecycle composition: real Cherry I/O + session-scoped DB lock. */
export function createProductionCherryDatabaseCellAdapter(
  config: ProductionCherryDatabaseCellConfig
) {
  if (!config.lockDsn || !config.authToken || !config.verificationCredential) {
    throw new Error("database_cell_production_config_invalid");
  }
  const lockUrl = new URL(config.lockDsn);
  if (!["postgres:", "postgresql:"].includes(lockUrl.protocol)) {
    throw new Error("database_cell_lock_dsn_invalid");
  }
  if (
    decodeURIComponent(lockUrl.username) !== "database_reliability_actuator"
  ) {
    throw new Error("database_cell_lock_dsn_not_least_privilege");
  }
  const { lockDsn, verificationCredential, ...cellConfig } = config;
  const lockSql = postgres(lockDsn, { max: 1, prepare: false });
  return new CherryDatabaseCellAdapter({
    ...cellConfig,
    provisionLease: new PostgresCherryDatabaseCellProvisionLease(lockSql),
    databaseVerifier: new PostgresDatabaseCellVerifier(verificationCredential),
  });
}

export interface PostgresDatabaseCellVerificationCredential {
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly port?: number;
  readonly ssl?: boolean;
}

type PostgresDatabaseCellConnector = (input: {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: boolean;
}) => Sql;

/**
 * Target-cell verifier used by the production lifecycle composition. It binds
 * the credential to the provider-observed endpoint and exact node role/database,
 * then emits deterministic schema, row-count, and content proofs.
 */
export class PostgresDatabaseCellVerifier
  implements CherryDatabaseCellVerifier
{
  constructor(
    private readonly credential: PostgresDatabaseCellVerificationCredential,
    private readonly connect: PostgresDatabaseCellConnector = (input) =>
      postgres({ ...input, max: 1, prepare: false })
  ) {
    if (
      !credential.username ||
      !credential.password ||
      !credential.database ||
      !Number.isSafeInteger(credential.port ?? 5432)
    ) {
      throw new Error("database_cell_verification_credential_invalid");
    }
  }

  async verify(
    input: Parameters<CherryDatabaseCellVerifier["verify"]>[0]
  ): Promise<DatabaseCellActionReceipt["verification"]> {
    return this.verifyEndpoint(input);
  }

  async verifyLiveness(
    input: Parameters<CherryDatabaseCellVerifier["verifyLiveness"]>[0]
  ): Promise<DatabaseCellActionReceipt["verification"]> {
    return this.verifyEndpoint(input);
  }

  private async verifyEndpoint(input: {
    readonly nodeSlug: string;
    readonly endpoint: string;
  }): Promise<DatabaseCellActionReceipt["verification"]> {
    const suffix = input.nodeSlug.replaceAll("-", "_");
    if (
      this.credential.username !== `app_${suffix}` ||
      this.credential.database !== `cogni_${suffix}`
    ) {
      throw new Error("database_cell_verification_identity_mismatch");
    }
    const client = this.connect({
      host: normalizeHost(input.endpoint),
      port: this.credential.port ?? 5432,
      username: this.credential.username,
      password: this.credential.password,
      database: this.credential.database,
      ssl: this.credential.ssl ?? true,
    });
    try {
      return await verifyDatabaseContents(client);
    } finally {
      await client.end({ timeout: 5 });
    }
  }
}

async function verifyDatabaseContents(
  client: Sql
): Promise<DatabaseCellActionReceipt["verification"]> {
  const columns = await client.unsafe<
    Array<{
      table_name: string;
      column_name: string;
      ordinal_position: number;
      data_type: string;
      is_nullable: string;
    }>
  >(
    `SELECT table_name, column_name, ordinal_position, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`
  );
  const tables = [...new Set(columns.map((column) => column.table_name))];
  const tableProofs: Array<{
    table: string;
    count: string;
    hashSum: string;
    hashMin: string;
    hashMax: string;
  }> = [];
  let rowCount = 0;
  for (const table of tables) {
    const identifier = quoteIdentifier(table);
    const [proof] = await client.unsafe<
      Array<{
        count: string;
        hash_sum: string;
        hash_min: string;
        hash_max: string;
      }>
    >(
      `SELECT count(*)::text AS count,
                coalesce(sum(hashtextextended(row_to_json(row_value)::text, 0)::numeric), 0)::text AS hash_sum,
                coalesce(min(hashtextextended(row_to_json(row_value)::text, 0)), 0)::text AS hash_min,
                coalesce(max(hashtextextended(row_to_json(row_value)::text, 0)), 0)::text AS hash_max
           FROM (SELECT * FROM "public".${identifier}) AS row_value`
    );
    if (!proof) throw new Error("database_cell_verification_query_empty");
    const count = Number(proof.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("database_cell_verification_row_count_invalid");
    }
    rowCount += count;
    if (!Number.isSafeInteger(rowCount)) {
      throw new Error("database_cell_verification_row_count_overflow");
    }
    tableProofs.push({
      table,
      count: proof.count,
      hashSum: proof.hash_sum,
      hashMin: proof.hash_min,
      hashMax: proof.hash_max,
    });
  }
  return {
    schemaFingerprint: sha256(JSON.stringify(columns)),
    rowCount,
    checksum: sha256(JSON.stringify(tableProofs)),
  };
}

export type DatabaseCellLifecycleCommand =
  | { readonly action: "provision"; readonly input: ProvisionDatabaseCellInput }
  | { readonly action: "status"; readonly input: { readonly cellId: string } }
  | {
      readonly action: "backup" | "restore";
      readonly input: {
        readonly cellId: string;
        readonly expectedNodeId: string;
        readonly actorId: string;
        readonly backupLabel: string;
      };
    }
  | {
      readonly action: "release";
      readonly input: {
        readonly cellId: string;
        readonly expectedNodeId: string;
      };
    };

export type DatabaseCellLifecycleResult =
  | DatabaseCellStatus
  | DatabaseCellActionReceipt
  | { readonly released: true; readonly cellId: string };

export interface DatabaseCellLifecycleReceiptSink {
  append(input: {
    readonly event: "database_cell_lifecycle_receipt";
    readonly command: DatabaseCellLifecycleCommand["action"];
    readonly result: DatabaseCellLifecycleResult;
  }): Promise<void>;
}

/** Narrow production caller; orchestration supplies auth and persists each receipt. */
export async function executeDatabaseCellLifecycleCommand(
  cells: DatabaseStateCellPort,
  sink: DatabaseCellLifecycleReceiptSink,
  command: DatabaseCellLifecycleCommand
): Promise<DatabaseCellLifecycleResult> {
  let result: DatabaseCellLifecycleResult;
  switch (command.action) {
    case "provision":
      result = await cells.provision(command.input);
      break;
    case "status":
      result = await cells.status(command.input);
      break;
    case "backup":
      result = await cells.backup(command.input);
      break;
    case "restore":
      result = await cells.restore(command.input);
      break;
    case "release":
      await cells.release(command.input);
      result = { released: true, cellId: command.input.cellId };
      break;
  }
  await sink.append({
    event: "database_cell_lifecycle_receipt",
    command: command.action,
    result,
  });
  return result;
}

function normalizeHost(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Candidate ops entrypoint (one command per invocation):
 * `DATABASE_CELL_LIFECYCLE_CLI=1 pnpm --dir nodes/operator/app exec tsx src/adapters/server/db/database-containment-production.adapter.ts`
 * Provider/DB credentials are injected only through the process environment;
 * the command file is non-secret and the receipt is create-only for replay.
 */
export async function runDatabaseCellLifecycleCli(
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const commandFile = requireEnvironment(
    environment,
    "DATABASE_CELL_COMMAND_FILE"
  );
  const receiptFile = requireEnvironment(
    environment,
    "DATABASE_CELL_RECEIPT_FILE"
  );
  const userDataFile = requireEnvironment(
    environment,
    "DATABASE_CELL_USER_DATA_FILE"
  );
  const command = parseLifecycleCommand(
    JSON.parse(await readFile(commandFile, "utf8"))
  );
  const appSourceDir = requireEnvironment(environment, "APP_SOURCE_DIR");
  const reviewedBuildSha = requireEnvironment(environment, "APP_BUILD_SHA");
  const budgetProfilesYaml = await readImmutableAppSourceFile(
    appSourceDir,
    reviewedBuildSha,
    "infra/database-budget-profiles.yaml"
  );
  if (command.action === "provision") {
    await assertCatalogCellPlacement(
      appSourceDir,
      reviewedBuildSha,
      command.input
    );
  }
  const adapter = createProductionCherryDatabaseCellAdapter({
    authToken: requireEnvironment(environment, "CHERRY_AUTH_TOKEN"),
    projectId: requireEnvironment(environment, "CHERRY_PROJECT_ID"),
    timeoutMs: positiveInteger(environment.CHERRY_TIMEOUT_MS ?? "30000"),
    region: requireEnvironment(environment, "CHERRY_DATABASE_REGION"),
    image: requireEnvironment(environment, "CHERRY_DATABASE_IMAGE"),
    reviewedBuildSha,
    budgetProfiles: loadDatabaseCellBudgetProfiles(budgetProfilesYaml),
    storagePlanIds: {
      shared: positiveInteger(
        requireEnvironment(environment, "CHERRY_DATABASE_STORAGE_PLAN_ID")
      ),
      dedicated: positiveInteger(
        requireEnvironment(environment, "CHERRY_DATABASE_STORAGE_PLAN_ID")
      ),
    },
    billingCurrency: parseBillingCurrency(
      environment.CHERRY_BILLING_CURRENCY ?? "USD"
    ),
    sshKeyIds: requireEnvironment(environment, "CHERRY_DATABASE_SSH_KEY_IDS")
      .split(",")
      .map(positiveInteger),
    lockDsn: requireEnvironment(environment, "DATABASE_RELIABILITY_ADMIN_URL"),
    verificationCredential: {
      username: requireEnvironment(
        environment,
        "DATABASE_CELL_VERIFICATION_USERNAME"
      ),
      password: requireEnvironment(
        environment,
        "DATABASE_CELL_VERIFICATION_PASSWORD"
      ),
      database: requireEnvironment(
        environment,
        "DATABASE_CELL_VERIFICATION_DATABASE"
      ),
      port: positiveInteger(
        environment.DATABASE_CELL_VERIFICATION_PORT ?? "5432"
      ),
      ssl: environment.DATABASE_CELL_VERIFICATION_SSL !== "false",
    },
    renderUserData: async () => readFile(userDataFile, "utf8"),
  });
  await executeDatabaseCellLifecycleCommand(
    adapter,
    {
      append: async ({ result }) => {
        await writeFile(receiptFile, `${JSON.stringify(result)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      },
    },
    command
  );
  process.stdout.write(`${receiptFile}\n`);
}

async function assertCatalogCellPlacement(
  appSourceDir: string,
  reviewedBuildSha: string,
  input: ProvisionDatabaseCellInput
): Promise<void> {
  const parsed = parseYaml(
    await readImmutableAppSourceFile(
      appSourceDir,
      reviewedBuildSha,
      `infra/catalog/${input.nodeSlug}.yaml`
    )
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("database_cell_catalog_invalid");
  }
  const catalog = parsed as Record<string, unknown>;
  const database = catalog.database as Record<string, unknown> | undefined;
  const placement = database?.[input.environment] as
    | Record<string, unknown>
    | undefined;
  if (
    catalog.node_id !== input.nodeId ||
    !Array.isArray(catalog.envs) ||
    !catalog.envs.includes(input.environment) ||
    placement?.tier !== input.databaseTier ||
    placement?.budget_profile !== input.budgetProfile
  ) {
    throw new Error("database_cell_catalog_placement_mismatch");
  }
}

function parseLifecycleCommand(value: unknown): DatabaseCellLifecycleCommand {
  if (typeof value !== "object" || value === null) {
    throw new Error("database_cell_command_invalid");
  }
  const candidate = value as Partial<DatabaseCellLifecycleCommand>;
  if (
    !["provision", "status", "backup", "restore", "release"].includes(
      String(candidate.action)
    ) ||
    typeof candidate.input !== "object" ||
    candidate.input === null
  ) {
    throw new Error("database_cell_command_invalid");
  }
  return candidate as DatabaseCellLifecycleCommand;
}

function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];
  if (!value) throw new Error(`database_cell_ops_missing_${name}`);
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("database_cell_ops_positive_integer_required");
  }
  return parsed;
}

function loadDatabaseCellBudgetProfiles(
  yaml: string
): Readonly<Record<string, DatabaseCellCapacity>> {
  const parsed = parseYaml(yaml) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("database_cell_budget_profiles_invalid");
  }
  const profiles: Record<string, DatabaseCellCapacity> = {};
  for (const [name, rawProfile] of Object.entries(parsed)) {
    if (typeof rawProfile !== "object" || rawProfile === null) continue;
    const capacity = (rawProfile as Record<string, unknown>).cell_capacity;
    if (typeof capacity !== "object" || capacity === null) continue;
    const value = capacity as Record<string, unknown>;
    const computeClass = value.compute_class;
    if (
      (computeClass !== "shared" && computeClass !== "dedicated") ||
      !Number.isSafeInteger(value.vcpus) ||
      !Number.isSafeInteger(value.memory_gib) ||
      !Number.isSafeInteger(value.storage_gib) ||
      Number(value.vcpus) <= 0 ||
      Number(value.memory_gib) <= 0 ||
      Number(value.storage_gib) <= 0
    ) {
      throw new Error(`database_cell_budget_profile_invalid:${name}`);
    }
    profiles[name] = {
      vcpus: Number(value.vcpus),
      memoryGiB: Number(value.memory_gib),
      storageGiB: Number(value.storage_gib),
      computeClass,
    };
  }
  if (Object.keys(profiles).length === 0) {
    throw new Error("database_cell_budget_profiles_empty");
  }
  return profiles;
}

export async function readImmutableAppSourceFile(
  appSourceDir: string,
  reviewedBuildSha: string,
  repoRelativePath: string
): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(reviewedBuildSha)) {
    throw new Error("database_cell_build_sha_invalid");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(repoRelativePath)) {
    throw new Error("database_cell_source_path_invalid");
  }
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: appSourceDir,
    encoding: "utf8",
  });
  if (head.trim() !== reviewedBuildSha) {
    throw new Error("database_cell_build_sha_mismatch");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${reviewedBuildSha}:${repoRelativePath}`],
    { cwd: appSourceDir, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout;
}

function parseBillingCurrency(value: string): "EUR" | "USD" {
  if (value !== "EUR" && value !== "USD") {
    throw new Error("database_cell_billing_currency_invalid");
  }
  return value;
}

const invokedPath = process.argv[1];
// An imported module may become the bundler entry and therefore also match
// argv[1]. Require an explicit ops mode so actuator bundles never execute CLI.
// biome-ignore lint/style/noProcessEnv: explicit executable mode boundary
const lifecycleCliEnabled = process.env.DATABASE_CELL_LIFECYCLE_CLI === "1";
if (
  lifecycleCliEnabled &&
  invokedPath &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  // CLI composition root: environment injection happens once at the boundary.
  // biome-ignore lint/style/noProcessEnv: explicit executable configuration boundary
  await runDatabaseCellLifecycleCli(process.env);
}

/** Complete production composition; every privileged dependency is mandatory. */
export function createProductionDatabaseContainmentAdapter(
  config: ProductionDatabaseContainmentConfig
) {
  if (
    !config.adminDsn ||
    !config.log ||
    !config.loki ||
    !config.lokiEnvironment
  ) {
    throw new Error("database_containment_production_config_invalid");
  }
  return createPostgresDatabaseContainmentAdapter({
    sql: new PostgresAdminSqlAdapter(config.adminDsn),
    audit: new PinoLokiDatabaseContainmentAuditAdapter(
      config.log,
      config.loki,
      config.lokiEnvironment
    ),
    ...(config.firewallStatus ? { fenceStatus: config.firewallStatus } : {}),
    ...(config.cells ? { cells: config.cells } : {}),
  });
}

export interface ProductionDatabaseReadmissionConfig {
  readonly readmitDsn: string;
  readonly status: DatabaseContainmentStatusPort;
  readonly log: Logger;
}

/** Isolated human-command composition; has no contain DSN or sweep capability. */
export function createProductionDatabaseReadmissionAdapter(
  config: ProductionDatabaseReadmissionConfig
) {
  if (!config.readmitDsn || !config.status || !config.log) {
    throw new Error("database_readmission_production_config_invalid");
  }
  return createPostgresDatabaseReadmissionAdapter({
    readmitSql: new PostgresReadmitSqlAdapter(config.readmitDsn),
    status: config.status,
    audit: new PinoDatabaseContainmentAuditWriter(config.log),
  });
}

/** Privileged SQL executor. The injected DSN remains closure-private. */
export class PostgresAdminSqlAdapter implements DatabaseControlSql {
  private readonly client: Sql;

  constructor(adminDsn: string) {
    const url = new URL(adminDsn);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error("database_control_dsn_invalid");
    }
    if (
      decodeURIComponent(url.username) !== "database_reliability_actuator" ||
      url.pathname !== "/postgres"
    ) {
      throw new Error("database_control_dsn_not_least_privilege");
    }
    this.client = postgres(adminDsn, { max: 1, prepare: false });
  }

  async query<T extends Record<string, unknown>>(
    statement: string,
    params: readonly unknown[] = []
  ): Promise<readonly T[]> {
    return this.client.unsafe<T[]>(statement, [...params] as never[]);
  }
}

/** Separate DB-bound identity: it can only EXECUTE the guarded LOGIN function. */
export class PostgresReadmitSqlAdapter implements DatabaseControlSql {
  private readonly client: Sql;

  constructor(readmitDsn: string) {
    const url = new URL(readmitDsn);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error("database_readmit_dsn_invalid");
    }
    if (
      decodeURIComponent(url.username) !== "database_reliability_readmitter" ||
      url.pathname !== "/postgres"
    ) {
      throw new Error("database_readmit_dsn_not_least_privilege");
    }
    this.client = postgres(readmitDsn, { max: 1, prepare: false });
  }

  async query<T extends Record<string, unknown>>(
    statement: string,
    params: readonly unknown[] = []
  ): Promise<readonly T[]> {
    return this.client.unsafe<T[]>(statement, [...params] as never[]);
  }
}

/** Pino is the durable write path (stdout -> Alloy -> Loki). */
export class PinoDatabaseContainmentAuditWriter
  implements DatabaseContainmentAuditWriter
{
  constructor(private readonly log: Logger) {}

  async append(event: DatabaseContainmentAuditEvent): Promise<void> {
    this.log.info(
      { event: EVENT_NAMES.NODE_RELIABILITY_TRANSITION, ...event },
      EVENT_NAMES.NODE_RELIABILITY_TRANSITION
    );
  }
}

/** Closed component identities permitted to emit durable containment transitions. */
export const DATABASE_CONTAINMENT_AUDIT_SERVICES = [
  "database-reliability-actuator",
  "database-reliability-readmitter",
] as const;

/** Sweep/status composition adds Loki readback; readmission never receives it. */
export class PinoLokiDatabaseContainmentAuditAdapter extends PinoDatabaseContainmentAuditWriter {
  constructor(
    log: Logger,
    private readonly loki: LokiReaderPort,
    private readonly lokiEnvironment: string
  ) {
    super(log);
  }

  async latest(input: {
    readonly nodeId: string;
    readonly environment: DatabaseContainmentAuditEvent["environment"];
  }): Promise<DatabaseContainmentAuditEvent | null> {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const serviceSelector =
      DATABASE_CONTAINMENT_AUDIT_SERVICES.map(escapeLogQl).join("|");
    const rows = await this.loki.queryRange({
      query: `{env="${escapeLogQl(this.lokiEnvironment)}",service=~"${serviceSelector}"} | json | event="${EVENT_NAMES.NODE_RELIABILITY_TRANSITION}" | nodeId="${escapeLogQl(input.nodeId)}" | environment="${escapeLogQl(input.environment)}"`,
      startNs: String(nowNs - 30n * 24n * 60n * 60n * 1_000_000_000n),
      endNs: String(nowNs),
      limit: 1,
    });
    if (!rows[0]) return null;
    const parsed = JSON.parse(rows[0].line) as DatabaseContainmentAuditEvent;
    return parsed.incidentId && parsed.occurredAt ? parsed : null;
  }
}

export interface CherryFenceBinding {
  readonly ruleId: string;
  readonly sourceCidr: string;
}

export interface CherryHostFirewallRuleClient {
  getRule(input: { readonly ruleId: string }): Promise<{
    readonly ruleId: string;
    readonly sourceCidr: string;
    readonly enabled: boolean;
  } | null>;
  setRuleEnabled(input: {
    readonly ruleId: string;
    readonly expectedSourceCidr: string;
    readonly enabled: boolean;
  }): Promise<void>;
}

/** Mutates only one catalog-declared source-CIDR rule on a Cherry host. */
export class CherryDatabaseSourceFenceAdapter implements DatabaseSourceFence {
  constructor(
    private readonly config: {
      readonly firewallRules: CherryHostFirewallRuleClient;
      readonly resolveBindings: (input: {
        nodeSlug: string;
        environment: DatabaseContainmentAuditEvent["environment"];
      }) => Promise<readonly CherryFenceBinding[]>;
    }
  ) {
    if (!config.firewallRules || !config.resolveBindings) {
      throw new Error("cherry_database_fence_config_invalid");
    }
  }

  async isFenced(
    input: Parameters<DatabaseSourceFence["isFenced"]>[0]
  ): Promise<boolean> {
    const binding = await this.binding(input);
    const rule = await this.config.firewallRules.getRule({
      ruleId: binding.ruleId,
    });
    if (!rule || rule.sourceCidr !== binding.sourceCidr) {
      throw new Error("cherry_database_fence_rule_identity_mismatch");
    }
    return !rule.enabled;
  }

  async setFenced(
    input: Parameters<DatabaseSourceFence["setFenced"]>[0]
  ): Promise<void> {
    const binding = await this.binding(input);
    const rule = await this.config.firewallRules.getRule({
      ruleId: binding.ruleId,
    });
    if (!rule || rule.sourceCidr !== binding.sourceCidr) {
      throw new Error("cherry_database_fence_rule_identity_mismatch");
    }
    await this.config.firewallRules.setRuleEnabled({
      ruleId: binding.ruleId,
      expectedSourceCidr: binding.sourceCidr,
      enabled: !input.fenced,
    });
  }

  private async binding(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseContainmentAuditEvent["environment"];
  }): Promise<CherryFenceBinding> {
    const bindings = await this.config.resolveBindings(input);
    if (bindings.length !== 1) {
      throw new Error("cherry_database_fence_binding_not_unique");
    }
    const binding = bindings[0];
    if (!binding || !binding.ruleId || !isIpv4Cidr(binding.sourceCidr)) {
      throw new Error("cherry_database_fence_binding_invalid");
    }
    return binding;
  }
}

function isIpv4Cidr(value: string): boolean {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(value);
  return Boolean(match?.[1]?.split(".").every((octet) => Number(octet) <= 255));
}

function escapeLogQl(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

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
