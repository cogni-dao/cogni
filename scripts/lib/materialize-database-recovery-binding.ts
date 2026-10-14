// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/materialize-database-recovery-binding`
 * Purpose: Validate measured private probe identity and merge its canonical binding for the sole secret materializer.
 * Scope: Pure binding validation plus a stdin/stdout CLI; does not query databases, operate providers, or write secret stores.
 * Invariants: Native and local cluster identifiers agree; DSN and node identity match; existing physical bindings cannot silently change.
 * Side-effects: IO (CLI reads stdin and writes stdout or a safe validation error)
 * Links: docs/spec/secrets-management.md, scripts/ci/secret-materialize.sh
 * @internal
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const bindingSchema = z
  .object({
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment: z.enum(["candidate-a", "preview", "production"]),
    databaseName: z.string(),
    probeRole: z.string(),
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    substrateHost: z.string().regex(/^[0-9a-f]{32}$/),
    dsn: z.string(),
  })
  .strict();
const observationSchema = z
  .object({
    database: z.string(),
    role: z.string(),
    systemTenantExists: z.boolean(),
    serverAddress: z.string(),
    serverPort: z.number().int(),
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    appRolesCanLogin: z.boolean(),
    runtimeRolesPresent: z.literal(true),
    runtimeRolesNoLogin: z.boolean(),
    activeRuntimeSessions: z.number().int().nonnegative(),
    observedAt: z.string().datetime({ offset: true }),
    probeRoleIsolated: z.literal(true),
  })
  .strict();
const inputSchema = z
  .object({
    nodeId: bindingSchema.shape.nodeId,
    nodeSlug: bindingSchema.shape.nodeSlug,
    environment: bindingSchema.shape.environment,
    databaseName: z.string(),
    probeRole: z.string(),
    dsn: z.string(),
    expectedHost: z.string(),
    machineId: bindingSchema.shape.substrateHost,
    localSystemIdentifier: bindingSchema.shape.systemIdentifier,
    observation: observationSchema,
    existingBindings: z.array(bindingSchema),
  })
  .strict();

export function sealRecoveryBinding(
  raw: unknown
): z.infer<typeof bindingSchema>[] {
  const input = inputSchema.parse(raw);
  const suffix = input.databaseName.slice("cogni_".length);
  const base = `cogni_${input.nodeSlug.replaceAll("-", "_")}`;
  if (
    ![base, `${base}_${input.environment.replaceAll("-", "_")}`].includes(
      input.databaseName
    ) ||
    input.probeRole !== `probe_${suffix}`
  )
    throw new Error("canonical node database/role mismatch");
  const dsn = new URL(input.dsn);
  if (
    dsn.protocol !== "postgresql:" ||
    decodeURIComponent(dsn.username) !== input.probeRole ||
    decodeURIComponent(dsn.pathname.slice(1)) !== input.databaseName ||
    dsn.port !== "5432" ||
    dsn.hostname !== input.expectedHost ||
    !dsn.password ||
    [...dsn.searchParams].some(
      ([key, value]) => key !== "sslmode" || value !== "disable"
    )
  ) {
    throw new Error("probe DSN does not match canonical local residency");
  }
  const observed = input.observation;
  if (
    observed.systemIdentifier !== input.localSystemIdentifier ||
    observed.database !== input.databaseName ||
    observed.role !== input.probeRole ||
    observed.serverPort !== 5432
  ) {
    throw new Error("native probe receipt identity mismatch");
  }
  const seen = new Set<string>();
  for (const binding of input.existingBindings) {
    const key = `${binding.nodeId}/${binding.environment}`;
    if (seen.has(key)) throw new Error("duplicate existing probe binding");
    seen.add(key);
  }
  const prior = input.existingBindings.find(
    (b) => b.nodeId === input.nodeId && b.environment === input.environment
  );
  if (
    prior &&
    (prior.substrateHost !== input.machineId ||
      prior.systemIdentifier !== observed.systemIdentifier ||
      new URL(prior.dsn).hostname !== input.expectedHost ||
      prior.databaseName !== input.databaseName ||
      prior.probeRole !== input.probeRole ||
      prior.nodeSlug !== input.nodeSlug)
  ) {
    throw new Error(
      "existing binding physical identity changed without an applied placement receipt"
    );
  }
  const next = bindingSchema.parse({
    nodeId: input.nodeId,
    nodeSlug: input.nodeSlug,
    environment: input.environment,
    databaseName: input.databaseName,
    probeRole: input.probeRole,
    dsn: input.dsn,
    systemIdentifier: observed.systemIdentifier,
    substrateHost: input.machineId,
  });
  return [
    ...input.existingBindings.filter(
      (b) => b.nodeId !== input.nodeId || b.environment !== input.environment
    ),
    next,
  ].sort((a, b) =>
    `${a.nodeId}/${a.environment}`.localeCompare(`${b.nodeId}/${b.environment}`)
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      JSON.stringify(sealRecoveryBinding(JSON.parse(readFileSync(0, "utf8"))))
    );
  } catch {
    process.stderr.write("recovery binding receipt rejected\n");
    process.exitCode = 1;
  }
}
