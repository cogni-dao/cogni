// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/materialize-database-cell-kits`
 * Purpose: Mint catalog-selected private cell bootstrap kits while preserving existing scoped credentials.
 * Scope: Validates stdin and emits private JSON to the sole materializer; does not allocate or publish secrets.
 * Invariants: No provider allocation, public projection, secret writer, or readiness/cutover authority.
 * Side-effects: IO (stdin/stdout; bounded openssl generation in an erased private temporary directory).
 * Links: docs/spec/secrets-management.md, nodes/operator/app/src/shared/secrets/database-cell-binding.data.ts
 * @internal
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  type DatabaseCellBootstrapKit,
  DatabaseCellBootstrapKitSchema,
  DatabaseCellBootstrapKitsSchema,
  DatabaseCellBudgetSchema,
} from "../../nodes/operator/app/src/shared/secrets/database-cell-binding.data";

const environment = z.enum(["candidate-a", "preview", "production"]);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const PlanSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment,
    sourceSha: sha,
    logicalDatabases: z
      .array(
        z
          .object({
            environment,
            databaseName: z.string().regex(/^cogni_[a-z0-9_]+$/),
            appRole: z.string(),
            serviceRole: z.string(),
            migrationRole: z.string(),
            probeRole: z.string(),
            backupRole: z.string(),
            sourceSha: sha,
            budgetProfile: z.enum([
              "shared-default-v1",
              "dedicated-high-throughput-v1",
            ]),
            budget: DatabaseCellBudgetSchema,
          })
          .strict()
      )
      .min(1)
      .max(3),
  })
  .strict();
const AuthoritySchema = z
  .object({
    nodeId: z.string().uuid(),
    environment,
    tlsCaCertificate: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
    tlsCaPrivateKey: z.string().regex(/^-----BEGIN (RSA )?PRIVATE KEY-----/),
  })
  .strict();
const SourceSlotSchema = z
  .object({
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment,
    physicalEnvironment: environment,
    sourceSha: sha,
    appDsn: z.string().url(),
    serviceDsn: z.string().url(),
    budgetProfile: z.enum([
      "shared-default-v1",
      "dedicated-high-throughput-v1",
    ]),
    budget: DatabaseCellBudgetSchema,
  })
  .strict();
export function planDatabaseCellKits(input: unknown) {
  const value = z
    .object({
      operatorSourceSha: sha,
      environment,
      expectedSourceHost: z.string().min(1),
      nativeSource: z
        .object({
          systemIdentifier: z.string().regex(/^[0-9]+$/),
          databases: z.array(z.string()),
          roles: z.array(z.string()),
        })
        .strict(),
      slots: z.array(SourceSlotSchema),
    })
    .strict()
    .parse(input);
  const grouped = new Map<string, z.infer<typeof PlanSchema>>();
  for (const slot of value.slots) {
    if (slot.physicalEnvironment !== value.environment)
      throw new Error("cell source is not locally owned");
    const app = new URL(slot.appDsn),
      service = new URL(slot.serviceDsn);
    const db = decodeURIComponent(app.pathname.slice(1)),
      appRole = decodeURIComponent(app.username),
      serviceRole = decodeURIComponent(service.username);
    if (
      !["postgres:", "postgresql:"].includes(app.protocol) ||
      !["postgres:", "postgresql:"].includes(service.protocol) ||
      app.hostname !== value.expectedSourceHost ||
      service.hostname !== app.hostname ||
      (app.port || "5432") !== "5432" ||
      (service.port || "5432") !== "5432" ||
      service.pathname !== app.pathname
    )
      throw new Error("source DSNs disagree with observed local residency");
    const suffix = db.slice("cogni_".length);
    if (
      !value.nativeSource.databases.includes(db) ||
      !value.nativeSource.roles.includes(appRole) ||
      !value.nativeSource.roles.includes(serviceRole) ||
      appRole !== `app_${suffix}` ||
      serviceRole !== `service_${suffix}`
    )
      throw new Error("source native database/role identity differs");
    const identity = `${slot.nodeId}/${slot.physicalEnvironment}`;
    let plan = grouped.get(identity);
    if (!plan) {
      plan = {
        version: 1,
        nodeId: slot.nodeId,
        nodeSlug: slot.nodeSlug,
        environment: slot.physicalEnvironment,
        sourceSha: value.operatorSourceSha,
        logicalDatabases: [],
      };
      grouped.set(identity, plan);
    }
    if (plan.nodeSlug !== slot.nodeSlug)
      throw new Error("source node identity differs");
    if (plan.logicalDatabases.some((lane) => lane.databaseName === db))
      throw new Error(
        "source database aliases need an explicit canonical alias receipt"
      );
    plan.logicalDatabases.push({
      environment: slot.environment,
      databaseName: db,
      appRole,
      serviceRole,
      migrationRole: `migration_${suffix}`,
      probeRole: `probe_${suffix}`,
      backupRole: `backup_${suffix}`,
      sourceSha: slot.sourceSha,
      budgetProfile: slot.budgetProfile,
      budget: slot.budget,
    });
  }
  return z.array(PlanSchema).parse([...grouped.values()]);
}

const InputSchema = z
  .object({
    plans: z.array(PlanSchema),
    existingKits: DatabaseCellBootstrapKitsSchema,
    existingPublished: DatabaseCellBootstrapKitsSchema,
    existingAuthorities: z.array(AuthoritySchema),
  })
  .strict();

function certificate(nodeId: string) {
  const directory = mkdtempSync(join(tmpdir(), "cogni-cell-tls-"));
  try {
    const caKey = join(directory, "ca.key"),
      caCert = join(directory, "ca.crt");
    const key = join(directory, "server.key"),
      request = join(directory, "server.csr"),
      cert = join(directory, "server.crt");
    const run = (args: string[]) =>
      execFileSync("openssl", args, { stdio: "ignore" });
    run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "3650",
      "-subj",
      `/CN=cogni-cell-ca-${nodeId}`,
      "-keyout",
      caKey,
      "-out",
      caCert,
    ]);
    run([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=cogni-cell-prestage-${nodeId}`,
      "-keyout",
      key,
      "-out",
      request,
    ]);
    run([
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "365",
      "-sha256",
      "-out",
      cert,
    ]);
    const tlsCaCertificate = readFileSync(caCert, "utf8").trim();
    return {
      tlsCaCertificate,
      tlsCaPrivateKey: readFileSync(caKey, "utf8").trim(),
      tlsCertificate: readFileSync(cert, "utf8") + tlsCaCertificate,
      tlsPrivateKey: readFileSync(key, "utf8").trim(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function materializeDatabaseCellKits(input: unknown): {
  nodeKits: DatabaseCellBootstrapKit[];
  published: DatabaseCellBootstrapKit[];
  authorities: z.infer<typeof AuthoritySchema>[];
} {
  const { plans, existingKits, existingPublished, existingAuthorities } =
    InputSchema.parse(input);
  const authorities: z.infer<typeof AuthoritySchema>[] = [];
  const identities = new Set<string>();
  const nodeKits = plans.map((plan) => {
    const identity = `${plan.nodeId}/${plan.environment}`;
    if (identities.has(identity))
      throw new Error("duplicate physical cell plan");
    identities.add(identity);
    const old = existingKits.find(
      (kit) =>
        kit.nodeId === plan.nodeId && kit.environment === plan.environment
    );
    if (old && old.nodeSlug !== plan.nodeSlug)
      throw new Error("existing cell kit identity differs");
    const authority = existingAuthorities.find(
      (value) =>
        value.nodeId === plan.nodeId && value.environment === plan.environment
    );
    if (Boolean(old) !== Boolean(authority))
      throw new Error("partial cell kit/CA custody is refused");
    if (old && authority && old.tlsCaCertificate !== authority.tlsCaCertificate)
      throw new Error("cell CA identity differs");
    const created = old ? undefined : certificate(plan.nodeId);
    authorities.push(
      AuthoritySchema.parse({
        nodeId: plan.nodeId,
        environment: plan.environment,
        tlsCaCertificate:
          authority?.tlsCaCertificate ?? created?.tlsCaCertificate,
        tlsCaPrivateKey: authority?.tlsCaPrivateKey ?? created?.tlsCaPrivateKey,
      })
    );
    const passwords = () => randomBytes(24).toString("hex");
    return DatabaseCellBootstrapKitSchema.parse({
      ...plan,
      rootPassword: old?.rootPassword ?? passwords(),
      actuatorPassword: old?.actuatorPassword ?? passwords(),
      readmitPassword: old?.readmitPassword ?? passwords(),
      ...(old
        ? {
            tlsCaCertificate: old.tlsCaCertificate,
            tlsCertificate: old.tlsCertificate,
            tlsPrivateKey: old.tlsPrivateKey,
          }
        : {
            tlsCaCertificate: created?.tlsCaCertificate,
            tlsCertificate: created?.tlsCertificate,
            tlsPrivateKey: created?.tlsPrivateKey,
          }),
      logicalDatabases: plan.logicalDatabases.map((lane) => {
        const previous = old?.logicalDatabases.find(
          (value) => value.environment === lane.environment
        );
        if (previous && previous.databaseName !== lane.databaseName)
          throw new Error("existing source-lane database identity differs");
        return {
          ...lane,
          appPassword: previous?.appPassword ?? passwords(),
          servicePassword: previous?.servicePassword ?? passwords(),
          migrationPassword: previous?.migrationPassword ?? passwords(),
          probePassword: previous?.probePassword ?? passwords(),
          backupPassword: previous?.backupPassword ?? passwords(),
        };
      }),
    });
  });
  // The owner is serialized by the existing platform leg; preserve untouched sibling kits.
  const published = [
    ...existingPublished.filter(
      (kit) => !identities.has(`${kit.nodeId}/${kit.environment}`)
    ),
    ...nodeKits,
  ].sort((a, b) =>
    `${a.nodeId}/${a.environment}`.localeCompare(`${b.nodeId}/${b.environment}`)
  );
  return {
    nodeKits,
    authorities,
    published: DatabaseCellBootstrapKitsSchema.parse(published),
  };
}

if (process.argv[1]?.endsWith("materialize-database-cell-kits.ts")) {
  try {
    process.stdout.write(
      JSON.stringify(
        (process.argv.includes("--plan")
          ? planDatabaseCellKits
          : materializeDatabaseCellKits)(JSON.parse(readFileSync(0, "utf8")))
      )
    );
  } catch {
    process.stderr.write(
      "cell kit generation refused invalid catalog/private identity\n"
    );
    process.exitCode = 1;
  }
}
