// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import postgres, { type Sql } from "postgres";
import type {
  DatabaseCellActionReceipt,
  DatabaseCellStatus,
  DatabaseContainmentStatusPort,
  DatabaseStateCellPort,
  LokiReaderPort,
  ProvisionDatabaseCellInput,
} from "@/ports";
import {
  CherryDatabaseCellAdapter,
  type CherryDatabaseCellConfig,
  type CherryDatabaseCellVerifier,
  PostgresCherryDatabaseCellProvisionLease,
} from "../compute/cherry-database-cell.adapter";
import type {
  DatabaseContainmentAuditEvent,
  DatabaseContainmentAuditWriter,
  DatabaseControlSql,
  DatabaseSourceFence,
  DatabaseSourceFenceStatus,
} from "./postgres-database-containment.adapter";
import {
  createPostgresDatabaseContainmentAdapter,
  createPostgresDatabaseReadmissionAdapter,
  type PostgresDatabaseContainmentDeps,
} from "./postgres-database-containment.adapter";

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
  const adapter = createProductionCherryDatabaseCellAdapter({
    authToken: requireEnvironment(environment, "CHERRY_AUTH_TOKEN"),
    projectId: requireEnvironment(environment, "CHERRY_PROJECT_ID"),
    timeoutMs: positiveInteger(environment.CHERRY_TIMEOUT_MS ?? "30000"),
    region: requireEnvironment(environment, "CHERRY_DATABASE_REGION"),
    plan: requireEnvironment(environment, "CHERRY_DATABASE_PLAN"),
    image: requireEnvironment(environment, "CHERRY_DATABASE_IMAGE"),
    storagePlanId: positiveInteger(
      requireEnvironment(environment, "CHERRY_DATABASE_STORAGE_PLAN_ID")
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
      { event: "database_containment_transition", ...event },
      "database_containment_transition"
    );
  }
}

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
    const rows = await this.loki.queryRange({
      query: `{env="${escapeLogQl(this.lokiEnvironment)}",service="operator"} | json | event="database_containment_transition" | nodeId="${escapeLogQl(input.nodeId)}" | environment="${escapeLogQl(input.environment)}"`,
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
