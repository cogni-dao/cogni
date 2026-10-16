// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/run-node-substrate`
 * Purpose: Route day-2 substrate readiness to the workload's database placement.
 * Scope: Verify admitted manual cells and delegate shared lanes. Does not provision new cells or mutate native roles.
 * Invariants: No shared Postgres provisioner or native mutation for an admitted dedicated target; initial admission stays immutable.
 * Side-effects: IO (existing canonical writer, SSH/Kubernetes reads, idempotent ESO refresh, bounded read-only PostgreSQL transactions).
 * Links: docs/spec/databases.md, scripts/ci/run-node-substrate.sh, scripts/lib/materialize-database-cell-placement.ts
 * @internal
 */
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parse } from "yaml";
import { z } from "zod";
import { DatabaseCellAppliedCustodySchema } from "../../nodes/operator/app/src/shared/secrets/database-cell-binding.data";
import { AppliedDatabaseCellReceiptSchema } from "../../nodes/operator/app/src/shared/secrets/database-cell-placement.data";
import { projectDatabaseCellPlacement } from "./materialize-database-cell-placement";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const bankSchema = z.record(z.string(), z.string());
const hash = (value: string | undefined) => {
  if (!value) throw new Error("dedicated_cell_receipt_missing");
  return createHash("sha256").update(value).digest("hex");
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function dedicatedLane(catalog: unknown, lane: string): boolean {
  const row = z
    .object({
      database: z
        .record(z.string(), z.object({ tier: z.enum(["shared", "dedicated"]) }))
        .optional(),
    })
    .parse(catalog);
  return row.database?.[lane]?.tier === "dedicated";
}

export function validateDedicatedCustody(input: {
  node: string;
  nodeId: string;
  cell: Record<string, string>;
  app: Record<string, string>;
  migration: Record<string, string>;
  pools: unknown;
}) {
  const receipt = AppliedDatabaseCellReceiptSchema.parse(
    JSON.parse(input.cell.DATABASE_CELL_PLACEMENT_RECEIPT_JSON ?? "null")
  );
  const custody = DatabaseCellAppliedCustodySchema.parse(
    JSON.parse(input.cell.DATABASE_CELL_APPLIED_CUSTODY_JSON ?? "null")
  );
  const pools = z
    .object({
      replicaCount: z.literal(1),
      app: z.number().int().positive(),
      service: z.number().int().positive(),
      read: z.number().int().positive(),
    })
    .parse(input.pools);
  if (
    receipt.registration?.kind !== "audited-manual" ||
    receipt.binding.nodeId !== input.nodeId ||
    receipt.binding.nodeSlug !== input.node ||
    !custody.readOnlyProbe ||
    Object.entries(pools).some(
      ([key, value]) =>
        receipt.registration?.runtimePoolLimits?.[key as keyof typeof pools] !==
        value
    )
  )
    throw new Error("dedicated_cell_owner_or_runtime_policy_mismatch");
  const projection = projectDatabaseCellPlacement({
    receipt,
    custody,
    requireApplied: false,
  });
  if (
    !projection.publicValues ||
    input.app.DATABASE_URL !== projection.publicValues.DATABASE_URL ||
    input.app.DATABASE_SERVICE_URL !==
      projection.publicValues.DATABASE_SERVICE_URL ||
    input.migration.DATABASE_MIGRATION_URL !==
      projection.publicValues.DATABASE_MIGRATION_URL
  )
    throw new Error("dedicated_cell_consumer_custody_mismatch");
  return { receipt, custody, probeDsn: custody.readOnlyProbe.dsn };
}

function command(
  bin: string,
  args: string[],
  options: {
    input?: string | undefined;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {}
): string {
  const result = spawnSync(bin, args, {
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    stdio: options.capture
      ? "pipe"
      : [
          options.input === undefined ? "inherit" : "pipe",
          "inherit",
          "inherit",
        ],
    timeout: options.timeout ?? 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // Captured transport/SDK output can contain credentials; never forward it.
  if (result.error || result.status !== 0)
    throw new Error(
      `substrate_command_failed:${bin}:${result.status ?? "transport"}`
    );
  return result.stdout ?? "";
}

async function run(lane: string, node: string, verifyOnly: boolean) {
  if (
    !["production", "preview", "candidate-a"].includes(lane) ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(node)
  )
    throw new Error("invalid_substrate_target");
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const appRoot = path.resolve(workspace, process.env.APP_SOURCE_DIR ?? ".");
  const catalogRoot = path.resolve(
    workspace,
    process.env.COGNI_CATALOG_ROOT ?? path.join(appRoot, "infra/catalog")
  );
  const catalog = parse(
    readFileSync(path.join(catalogRoot, `${node}.yaml`), "utf8")
  );
  const env = {
    ...process.env,
    APP_SOURCE_DIR: appRoot,
    COGNI_CATALOG_ROOT: catalogRoot,
    DEPLOY_ENVIRONMENT: lane,
    TARGET: node,
  };
  const legacy = path.join(root, "scripts/ci/run-node-substrate.sh");
  if (!dedicatedLane(catalog, lane)) {
    if (verifyOnly) throw new Error("verify_only_requires_dedicated_lane");
    command("bash", [legacy, lane, node], { env, timeout: 1_200_000 });
    return;
  }
  // This path is for existing audited state cells, never generation-zero provisioning.
  if (
    lane !== "production" ||
    catalog.deployment_provider?.[lane] !== "akash" ||
    !catalog.envs?.includes(lane)
  )
    throw new Error("dedicated_cell_lane_not_supported");
  if (!verifyOnly)
    command(
      "bash",
      [path.join(root, "scripts/ci/secret-materialize.sh"), lane, node],
      { env }
    );
  const host = process.env.VM_HOST;
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host))
    throw new Error("substrate_vm_host_required");
  const sshOptions = (
    process.env.SSH_OPTS ??
    `-i ${process.env.HOME}/.ssh/deploy_key -o BatchMode=yes -o ConnectTimeout=10`
  )
    .trim()
    .split(/\s+/);
  const remote = (args: string[], input?: string) =>
    command("ssh", [...sshOptions, `root@${host}`, args.map(quote).join(" ")], {
      capture: true,
      input,
      timeout: 45_000,
    });
  const kubectl = (args: string[], input?: string) =>
    remote(["kubectl", "--request-timeout=20s", ...args], input);
  const jwt = kubectl([
    "create",
    "token",
    "db-provisioner",
    "-n",
    "default",
  ]).trim();
  const token = kubectl(
    [
      "exec",
      "-i",
      "-n",
      "openbao",
      "openbao-0",
      "--",
      "env",
      "BAO_ADDR=http://127.0.0.1:8200",
      "bao",
      "write",
      "-field=token",
      "auth/kubernetes/login",
      "role=production-db-reader",
      "jwt=-",
    ],
    jwt
  ).trim();
  if (!token) throw new Error("substrate_reader_login_failed");
  const readBank = (service: string) => {
    const json = kubectl(
      [
        "exec",
        "-i",
        "-n",
        "openbao",
        "openbao-0",
        "--",
        "sh",
        "-c",
        'IFS= read -r BAO_TOKEN; export BAO_TOKEN BAO_ADDR=http://127.0.0.1:8200; exec bao kv get -format=json "$1"',
        "reader",
        `cogni/production/${service}`,
      ],
      `${token}\n`
    );
    return bankSchema.parse(JSON.parse(json).data.data);
  };
  const cell = readBank(`${node}-database-cell`),
    app = readBank(node),
    migration = readBank(`${node}-database-migration`);
  const { receipt, custody, probeDsn } = validateDedicatedCustody({
    node,
    nodeId: catalog.node_id,
    cell,
    app,
    migration,
    pools: catalog.database.production.runtimePoolLimits,
  });
  const ns = "cogni-production";
  const names = [
    `${node}-env-secrets`,
    `${node}-compute-env-secrets`,
    `${node}-migration-secrets`,
    `${node}-compute-migration-secrets`,
  ];
  if (!verifyOnly)
    kubectl([
      "-n",
      ns,
      "annotate",
      "externalsecret",
      ...names,
      `force-sync=${Date.now()}`,
      "--overwrite",
    ]);
  for (const name of names) {
    if (!verifyOnly)
      kubectl([
        "-n",
        ns,
        "wait",
        "--for=condition=Ready",
        `externalsecret/${name}`,
        "--timeout=90s",
      ]);
    const secret = JSON.parse(
      kubectl(["-n", ns, "get", "secret", name, "-o", "json"])
    );
    const values = Object.fromEntries(
      Object.entries(secret.data ?? {}).map(([key, value]) => [
        key,
        Buffer.from(String(value), "base64").toString("utf8"),
      ])
    );
    const expected = name.endsWith("env-secrets")
      ? {
          DATABASE_URL: app.DATABASE_URL,
          DATABASE_SERVICE_URL: app.DATABASE_SERVICE_URL,
          DATABASE_SSL_CA_CERT:
            name === `${node}-compute-env-secrets`
              ? JSON.stringify(app.DATABASE_SSL_CA_CERT).slice(1, -1)
              : app.DATABASE_SSL_CA_CERT,
        }
      : {
          DATABASE_MIGRATION_URL: migration.DATABASE_MIGRATION_URL,
          ...(name === `${node}-compute-migration-secrets`
            ? { DATABASE_SSL_CA_CERT: migration.DATABASE_SSL_CA_CERT }
            : {}),
        };
    if (Object.entries(expected).some(([key, value]) => values[key] !== value))
      throw new Error("dedicated_cell_projected_secret_mismatch");
  }
  const certificate = new X509Certificate(custody.tlsCertificate);
  const expectedCertificate = createHash("sha256")
    .update(certificate.raw)
    .digest("hex");
  const connect = (dsn: string) => {
    const url = new URL(dsn);
    return postgres({
      host: url.hostname,
      port: Number(url.port),
      database: decodeURIComponent(url.pathname.slice(1)),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      max: 1,
      connect_timeout: 8,
      idle_timeout: 1,
      prepare: false,
      connection: {
        application_name: "cogni_dedicated_substrate_preflight",
      },
      ssl: {
        rejectUnauthorized: true,
        servername: url.hostname,
        ...(custody.tls.kind === "private-ca"
          ? { ca: custody.tls.caCertificate }
          : {}),
        checkServerIdentity: (_hostname: string, cert: PeerCertificate) =>
          checkServerIdentity(url.hostname, cert) ??
          (createHash("sha256").update(cert.raw).digest("hex") ===
          expectedCertificate
            ? undefined
            : new Error("dedicated_cell_tls_leaf_mismatch")),
      },
    });
  };
  const probe = connect(probeDsn);
  try {
    const rows = await probe.begin(
      "read only",
      (tx) =>
        tx`SELECT current_database() AS database, session_user AS role, (SELECT system_identifier::text FROM pg_control_system()) AS identity, current_setting('transaction_read_only') AS readonly, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls`
    );
    const observed = rows[0];
    if (
      observed?.identity !== receipt.binding.systemIdentifier ||
      observed.database !== custody.databaseName ||
      observed.role !== decodeURIComponent(new URL(probeDsn).username) ||
      observed.readonly !== "on" ||
      observed.tls !== true
    )
      throw new Error("dedicated_cell_native_identity_mismatch");
  } finally {
    await probe.end({ timeout: 1 });
  }
  for (const [dsn, role] of [
    [custody.app.dsn, custody.appRole],
    [custody.service.dsn, custody.serviceRole],
  ] as const) {
    const sql = connect(dsn);
    try {
      const rows = await sql.begin(
        "read only",
        (tx) =>
          tx`SELECT session_user AS name, (SELECT rolcanlogin FROM pg_roles WHERE rolname=session_user) AS login, (SELECT rolconnlimit FROM pg_roles WHERE rolname=session_user) AS limit, (current_setting('default_transaction_read_only')='on') AS readonly,
          (SELECT setting::numeric FROM pg_settings WHERE name='statement_timeout') AS statement_timeout,
          (SELECT setting::numeric FROM pg_settings WHERE name='lock_timeout') AS lock_timeout,
          (SELECT setting::numeric FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle_timeout,
          (SELECT setting::numeric/1024 FROM pg_settings WHERE name='temp_file_limit') AS temp_limit,
          (SELECT setting::numeric/1024 FROM pg_settings WHERE name='work_mem') AS work_mem`
      );
      const bound = custody.budget.roles.find((item) => item.name === role),
        observed = rows[0];
      // BEGIN READ ONLY preserves the role defaults we actually measure here.
      if (
        !bound ||
        observed?.name !== role ||
        observed.login !== true ||
        observed.limit !== bound.connectionLimit ||
        observed.readonly !== false ||
        Number(observed.statement_timeout) !== bound.statementTimeoutMs ||
        Number(observed.lock_timeout) !== bound.lockTimeoutMs ||
        Number(observed.idle_timeout) !== bound.idleInTransactionTimeoutMs ||
        Number(observed.temp_limit) !== bound.tempFileLimitMiB ||
        Number(observed.work_mem) !== bound.workMemMiB
      )
        throw new Error("dedicated_cell_native_role_bounds_mismatch");
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  if (!verifyOnly) {
    command(
      "bash",
      [path.join(root, "scripts/ci/assert-target-substrate.sh"), lane, node],
      { env: { ...env, DEPLOYMENT_PROVIDER: "akash" } }
    );
    // Sibling provisioning retains the established runner and down-trust custody.
    // A sibling failure remains visible without invalidating a healthy target lane.
    for (const sibling of catalog.envs.filter(
      (value: string) => value !== lane
    )) {
      const domain = `${sibling === "candidate-a" ? "test" : sibling}.${process.env.DOMAIN}`;
      try {
        command("bash", [legacy, sibling, node], {
          env: { ...env, DOMAIN: domain, DEPLOYMENT_PROVIDER: "akash" },
          timeout: 600_000,
        });
      } catch {
        console.error(
          `::warning::substrate sibling degraded: ${sibling}/${node}`
        );
      }
    }
  }
  console.log(
    JSON.stringify({
      event: "dedicated_cell_substrate_verified",
      nodeId: catalog.node_id,
      environment: lane,
      systemIdentifier: receipt.binding.systemIdentifier,
      receiptSha256: hash(cell.DATABASE_CELL_PLACEMENT_RECEIPT_JSON),
      sharedPostgresProvisioned: false,
      nativeMutations: false,
    })
  );
}

if (process.argv[1]?.endsWith("run-node-substrate.ts")) {
  run(
    process.argv[2] ?? "",
    process.argv[3] ?? "",
    process.argv.includes("--verify-only")
  ).catch((error: unknown) => {
    // Stable allowlisted diagnostics only; SDK/transport errors can contain DSNs.
    const message =
      error instanceof Error &&
      /^(dedicated_cell_|invalid_substrate_|substrate_|verify_only_)/.test(
        error.message
      )
        ? error.message
        : "substrate_preflight_failed";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
